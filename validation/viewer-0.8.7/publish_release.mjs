// CI-only publication. Uses the automatic GitHub token, never Docker credentials.
import {readFile,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
const fail=code=>{throw Error(code);};
const [dataArg,outArg]=process.argv.slice(2);
if(!dataArg||!outArg||process.argv.length!==4)fail('EXPECTED_DATA_AND_RELEASE_DIRECTORY');
const data=resolve(dataArg),out=resolve(outArg),freeze=JSON.parse(await readFile(join(data,'freeze.json'),'utf8'));
const repository='studiodreamsummon/pi-desktop-viewer-releases';
if(process.env.GITHUB_REPOSITORY!==repository||process.env.GITHUB_EVENT_NAME!=='push'||process.env.GITHUB_REF!=='refs/heads/'+freeze.branch||!process.env.GH_TOKEN||! /^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA??''))fail('PUBLISH_CONTEXT_INVALID');
if(freeze.version!=='0.8.7'||freeze.releaseTag!=='validation-v0.8.7-'+freeze.freezeId)fail('VALIDATION_TAG_REQUIRED');
const assets=['docker-image.oci.tar','PiDesktopViewer.exe','PiDesktopViewer.zip','verification.json','api-tests.tap','SHA256SUMS'];
const sha=async path=>{const h=createHash('sha256');for await(const bytes of createReadStream(path))h.update(bytes);return h.digest('hex');};
const sums=new Map((await readFile(join(out,'SHA256SUMS'),'utf8')).trim().split(/\r?\n/).map(line=>{const match=/^([a-f0-9]{64})  ([A-Za-z0-9._-]+)$/.exec(line);if(!match)fail('CHECKSUM_FORMAT');return[match[2],match[1]];}));
for(const name of assets){const path=join(out,name);if((await stat(path)).size>=2*1024**3)fail('ASSET_TOO_LARGE');if(name!=='SHA256SUMS'&&sums.get(name)!==await sha(path))fail('ASSET_CHANGED');}
const verification=JSON.parse(await readFile(join(out,'verification.json'),'utf8'));
if(verification.passed!==true||verification.freezeId!==freeze.freezeId||verification.releaseTag!==freeze.releaseTag||verification.sourceCommit!==process.env.GITHUB_SHA||verification.officialLatestPromoted!==false)fail('VERIFIED_CANDIDATE_REQUIRED');
for(const name of ['PiDesktopViewer.exe','PiDesktopViewer.zip'])if(await sha(join(out,name))!==freeze.artifactSha256[name])fail('PREBUILT_WINDOWS_ARTIFACT_CHANGED');
const headers={authorization:'Bearer '+process.env.GH_TOKEN,accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'};
async function api(path,options={}){return fetch('https://api.github.com/repos/'+repository+path,{...options,headers:{...headers,...options.headers},redirect:'error'});}
const repo=await api('');if(!repo.ok||(await repo.json()).private!==false)fail('PUBLIC_REPOSITORY_REQUIRED');
const previous=await api('/releases/tags/'+encodeURIComponent(freeze.releaseTag));if(previous.status!==404)fail('VALIDATION_RELEASE_EXISTS_OR_UNKNOWN');
const tagPath='/git/ref/tags/'+encodeURIComponent(freeze.releaseTag);
const previousTag=await api(tagPath);if(previousTag.status!==404)fail('VALIDATION_GIT_TAG_EXISTS_OR_UNKNOWN');
const latestBefore=await api('/releases/latest');if(!latestBefore.ok)fail('OFFICIAL_LATEST_UNVERIFIED');const latest=(await latestBefore.json()).tag_name;
if(latest==='v0.8.7')fail('OFFICIAL_087_ALREADY_LATEST');
const created=await api('/releases',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
 tag_name:freeze.releaseTag,target_commitish:process.env.GITHUB_SHA,name:'Validation only: Pi Desktop Viewer 0.8.7 / '+freeze.freezeId,
 body:'Automated isolated Linux image/API validation. This prerelease does not promote the official update feed or latest release. See verification.json and SHA256SUMS.',
 draft:false,prerelease:true,make_latest:'false',generate_release_notes:false})});
if(created.status!==201)fail('VALIDATION_RELEASE_CREATE_FAILED');
const release=await created.json(),upload=new URL(release.upload_url.replace(/\{.*$/,''));
if(release.tag_name!==freeze.releaseTag||release.target_commitish!==process.env.GITHUB_SHA||release.prerelease!==true||release.draft!==false)fail('CREATED_RELEASE_PROVENANCE_INVALID');
const tagReply=await api(tagPath);if(!tagReply.ok)fail('CREATED_TAG_UNVERIFIED');
const tag=await tagReply.json();if(tag.ref!=='refs/tags/'+freeze.releaseTag||! /^[a-f0-9]{40}$/.test(tag.object?.sha??''))fail('CREATED_TAG_INVALID');
let target=tag.object;
if(target.type==='tag'){
 const annotated=await api('/git/tags/'+target.sha);if(!annotated.ok)fail('ANNOTATED_TAG_UNVERIFIED');
 const body=await annotated.json();if(body.tag!==freeze.releaseTag||body.sha!==target.sha)fail('ANNOTATED_TAG_INVALID');target=body.object;
}
if(target?.type!=='commit'||target.sha!==process.env.GITHUB_SHA)fail('CREATED_TAG_COMMIT_MISMATCH');
if(upload.protocol!=='https:'||upload.hostname!=='uploads.github.com')fail('UPLOAD_ORIGIN_INVALID');
for(const name of assets){
 const path=join(out,name),url=new URL(upload);url.searchParams.set('name',name);
 const result=await fetch(url,{method:'POST',headers:{...headers,'content-type':'application/octet-stream','content-length':String((await stat(path)).size)},body:createReadStream(path),duplex:'half',redirect:'error'});
 if(result.status!==201)fail('VALIDATION_ASSET_UPLOAD_FAILED');
}
const latestAfter=await api('/releases/latest');if(!latestAfter.ok||(await latestAfter.json()).tag_name!==latest)fail('OFFICIAL_LATEST_CHANGED');
console.log(JSON.stringify({publishedValidationPrerelease:true,officialLatestPromoted:false,releaseTag:freeze.releaseTag,assets:assets.length}));
