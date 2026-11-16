// Final-publication preparation. No network operation occurs on import.
import {readFile,writeFile,mkdir,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {verifyRelease,TRUST,RELEASE_ROOT} from './verify/desktop-viewer/bridge/release.mjs';

export const REPOSITORY='studiodreamsummon/pi-desktop-viewer-releases';
export const BRANCH='viewer-087-publish',VERSION='0.8.7',TAG='v0.8.7';
export const TRUST_SHA256='3ea17fb017c0c0a54dc644431be64fa8291aff6717b38a0dd3ee877625f3500c';
const HEX=/^[a-f0-9]{64}$/,COMMIT=/^[a-f0-9]{40}$/;
const MAX_BINARY=150*1024*1024;
const DOWNLOAD_HOSTS=new Set(['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com']);
const json=value=>Buffer.from(JSON.stringify(value));
export const sha=value=>createHash('sha256').update(value).digest('hex');
const exact=(v,keys)=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const fail=code=>{throw Object.assign(Error(code),{code});};
const require=(value,code)=>{if(!value)fail(code);};
function boundedFile(v,minimum=1,maximum=MAX_BINARY){return exact(v,['sha256','bytes'])&&HEX.test(v.sha256)&&Number.isSafeInteger(v.bytes)&&v.bytes>=minimum&&v.bytes<=maximum;}
function bytes64(text){require(typeof text==='string'&&text.length<=45000&&/^[A-Za-z0-9+/]+={0,2}$/.test(text),'PUB_FEED_ENCODING');const b=Buffer.from(text,'base64');require(b.toString('base64')===text,'PUB_FEED_ENCODING');return b;}
function parse(bytes,code){try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail(code);}}
export async function approve(input,{publicKey=TRUST.publicKey,now=Date.now}={}){
 require(exact(input,['schemaVersion','version','repository','branch','expectedLatest','source','assets','imageDigest','update','publisherTrustSha256','notes']),'PUB_LOCK_SCHEMA');
 require(input.schemaVersion===1&&input.version===VERSION&&input.repository===REPOSITORY&&input.branch===BRANCH&&input.expectedLatest==='v0.8.6','PUB_LOCK_TARGET');
 require(exact(input.source,['commit','tag','freezeId','verification'])&&COMMIT.test(input.source.commit)&&/^[a-f0-9]{16}$/.test(input.source.freezeId)&&input.source.tag==='validation-v0.8.7-'+input.source.freezeId&&boundedFile(input.source.verification,2,1024*1024),'PUB_SOURCE_LOCK');
 require(exact(input.assets,['PiDesktopViewer.exe','PiDesktopViewer.zip'])&&boundedFile(input.assets['PiDesktopViewer.exe'],1024)&&boundedFile(input.assets['PiDesktopViewer.zip'],1024),'PUB_ASSET_LOCK');
 require(/^sha256:[a-f0-9]{64}$/.test(input.imageDigest)&&input.publisherTrustSha256===TRUST_SHA256,'PUB_TRUST_LOCK');
 require(exact(input.update,['base64','sha256','bytes'])&&HEX.test(input.update.sha256)&&Number.isSafeInteger(input.update.bytes)&&input.update.bytes>=2&&input.update.bytes<=32768,'PUB_FEED_LOCK');
 require(exact(input.notes,['text','sha256'])&&typeof input.notes.text==='string'&&Buffer.byteLength(input.notes.text)>0&&Buffer.byteLength(input.notes.text)<=8192&&sha(Buffer.from(input.notes.text))===input.notes.sha256,'PUB_NOTES_LOCK');
 const update=bytes64(input.update.base64);require(update.length===input.update.bytes&&sha(update)===input.update.sha256,'PUB_FEED_HASH');
 let feed;try{feed=await verifyRelease(update,{publicKey,now});}catch{fail('PUB_FEED_INVALID');}
 require(feed.version===VERSION&&feed.imageDigest===input.imageDigest&&feed.exeSha256===input.assets['PiDesktopViewer.exe'].sha256&&feed.exeBytes===input.assets['PiDesktopViewer.exe'].bytes,'PUB_FEED_MISMATCH');
 return {lock:structuredClone(input),update,feed};
}
async function readBounded(response,limit){
 const declared=response.headers.get('content-length');require(declared===null||/^\d+$/.test(declared)&&Number(declared)<=limit,'PUB_RESPONSE_SIZE');
 const reader=response.body?.getReader();require(reader,'PUB_RESPONSE_BODY');let size=0,parts=[];
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;require(size<=limit,'PUB_RESPONSE_SIZE');parts.push(value);}}catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
 require(declared===null||size===Number(declared),'PUB_RESPONSE_SIZE');return Buffer.concat(parts,size);
}
function safeDownloadUrl(value){let u;try{u=new URL(value);}catch{fail('PUB_DOWNLOAD_ORIGIN');}require(u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&!u.hash&&DOWNLOAD_HOSTS.has(u.hostname),'PUB_DOWNLOAD_ORIGIN');return u;}
const allowedRedirect=status=>[301,302,303,307,308].includes(status);
export async function publishFinal(input,{fetchImpl=globalThis.fetch,context=process.env,publicKey=TRUST.publicKey,now=Date.now}={}){
 const state={passed:false,version:VERSION,sourceTag:null,draftReleaseId:null,latestPromotionState:'not_attempted',phase:'approval'};
 try{
  const {lock,update}=await approve(input,{publicKey,now});state.sourceTag=lock.source.tag;
  require(context.GITHUB_REPOSITORY===REPOSITORY&&context.GITHUB_EVENT_NAME==='push'&&context.GITHUB_REF==='refs/heads/'+BRANCH&&COMMIT.test(context.GITHUB_SHA??'')&&typeof context.GH_TOKEN==='string'&&context.GH_TOKEN.length>0,'PUB_CONTEXT');
  const apiBase='https://api.github.com/repos/'+REPOSITORY;
  const headers={authorization:'Bearer '+context.GH_TOKEN,accept:'application/vnd.github+json','accept-encoding':'identity','X-GitHub-Api-Version':'2022-11-28'};
  async function api(path,options={}){require(typeof path==='string'&&(path===''||path.startsWith('/'))&&!path.includes('..')&&!path.includes('#'),'PUB_API_PATH');return fetchImpl(apiBase+path,{...options,headers:{...headers,...options.headers},credentials:'omit',redirect:'manual',signal:AbortSignal.timeout(30000)});}
  async function apiJson(path,options={}){const r=await api(path,options);if(r.status!==(options.method==='POST'?201:200)){await r.body?.cancel();fail('PUB_API_STATUS');}return parse(await readBounded(r,512*1024),'PUB_API_JSON');}
  const sourceUrl=name=>RELEASE_ROOT+'/download/'+lock.source.tag+'/'+name;
  async function download(url,expected,{assetId}={}){
   const whole=AbortSignal.timeout(120000);let authenticated=assetId!==undefined;
   if(authenticated)require(url===apiBase+'/releases/assets/'+assetId&&Number.isSafeInteger(assetId)&&assetId>0,'PUB_PRIVATE_ASSET');else safeDownloadUrl(url);
   for(let hop=0;hop<=5;hop++){
    const r=await fetchImpl(url,{headers:authenticated?{...headers,accept:'application/octet-stream'}:{accept:'application/octet-stream, application/json','accept-encoding':'identity'},credentials:'omit',cache:'no-store',redirect:'manual',signal:AbortSignal.any([whole,AbortSignal.timeout(30000)])});
    if(allowedRedirect(r.status)){const next=r.headers.get('location');await r.body?.cancel();require(next&&hop<5,'PUB_DOWNLOAD_REDIRECT');url=safeDownloadUrl(new URL(next,url).href).href;authenticated=false;continue;}
    require(r.status===200,'PUB_DOWNLOAD_STATUS');const b=await readBounded(r,expected.bytes);require(b.length===expected.bytes&&sha(b)===expected.sha256,'PUB_DOWNLOAD_HASH');return b;
   }fail('PUB_DOWNLOAD_REDIRECT');
  }
  async function tagTarget(tag,{pending=false}={}){
   const r=await api('/git/ref/tags/'+encodeURIComponent(tag));if(r.status===404&&pending){await r.body?.cancel();return null;}require(r.status===200,'PUB_TAG_STATUS');let ref=parse(await readBounded(r,32768),'PUB_TAG_JSON');require(ref.ref==='refs/tags/'+tag&&ref.object&&COMMIT.test(ref.object.sha??''),'PUB_TAG_REF');let target=ref.object;
   if(target.type==='tag'){const annotated=await apiJson('/git/tags/'+target.sha);require(annotated.tag===tag&&annotated.sha===target.sha,'PUB_TAG_REF');target=annotated.object;}
   require(target?.type==='commit'&&COMMIT.test(target.sha??''),'PUB_TAG_REF');return target.sha;
  }
  state.phase='preflight';
  const repo=await apiJson('');require(repo.private===false,'PUB_PUBLIC_REPOSITORY');
  const baseline=await apiJson('/releases/latest');require(baseline.tag_name===lock.expectedLatest&&Number.isSafeInteger(baseline.id)&&baseline.id>0,'PUB_LATEST_CHANGED');
  for(const path of ['/releases/tags/'+TAG,'/git/ref/tags/'+TAG]){const r=await api(path);require(r.status===404,'PUB_EXISTING_OR_UNKNOWN_FINAL');await r.body?.cancel();}
  state.phase='source';
  const source=await apiJson('/releases/tags/'+lock.source.tag);require(source.tag_name===lock.source.tag&&source.draft===false&&source.prerelease===true&&source.target_commitish===lock.source.commit,'PUB_SOURCE_RELEASE');
  require(await tagTarget(lock.source.tag)===lock.source.commit,'PUB_SOURCE_COMMIT');
  require(Array.isArray(source.assets),'PUB_SOURCE_ASSETS');
  for(const [name,expected] of [['verification.json',lock.source.verification],...Object.entries(lock.assets)]){const rows=source.assets.filter(a=>a.name===name);require(rows.length===1&&rows[0].state==='uploaded'&&rows[0].size===expected.bytes,'PUB_SOURCE_ASSETS');}
  const verification=parse(await download(sourceUrl('verification.json'),lock.source.verification),'PUB_VERIFICATION_JSON');
  require(verification.schemaVersion===1&&verification.version===VERSION&&verification.passed===true&&verification.sourceCommit===lock.source.commit&&verification.releaseTag===lock.source.tag&&verification.freezeId===lock.source.freezeId&&verification.officialLatestPromoted===false&&Number.isSafeInteger(verification.apiTests)&&verification.apiTests>=4,'PUB_SOURCE_VERIFICATION');
  require(verification.image?.manifestDigest===lock.imageDigest&&/^sha256:[a-f0-9]{64}$/.test(verification.image.configDigest??'')&&verification.image.configDigest===verification.testedImageId,'PUB_IMAGE_PROVENANCE');
  for(const [name,expected] of Object.entries(lock.assets))require(verification.windowsArtifactSha256?.[name]===expected.sha256,'PUB_SOURCE_ARTIFACT');
  const content=new Map();for(const [name,expected] of Object.entries(lock.assets))content.set(name,await download(sourceUrl(name),expected));content.set('update.json',update);
  const sums=[...content.keys()].sort().map(name=>sha(content.get(name))+'  '+name+'\n').join('');content.set('SHA256SUMS',Buffer.from(sums));
  const expected=new Map([...content].map(([name,b])=>[name,{sha256:sha(b),bytes:b.length}]));
  state.phase='draft';
  const draft=await apiJson('/releases',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({tag_name:TAG,target_commitish:context.GITHUB_SHA,name:'Pi Desktop Viewer '+VERSION,body:lock.notes.text,draft:true,prerelease:false,make_latest:'false',generate_release_notes:false})});
  require(Number.isSafeInteger(draft.id)&&draft.id>0&&draft.tag_name===TAG&&draft.target_commitish===context.GITHUB_SHA&&draft.draft===true&&draft.prerelease===false,'PUB_DRAFT_RESPONSE');state.draftReleaseId=draft.id;
  let upload;try{upload=new URL(draft.upload_url.replace(/\{.*$/,''));}catch{fail('PUB_UPLOAD_ORIGIN');}
  require(upload.protocol==='https:'&&upload.hostname==='uploads.github.com'&&!upload.username&&!upload.password&&!upload.port&&!upload.search&&!upload.hash&&upload.pathname==='/repos/'+REPOSITORY+'/releases/'+draft.id+'/assets','PUB_UPLOAD_ORIGIN');
  state.phase='upload';
  for(const [name,b] of content){const target=new URL(upload);target.searchParams.set('name',name);const r=await fetchImpl(target.href,{method:'POST',headers:{...headers,'content-type':'application/octet-stream','content-length':String(b.length)},body:b,redirect:'manual',credentials:'omit',signal:AbortSignal.timeout(120000)});require(r.status===201,'PUB_ASSET_UPLOAD');const a=parse(await readBounded(r,32768),'PUB_ASSET_RESPONSE');require(a.name===name&&a.size===b.length&&Number.isSafeInteger(a.id)&&a.id>0,'PUB_ASSET_RESPONSE');}
  state.phase='draft-verification';
  const current=await apiJson('/releases/'+draft.id);require(current.draft===true&&current.prerelease===false&&current.tag_name===TAG&&current.target_commitish===context.GITHUB_SHA&&Array.isArray(current.assets)&&current.assets.length===4,'PUB_DRAFT_CHANGED');
  for(const [name,shape] of expected){const rows=current.assets.filter(a=>a.name===name);require(rows.length===1&&rows[0].state==='uploaded'&&rows[0].size===shape.bytes&&Number.isSafeInteger(rows[0].id)&&rows[0].id>0,'PUB_UPLOADED_ASSETS');await download(apiBase+'/releases/assets/'+rows[0].id,shape,{assetId:rows[0].id});}
  const latest=await apiJson('/releases/latest');require(latest.id===baseline.id&&latest.tag_name===lock.expectedLatest,'PUB_LATEST_CHANGED');
  require(await tagTarget(lock.source.tag)===lock.source.commit,'PUB_SOURCE_COMMIT');const pendingTag=await tagTarget(TAG,{pending:true});require(pendingTag===null||pendingTag===context.GITHUB_SHA,'PUB_FINAL_TAG_CHANGED');
  state.phase='promotion';state.latestPromotionState='attempted_unknown';
  const final=await apiJson('/releases/'+draft.id,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({draft:false,prerelease:false,make_latest:'true'})});
  require(final.id===draft.id&&final.tag_name===TAG&&final.draft===false&&final.prerelease===false,'PUB_PROMOTION_RESPONSE');state.latestPromotionState='confirmed_published';
  state.phase='public-verification';
  const finalLatest=await apiJson('/releases/latest');require(finalLatest.id===draft.id&&finalLatest.tag_name===TAG&&finalLatest.draft===false&&finalLatest.prerelease===false,'PUB_LATEST_UNVERIFIED');require(await tagTarget(TAG)===context.GITHUB_SHA,'PUB_FINAL_TAG_CHANGED');
  for(const [name,shape] of expected)await download(RELEASE_ROOT+'/download/'+TAG+'/'+name,shape);
  await download(RELEASE_ROOT+'/latest/download/update.json',expected.get('update.json'));
  state.phase='complete';state.passed=true;state.releaseTag=TAG;state.sourceCommit=lock.source.commit;state.publisherCommit=context.GITHUB_SHA;state.assets=Object.fromEntries(expected);state.imageDigest=lock.imageDigest;return state;
 }catch(error){const code=/^PUB_[A-Z0-9_]+$/.test(error?.code??'')?error.code:'PUB_FAILURE';throw Object.assign(Error(code),{code,publication:{...state,error:code}});}
}

