import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,basename} from 'node:path';
import {PassThrough} from 'node:stream';
import {randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createViewerServer} from '/product/desktop-viewer/server.mjs';
import {createAccessGate} from '/product/desktop-viewer/lib/access-gate.mjs';
import {openViewerStore} from '/product/desktop-viewer/lib/store.mjs';
import {publicJwk,keyId,bridgeMessage} from '/product/desktop-viewer/protocol.mjs';
import {accessSign,grantMessage,checkMessage,ACCESS_TTL} from '/product/desktop-viewer/access-protocol.mjs';

const hex=()=>randomBytes(32).toString('hex'),at=Date.parse('2030-01-01T00:00:00.000Z');
async function key(){const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);const publicKey=publicJwk(await crypto.subtle.exportKey('jwk',pair.publicKey));return {...pair,publicKey,id:await keyId(publicKey)};}
async function fixture(t,{phase='active',held=false}={}){
 const dataDir=await mkdtemp(join(tmpdir(),'pdv-response-api-')),pc=await key(),phone=await key(),issuer=await key(),licenseId=hex();
 const payload={schemaVersion:1,product:'pi-desktop-viewer',licenseId,pcId:pc.id,generation:1,issuedAt:new Date(at).toISOString(),expiresAt:new Date(at+ACCESS_TTL).toISOString()};
 const grant={payload,signature:await accessSign(issuer.privateKey,grantMessage(payload))};
 const initial=await openViewerStore(dataDir);let original;
 try{initial.transaction(()=>{initial.set('accessGrant',JSON.stringify(grant));initial.set('accessDenied','ACCESS_RESPONSE_INVALID');initial.set('accessLastSeen',payload.issuedAt);initial.set('pcPublicKey',JSON.stringify(pc.publicKey));initial.set('sharing','true');initial.approve(phone.id,phone.publicKey,payload.issuedAt);});original={identity:JSON.stringify(initial.identity),device:initial.device(phone.id),pc:initial.get('pcPublicKey'),grant:initial.get('accessGrant')};}finally{await initial.close();}
 let issuerChecks=0,relayChecks=0,release,entered;const waiting=new Promise(done=>entered=done),hold=new Promise(done=>release=done);
 const issuerFetch=async(url,options)=>{
  assert.equal(new URL(url).pathname,'/v1/check');issuerChecks++;const request=JSON.parse(options.body);assert.match(request.nonce,/^[a-f0-9]{64}$/);entered();if(held)await hold;
  if(phase==='outage')return Response.json({error:'ACCESS_UNAVAILABLE'},{status:503});
  const status=phase==='revoked'?'revoked':phase==='changed'?'changed':'active';
  const reply={schemaVersion:1,product:'pi-desktop-viewer',nonce:phase==='nonce'?hex():request.nonce,licenseId,pcId:pc.id,generation:phase==='changed'?2:1,status,checkedAt:new Date(at).toISOString(),grant:status==='active'?grant:null};
  return Response.json({payload:reply,signature:phase==='signature'?'a'.repeat(86):await accessSign(issuer.privateKey,checkMessage(reply))});
 };
 const app=await createViewerServer({dataDir,clientOrigin:'https://pdv-client.example',now:()=>at,fetchImpl:async url=>{assert.equal(url,'http://host.docker.internal:43823/v1/status');relayChecks++;return Response.json({schemaVersion:1,state:'waiting',frames:0,ageMs:null,expiresAt:new Date(at+8*3600000).toISOString()});},accessGateFactory:options=>createAccessGate({...options,publicKey:issuer.publicKey,monotonic:()=>0,fetchImpl:issuerFetch})});
 const read=()=>{const db=new DatabaseSync(join(dataDir,'viewer.sqlite'),{readOnly:true});try{return{denied:db.prepare("SELECT v FROM meta WHERE k='accessDenied'").get()?.v,pc:db.prepare("SELECT v FROM meta WHERE k='pcPublicKey'").get()?.v,grant:db.prepare("SELECT v FROM meta WHERE k='accessGrant'").get()?.v,device:db.prepare('SELECT * FROM devices WHERE id=?').get(phone.id)};}finally{db.close();}};
 const call=(path,body={},local=false)=>new Promise(done=>{const req=new PassThrough(),headers={host:'127.0.0.1:18081',origin:local?'http://127.0.0.1:18081':'https://pdv-client.example','content-type':'application/json'};Object.assign(req,{method:'POST',url:path,headers,rawHeaders:Object.entries(headers).flat()});const res={destroyed:false,writableEnded:false,writeHead(status){this.status=status;},end(bytes){this.writableEnded=true;done({status:this.status,body:JSON.parse(bytes.toString())});}};app.server.emit('request',req,res);req.end(JSON.stringify(body));});
 const register=async(who=pc)=>{const challenge=(await call('/api/bridge/challenge',{nonce:hex()},true)).body;const dto={installationId:challenge.installationId,nonce:challenge.nonce,expiresAt:challenge.expiresAt,bridgeId:who.id,publicKey:who.publicKey,capability:hex(),setupCode:hex(),accessGrant:grant};return call('/api/bridge/register',{...dto,signature:await accessSign(who.privateKey,bridgeMessage(dto))},true);};
 t.after(async()=>{release();await app.close();if(dirname(dataDir)!==tmpdir()||!basename(dataDir).startsWith('pdv-response-api-'))throw Error('FIXTURE_SCOPE_INVALID');await rm(dataDir,{recursive:true,force:true});});
 return{pc,phone,original,read,call,register,waiting,release,issuerChecks:()=>issuerChecks,relayChecks:()=>relayChecks,setPhase:value=>phase=value};
}

