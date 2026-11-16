"""Convert a local docker-save archive to a validated single-platform OCI archive."""
from pathlib import Path, PurePosixPath
from hashlib import sha256
import gzip, io, json, shutil, tarfile, tempfile

LIMIT = 2 * 1024 * 1024 * 1024
OCI_MANIFEST = 'application/vnd.oci.image.manifest.v1+json'
OCI_CONFIG = 'application/vnd.oci.image.config.v1+json'
OCI_LAYER = 'application/vnd.oci.image.layer.v1.tar+gzip'
OCI_PLAIN_LAYER = 'application/vnd.oci.image.layer.v1.tar'

def require(ok, code):
    if not ok:
        raise ValueError(code)

def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()

def hash_file(path):
    h = sha256()
    with Path(path).open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()

def safe_name(name, directory=False):
    require(isinstance(name, str) and name and not name.startswith('/') and '\\' not in name and ':' not in name
            and not any(ord(c) < 32 or ord(c) == 127 for c in name), 'ARCHIVE_PATH')
    normalized = name.removesuffix('/') if directory else name
    require(str(PurePosixPath(normalized)) == normalized and '..' not in PurePosixPath(normalized).parts,
            'ARCHIVE_PATH')
    return normalized

def member(archive, name):
    safe_name(name)
    m = archive.getmember(name)
    require(m.isfile() and not m.issym() and not m.islnk(), 'ARCHIVE_REGULAR_REQUIRED')
    return m

def archive_entries(archive):
    members = archive.getmembers()
    names = [m.name for m in members]
    require(len(names) == len(set(names)), 'DUPLICATE_ARCHIVE_ENTRY')
    normalized = []
    for m in members:
        name = safe_name(m.name, directory=m.isdir()); normalized.append(name)
        if m.isdir():
            require(name in ('blobs', 'blobs/sha256'), 'ARCHIVE_DIRECTORY_INVALID')
        else:
            require(m.isfile() and not m.issym() and not m.islnk(), 'ARCHIVE_REGULAR_REQUIRED')
    require(len(normalized) == len(set(normalized)), 'DUPLICATE_ARCHIVE_ENTRY')
    return members

def data(archive, name, maximum=2 * 1024 * 1024):
    m = member(archive, name); require(m.size <= maximum, 'ARCHIVE_METADATA_TOO_LARGE')
    with archive.extractfile(m) as f:
        return f.read()

def descriptor(archive, d):
    require(isinstance(d, dict) and not d.get('urls') and isinstance(d.get('size'), int), 'DESCRIPTOR_INVALID')
    digest = d.get('digest', '')
    require(digest.startswith('sha256:') and len(digest) == 71 and all(c in '0123456789abcdef' for c in digest[7:]), 'DIGEST_INVALID')
    m = member(archive, 'blobs/sha256/' + digest[7:]); require(m.size == d['size'], 'DESCRIPTOR_SIZE')
    h = sha256()
    with archive.extractfile(m) as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    require('sha256:' + h.hexdigest() == digest, 'DESCRIPTOR_HASH')
    return m.name

def verify_archive(path):
    path = Path(path); require(path.stat().st_size < LIMIT, 'OCI_RELEASE_ASSET_TOO_LARGE')
    with tarfile.open(path, 'r:*') as archive:
        archive_entries(archive)
        require(json.loads(data(archive, 'oci-layout')) == {'imageLayoutVersion': '1.0.0'}, 'OCI_LAYOUT')
        index = json.loads(data(archive, 'index.json'))
        require(index.get('schemaVersion') == 2 and len(index.get('manifests', [])) == 1, 'SINGLE_IMAGE_REQUIRED')
        top = index['manifests'][0]; require(top.get('mediaType') == OCI_MANIFEST, 'OCI_MANIFEST_REQUIRED')
        manifest = json.loads(data(archive, descriptor(archive, top)))
        require(manifest.get('schemaVersion') == 2 and manifest.get('mediaType') == OCI_MANIFEST, 'MANIFEST_SCHEMA')
        require(manifest['config'].get('mediaType') == OCI_CONFIG, 'OCI_CONFIG_REQUIRED')
        config = json.loads(data(archive, descriptor(archive, manifest['config'])))
        require(config.get('architecture') == 'amd64' and config.get('os') == 'linux', 'LINUX_AMD64_REQUIRED')
        diff_ids = config.get('rootfs', {}).get('diff_ids', [])
        require(len(diff_ids) == len(manifest.get('layers', [])), 'ROOTFS_LAYER_COUNT')
        for d, expected_diff in zip(manifest['layers'], diff_ids):
            require(d.get('mediaType') in (OCI_LAYER, OCI_PLAIN_LAYER), 'OCI_LAYER_TYPE_INVALID')
            name = descriptor(archive, d); h = sha256()
            with archive.extractfile(name) as raw:
                if d['mediaType'] == OCI_LAYER:
                    with gzip.GzipFile(fileobj=raw) as layer:
                        for block in iter(lambda: layer.read(1024 * 1024), b''):
                            h.update(block)
                else:
                    for block in iter(lambda: raw.read(1024 * 1024), b''):
                        h.update(block)
            require('sha256:' + h.hexdigest() == expected_diff, 'ROOTFS_DIFF_ID')
        return {'manifestDigest': top['digest'], 'configDigest': manifest['config']['digest'],
                'layers': len(diff_ids), 'bytes': path.stat().st_size, 'archiveSha256': hash_file(path)}