export async function verifyCanonicalSources(){const raw=await readFile(new URL('./canonical-sources.json',import.meta.url),'utf8');const files=JSON.parse(raw);require(exact(files,['verify/desktop-viewer/bridge/release.mjs','verify/desktop-viewer/bridge/release-trust.json','verify/desktop-viewer/protocol.mjs']),'PUB_CANONICAL_FILES');for(const [name,row] of Object.entries(files)){require(/^verify\/desktop-viewer\/(?:bridge\/)?[A-Za-z0-9.-]+$/.test(name)&&HEX.test(row.sha256),'PUB_CANONICAL_FILES');require(sha(await readFile(new URL('./'+name,import.meta.url)))===row.sha256,'PUB_CANONICAL_CHANGED');}require(sha(await readFile(new URL('./verify/desktop-viewer/bridge/release-trust.json',import.meta.url)))===TRUST_SHA256,'PUB_TRUST_CHANGED');}
export async function runCli(args,options={}){require(args.length===2,'PUB_ARGUMENTS');const [input,out]=args;await mkdir(resolve(out),{recursive:false});let receipt;try{await verifyCanonicalSources();const st=await lstat(input);require(st.isFile()&&!st.isSymbolicLink()&&st.size<=256*1024,'PUB_LOCK_FILE');const lock=parse(await readFile(input),'PUB_LOCK_JSON');receipt=await publishFinal(lock,options);}catch(error){receipt=error.publication??{passed:false,error:/^PUB_[A-Z0-9_]+$/.test(error?.code??'')?error.code:'PUB_FAILURE',latestPromotionState:'not_attempted'};}try{await writeFile(join(resolve(out),'publication-result.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});}catch{throw Object.assign(Error('PUB_RECEIPT_WRITE'),{publication:{...receipt,passed:false,error:'PUB_RECEIPT_WRITE'}});}return receipt;}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{const result=await runCli(process.argv.slice(2));console.log(JSON.stringify(result));if(!result.passed)process.exitCode=1;}catch(error){console.log(JSON.stringify(error.publication??{passed:false,error:'PUB_START_FAILED',latestPromotionState:'not_attempted'}));process.exitCode=1;}}
