"""CI-only: copy a digest-pinned transport image into a clean canonical context."""
from pathlib import Path, PurePosixPath
from hashlib import sha256
import argparse, json, os, re, shutil, subprocess
from oci_archive import convert, hash_file, archive_summary, LIMIT

def require(ok, code):
    if not ok:
        raise ValueError(code)

def run(args, **options):
    result = subprocess.run(args, capture_output=True, text=True, timeout=options.pop('timeout', 300), **options)
    if result.returncode:
        # Build/test output is public synthetic output; no credentials are passed.
        raise ValueError('COMMAND_FAILED:' + args[0] + ':' + str(result.returncode))
    return result.stdout

def build(args):
    data, out = Path(args.data).resolve(), Path(args.out).resolve()
    require(not out.exists(), 'OUTPUT_EXISTS')
    freeze = json.loads((data / 'freeze.json').read_text())
    source = json.loads((data / 'validation-source.json').read_text())
    require(freeze['schemaVersion'] == source['schemaVersion'] == 1 and freeze['version'] == '0.8.7', 'FREEZE_SCHEMA')
    require(source['freezeId'] == freeze['freezeId'] and source['repository'] == freeze['repository'], 'SOURCE_FREEZE_BINDING')
    require(re.fullmatch(r'sha256:[a-f0-9]{64}', source['digest']) is not None, 'PINNED_SOURCE_REQUIRED')
    require(source['validationTag'] == freeze['validationTag'] and source['validationTag'].startswith('0.8.7-validation-'), 'VALIDATION_TAG')
    require(hash_file(data / 'Dockerfile') == freeze['dockerfileSha256'], 'DOCKERFILE_CHANGED')
    require(hash_file(data / 'server-api-validation.mjs') == freeze['fixtureSha256'], 'FIXTURE_CHANGED')
    require(hash_file(data.parents[1] / '.github/workflows/viewer-087-validation.yml') == freeze['workflowSha256'], 'WORKFLOW_CHANGED')
    for name, expected in freeze['ciHashes'].items():
        require(hash_file(data / name) == expected, 'CI_SOURCE_CHANGED')
    out.mkdir(parents=True); context = out / 'context'; context.mkdir()
    image = source['repository'] + '@' + source['digest']
    run(['docker', 'pull', '--platform', 'linux/amd64', image])
    cid = run(['docker', 'create', '--platform', 'linux/amd64', '--entrypoint', '/bin/false', image]).strip()
    require(re.fullmatch(r'[a-f0-9]{64}', cid) is not None, 'CONTAINER_ID_INVALID')
    try:
        for name in freeze['contextHashes']:
            parts = PurePosixPath(name).parts
            require(not name.startswith('/') and '\\' not in name and '..' not in parts and
                    (name.startswith('desktop-viewer/') or name.startswith('app/lib/')), 'CONTEXT_PATH')
            target = context / name; target.parent.mkdir(parents=True, exist_ok=True)
            run(['docker', 'cp', cid + ':/product/' + name, str(target)])
            require(target.is_file() and not target.is_symlink() and hash_file(target) == freeze['contextHashes'][name], 'IMAGE_CONTEXT_HASH')
    finally:
        run(['docker', 'rm', cid])
    actual = {p.relative_to(context).as_posix() for p in context.rglob('*') if p.is_file()}
    require(actual == set(freeze['contextHashes']), 'CLEAN_CONTEXT_ALLOWLIST')
    require(json.loads((context / 'desktop-viewer/package.json').read_text())['version'] == '0.8.7', 'IMAGE_VERSION')
    shutil.copyfile(data / 'Dockerfile', context / 'Dockerfile')
    tag = 'pdv-clean-validation:' + freeze['freezeId']
    run(['docker', 'build', '--platform', 'linux/amd64', '--pull', '--tag', tag,
         '--file', str(context / 'Dockerfile'), str(context)], timeout=600)
    config = json.loads(run(['docker', 'image', 'inspect', tag]))[0]
    require(config['Architecture'] == 'amd64' and config['Os'] == 'linux' and
            config['Config']['User'] == 'node' and config['Config']['WorkingDir'] == '/product' and
            config['Config']['Cmd'] == ['node', 'desktop-viewer/server.mjs'], 'CANONICAL_IMAGE_CONFIG')
    fixture = data / 'server-api-validation.mjs'
    report = run(['docker', 'run', '--rm', '--network', 'none', '--read-only',
        '--memory', '256m', '--cpus', '1', '--pids-limit', '128', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--tmpfs', '/tmp:rw,noexec,nosuid,size=128m', '--mount', 'type=bind,src=' + str(fixture) + ',dst=/validation/server-api-validation.mjs,readonly',
        '--entrypoint', 'node', tag, '--test', '--test-reporter=tap', '/validation/server-api-validation.mjs'], timeout=180)
    def count(name):
        found = re.search(r'^# ' + name + r' (\d+)$', report, re.M)
        return int(found.group(1)) if found else -1
    require(count('tests') >= freeze.get('minimumApiTests', 4) and count('pass') == count('tests') and
            count('fail') == count('cancelled') == count('skipped') == 0, 'ACTUAL_SERVER_API_TESTS_REQUIRED')
    (out / 'api-tests.tap').write_text(report)
    release = out / 'release'; release.mkdir()
    docker_save = out / 'docker-save.tar'
    run(['docker', 'image', 'save', '--output', str(docker_save), tag], timeout=180)
    print(json.dumps({'dockerSaveArchive': archive_summary(docker_save)}), flush=True)
    image_record = convert(docker_save, release / 'docker-image.oci.tar')
    require(image_record['configDigest'] == config['Id'], 'EXPORTED_IMAGE_DIFFERS_FROM_TESTED_IMAGE')
    for name in ('PiDesktopViewer.exe', 'PiDesktopViewer.zip'):
        shutil.copyfile(context / 'desktop-viewer/dist' / name, release / name)
        require(hash_file(release / name) == freeze['artifactSha256'][name], 'WINDOWS_ARTIFACT_CHANGED')
    record = {'schemaVersion': 1, 'version': '0.8.7', 'freezeId': freeze['freezeId'], 'passed': True,
        'transportSourceDigest': source['digest'], 'canonicalDockerfileSha256': freeze['dockerfileSha256'],
        'workflowSha256': freeze['workflowSha256'], 'sourceCommit': os.environ.get('GITHUB_SHA'),
        'contextHashes': freeze['contextHashes'], 'apiTests': count('tests'), 'apiTestReportSha256': hash_file(out / 'api-tests.tap'),
        'image': image_record, 'testedImageId': config['Id'], 'windowsArtifactSha256': freeze['artifactSha256'],
        'releaseTag': freeze['releaseTag'], 'officialLatestPromoted': False}
    (release / 'verification.json').write_text(json.dumps(record, indent=2) + '\n')
    shutil.copyfile(out / 'api-tests.tap', release / 'api-tests.tap')
    for path in release.iterdir():
        require(path.is_file() and path.stat().st_size < LIMIT, 'RELEASE_ASSET_LIMIT')
    sums = ''.join(hash_file(path) + '  ' + path.name + '\n' for path in sorted(release.iterdir()))
    (release / 'SHA256SUMS').write_text(sums)
    print(json.dumps({'passed': True, 'apiTests': count('tests'), 'manifestDigest': image_record['manifestDigest'],
                      'ociBytes': image_record['bytes'], 'releaseTag': freeze['releaseTag']}))

if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--data', required=True); p.add_argument('--out', required=True)
    build(p.parse_args())
