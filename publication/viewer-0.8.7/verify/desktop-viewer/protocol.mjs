// Pure browser/Node signing format. No storage, network or import-time keys.
export const SERVER_CHALLENGE_MAX_FUTURE_MS=35000;
const HEX=/^[a-f0-9]{64}$/;
const B64=/^[A-Za-z0-9_-]{43}$/;
const encoder=new TextEncoder();
function invalid(){throw new TypeError('PROTOCOL_INVALID');}
function coordinate(value){
 if(typeof value!=='string'||!B64.test(value))return invalid();
 let bytes;try{bytes=Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')+'='),c=>c.charCodeAt(0));}catch{return invalid();}
 if(bytes.length!==32||btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'')!==value)return invalid();
 return value;
}
export function publicJwk(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['kty','crv','x','y','key_ops','ext'].includes(k))||value.kty!=='EC'||value.crv!=='P-256')return invalid();
 return {kty:'EC',crv:'P-256',x:coordinate(value.x),y:coordinate(value.y)};
}
export async function keyId(value){
 const bytes=new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',encoder.encode(JSON.stringify(publicJwk(value)))));
 return Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
}
function fields(value,keys){
 if(!value||typeof value!=='object'||Array.isArray(value))return invalid();
 return keys.map(k=>{const v=value[k];if(k==='expiresAt'){if(typeof v!=='string'||!Number.isFinite(Date.parse(v))||new Date(v).toISOString()!==v)return invalid();}else if(typeof v!=='string'||!HEX.test(v))return invalid();return v;});
}
export function serverMessage(value){return encoder.encode(JSON.stringify(['PDV/SERVER/1',...fields(value,['installationId','nonce','expiresAt'])]));}
export function bridgeMessage(value){return encoder.encode(JSON.stringify(['PDV/BRIDGE/1',...fields(value,['installationId','nonce','expiresAt','bridgeId','capability','setupCode']),...(Object.hasOwn(value,'accessGrant')?[value.accessGrant]:[]),...(Object.hasOwn(value,'renewal')?[value.renewal]:[])]));}
export function deviceMessage(value){return encoder.encode(JSON.stringify(['PDV/DEVICE/1',...fields(value,['installationId','bridgeId','deviceId','nonce','expiresAt'])]));}