test('real app API restores same-PC response denial only after fresh signed check and commit, preserving phone approval',async t=>{
 const f=await fixture(t,{held:true});const pending=f.register();await f.waiting;
 const blocked=await f.call('/api/device/enroll',{publicKey:f.phone.publicKey});assert.deepEqual(blocked,{status:403,body:{error:'ACCESS_RESPONSE_INVALID'}});assert.equal(f.read().denied,'ACCESS_RESPONSE_INVALID');assert.equal(f.relayChecks(),0);
 f.release();assert.deepEqual(await pending,{status:200,body:{ok:true}});assert.equal(f.issuerChecks(),1);assert.equal(f.relayChecks(),1);
 const after=f.read();assert.equal(after.denied,'');assert.equal(after.pc,f.original.pc);assert.deepEqual(after.device,f.original.device);assert.equal(JSON.parse(after.grant).payload.pcId,f.pc.id);
 const enrollment=await f.call('/api/device/enroll',{publicKey:f.phone.publicKey});assert.equal(enrollment.status,200);assert.equal(enrollment.body.status,'approved');assert.equal(f.issuerChecks(),1);
});

for(const [phase,denied]of [['outage','ACCESS_RESPONSE_INVALID'],['revoked','ACCESS_REVOKED'],['changed','ACCESS_CHANGED'],['nonce','ACCESS_RESPONSE_INVALID'],['signature','ACCESS_SIGNATURE_INVALID']])test('real app API keeps '+phase+' blocked without resetting licence or phone state',async t=>{
 const f=await fixture(t,{phase});const result=await f.register();assert.deepEqual(result,{status:403,body:{error:denied}});assert.equal(f.issuerChecks(),1);assert.equal(f.relayChecks(),0);
 const after=f.read();assert.equal(after.denied,denied);assert.equal(after.grant,f.original.grant);assert.equal(after.pc,f.original.pc);assert.deepEqual(after.device,f.original.device);
 const blocked=await f.call('/api/device/enroll',{publicKey:f.phone.publicKey});assert.equal(blocked.status,403);assert.equal(blocked.body.error,denied);
});

test('real app API rejects a different PC before response recovery or issuer request',async t=>{
 const f=await fixture(t),other=await key();assert.deepEqual(await f.register(other),{status:403,body:{error:'PC_BINDING_MISMATCH'}});assert.equal(f.issuerChecks(),0);assert.equal(f.relayChecks(),0);assert.equal(f.read().denied,'ACCESS_RESPONSE_INVALID');assert.equal(f.read().grant,f.original.grant);
});
