// Public publisher trust and bounded anonymous release downloads. No account credentials.
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import {publicJwk} from '../protocol.mjs';
export const RELEASE_ROOT='https://github.com/studiodreamsummon/pi-desktop-viewer-releases/releases';
export const LATEST_EXE=RELEASE_ROOT+'/latest/download/PiDesktopViewer.exe';
export const IMAGE_REPOSITORY='studiodreamsummon/pi-desktop-viewer';
export const TRUST=JSON.parse(await readFile(new URL('./release-trust.json',import.meta.url),'utf8'));
const hosts=new Set(['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com']);
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
export const failure=code=>Object.assign(Error(code),{code});
export function versionParts(value){if(typeof value!=='string'||!/^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/.test(value))throw failure('UPDATE_MANIFEST_INVALID');return value.split('.').map(Number);}
export function compareVersions(a,b){a=versionParts(a);b=versionParts(b);for(let i=0;i<3;i++)if(a[i]!==b[i])return a[i]>b[i]?1:-1;return 0;}
export function allowedReleaseUrl(value){let u;try{u=new URL(value);}catch{throw failure('UPDATE_URL_INVALID');}if(u.protocol!=='https:'||u.username||u.password||u.port||!hosts.has(u.hostname)||u.hash)throw failure('UPDATE_URL_INVALID');return u;}
export async function downloadReleaseBytes(url,{limit=32768,fetchImpl=globalThis.fetch,signal,timeoutMs=30000,totalMs=120000}={}){
 const lifetime=AbortSignal.timeout(totalMs),whole=signal?AbortSignal.any([signal,lifetime]):lifetime;
 for(let hop=0;hop<=5;hop++){
  allowedReleaseUrl(url);const part=AbortSignal.any([whole,AbortSignal.timeout(timeoutMs)]);let response;
  try{response=await fetchImpl(url,{redirect:'manual',cache:'no-store',credentials:'omit',signal:part,headers:{Accept:'application/octet-stream, application/json'}});}catch{throw failure(whole.aborted?'UPDATE_CANCELLED':'UPDATE_DOWNLOAD_FAILED');}
  if([301,302,303,307,308].includes(response.status)){const next=response.headers.get('location');await response.body?.cancel();if(!next||hop===5)throw failure('UPDATE_URL_INVALID');url=new URL(next,url).href;continue;}
  if(response.status!==200){await response.body?.cancel();throw failure('UPDATE_DOWNLOAD_FAILED');}const declared=response.headers.get('content-length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>limit)){await response.body?.cancel();throw failure('UPDATE_DOWNLOAD_INVALID');}
  let size=0;const chunks=[];try{if(response.body)for await(const chunk of response.body){if(part.aborted)throw Error();size+=chunk.length;if(size>limit)throw failure('UPDATE_DOWNLOAD_INVALID');chunks.push(chunk);}}catch(error){await response.body?.cancel().catch(()=>{});throw failure(error.code==='UPDATE_DOWNLOAD_INVALID'?error.code:whole.aborted?'UPDATE_CANCELLED':'UPDATE_DOWNLOAD_FAILED');}
  if(declared!==null&&size!==Number(declared))throw failure('UPDATE_DOWNLOAD_INVALID');return Buffer.concat(chunks);
 }throw failure('UPDATE_URL_INVALID');
}
function b64(value,max){if(typeof value!=='string'||value.length>max||!/^[A-Za-z0-9_-]+$/.test(value))throw failure('UPDATE_SIGNATURE_INVALID');const out=Buffer.from(value,'base64url');if(out.toString('base64url')!==value)throw failure('UPDATE_SIGNATURE_INVALID');return out;}
export async function verifyRelease(bytes,{publicKey=TRUST.publicKey,now=Date.now}={}){
 if(!Buffer.isBuffer(bytes)||bytes.length>32768)throw failure('UPDATE_MANIFEST_INVALID');let envelope,payload;
 try{envelope=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes));}catch{throw failure('UPDATE_MANIFEST_INVALID');}
 if(!exact(envelope,['schemaVersion','payload','signature'])||envelope.schemaVersion!==1)throw failure('UPDATE_MANIFEST_INVALID');
 const body=b64(envelope.payload,24000),signature=b64(envelope.signature,86);if(signature.length!==64)throw failure('UPDATE_SIGNATURE_INVALID');
 try{const key=await webcrypto.subtle.importKey('jwk',publicJwk(publicKey),{name:'ECDSA',namedCurve:'P-256'},false,['verify']);if(!await webcrypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,signature,body))throw Error();}catch{throw failure('UPDATE_SIGNATURE_INVALID');}
 try{payload=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(body));}catch{throw failure('UPDATE_MANIFEST_INVALID');}
 if(!exact(payload,['schemaVersion','version','publishedAt','imageDigest','exeUrl','exeSha256','exeBytes'])||payload.schemaVersion!==1)throw failure('UPDATE_MANIFEST_INVALID');versionParts(payload.version);
 if(typeof payload.publishedAt!=='string'||!Number.isFinite(Date.parse(payload.publishedAt))||new Date(Date.parse(payload.publishedAt)).toISOString()!==payload.publishedAt||Date.parse(payload.publishedAt)>now()+300000||!/^sha256:[a-f0-9]{64}$/.test(payload.imageDigest)||!Number.isSafeInteger(payload.exeBytes)||payload.exeBytes<1024||payload.exeBytes>150*1024*1024||!/^[a-f0-9]{64}$/.test(payload.exeSha256)||payload.exeUrl!==RELEASE_ROOT+'/download/v'+payload.version+'/PiDesktopViewer.exe')throw failure('UPDATE_MANIFEST_INVALID');
 return Object.freeze(payload);
}
export async function getRelease(version=null,options={}){if(version!==null)versionParts(version);const url=version===null?RELEASE_ROOT+'/latest/download/update.json':RELEASE_ROOT+'/download/v'+version+'/update.json';const bytes=await downloadReleaseBytes(url,options),manifest=await verifyRelease(bytes,options);if(version!==null&&manifest.version!==version)throw failure('UPDATE_MANIFEST_INVALID');return{manifest,envelope:bytes};}