def archive_summary(path):
    """Bounded public shape only: no layer/config content or link targets."""
    with tarfile.open(path, 'r:*') as archive:
        members = archive.getmembers(); sample = []
        for m in members[:12]:
            try:
                name = safe_name(m.name, directory=m.isdir())
                public = name in ('blobs', 'blobs/sha256', 'oci-layout', 'index.json', 'manifest.json', 'repositories') or (
                    name.startswith('blobs/sha256/') and len(name.removeprefix('blobs/sha256/')) == 64 and
                    all(c in '0123456789abcdef' for c in name.removeprefix('blobs/sha256/')))
            except ValueError:
                name, public = '', False
            sample.append({'name': name if public else '<unlisted-entry>', 'type': 'directory' if m.isdir() else 'file' if m.isfile() else 'unsupported'})
        media = []
        if 'index.json' in archive.getnames():
            try:
                for d in json.loads(data(archive, 'index.json')).get('manifests', [])[:8]:
                    value = d.get('mediaType')
                    media.append(value if value in (OCI_MANIFEST, 'application/vnd.oci.image.index.v1+json',
                        'application/vnd.docker.distribution.manifest.v2+json', 'application/vnd.docker.distribution.manifest.list.v2+json') else '<unsupported>')
            except (ValueError, KeyError, json.JSONDecodeError):
                media = ['<unreadable-index>']
        return {'entries': len(members), 'sample': sample, 'indexMediaTypes': media}

def convert(source, destination):
    source, destination = Path(source), Path(destination)
    require(not destination.exists(), 'OCI_OUTPUT_EXISTS')
    with tarfile.open(source, 'r:*') as archive:
        if 'oci-layout' in archive.getnames():
            record = verify_archive(source); shutil.copyfile(source, destination); return record
        rows = json.loads(data(archive, 'manifest.json'))
        require(isinstance(rows, list) and len(rows) == 1, 'SINGLE_DOCKER_IMAGE_REQUIRED')
        row = rows[0]; config_bytes = data(archive, row['Config']); config = json.loads(config_bytes)
        require(config.get('architecture') == 'amd64' and config.get('os') == 'linux', 'LINUX_AMD64_REQUIRED')
        diff_ids = config.get('rootfs', {}).get('diff_ids', [])
        require(len(diff_ids) == len(row['Layers']), 'ROOTFS_LAYER_COUNT')
        with tempfile.TemporaryDirectory(prefix='pdv-oci-convert-') as temporary:
            work = Path(temporary); blobs = {}
            def put(raw, media):
                digest = sha256(raw).hexdigest(); path = work / digest; path.write_bytes(raw); blobs[digest] = path
                return {'mediaType': media, 'digest': 'sha256:' + digest, 'size': len(raw)}
            config_descriptor = put(config_bytes, OCI_CONFIG); layers = []
            for number, (name, expected) in enumerate(zip(row['Layers'], diff_ids)):
                target = work / ('layer-' + str(number)); h = sha256()
                with archive.extractfile(member(archive, name)) as layer, target.open('wb') as output:
                    with gzip.GzipFile(filename='', mode='wb', fileobj=output, mtime=0, compresslevel=6) as compressed:
                        for block in iter(lambda: layer.read(1024 * 1024), b''):
                            h.update(block); compressed.write(block)
                require('sha256:' + h.hexdigest() == expected, 'DOCKER_LAYER_DIFF_ID')
                digest = hash_file(target); blobs[digest] = target
                layers.append({'mediaType': OCI_LAYER, 'digest': 'sha256:' + digest, 'size': target.stat().st_size})
            manifest = {'schemaVersion': 2, 'mediaType': OCI_MANIFEST, 'config': config_descriptor, 'layers': layers}
            top = put(encoded(manifest), OCI_MANIFEST)
            top['platform'] = {'architecture': 'amd64', 'os': 'linux'}
            metadata = {'oci-layout': encoded({'imageLayoutVersion': '1.0.0'}),
                        'index.json': encoded({'schemaVersion': 2, 'manifests': [top]})}
            with tarfile.open(destination, 'w', format=tarfile.USTAR_FORMAT) as output:
                for name, raw in sorted(metadata.items()):
                    info = tarfile.TarInfo(name); info.size = len(raw); info.mode = 0o644; output.addfile(info, io.BytesIO(raw))
                for digest, blob in sorted(blobs.items()):
                    info = tarfile.TarInfo('blobs/sha256/' + digest); info.size = blob.stat().st_size; info.mode = 0o644
                    with blob.open('rb') as content:
                        output.addfile(info, content)
    return verify_archive(destination)
