import worker from '../src/worker.js';
const enc=new TextEncoder();
const b64u=b=>Buffer.from(b).toString('base64url');
const assert=(c,m)=>{if(!c){console.error('FAIL',m);process.exit(1)}console.log('ok -',m)};
// keys
const kp=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
const pub=await crypto.subtle.exportKey('jwk',kp.publicKey);
const CLIENT='8000000001';
async function idToken(claims,kid='oidc-1'){const h=b64u(JSON.stringify({alg:'RS256',kid,typ:'JWT'}));const p=b64u(JSON.stringify(claims));
 const s=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',kp.privateKey,enc.encode(h+'.'+p));return h+'.'+p+'.'+b64u(s);}
const now=()=>Math.floor(Date.now()/1000);
let nextClaims=null, lastTokenReq=null;
// fake channel
const channel={msgs:[],pinned:null,files:{}};let fid=0;
const realFetch=globalThis.fetch;
globalThis.fetch=async(input,init={})=>{
 const url=typeof input==='string'?input:input.url;
 if(url==='https://oauth.telegram.org/.well-known/jwks.json')return Response.json({keys:[{...pub,kid:'oidc-1',alg:'RS256'}]});
 if(url==='https://oauth.telegram.org/token'){lastTokenReq={headers:init.headers,body:new URLSearchParams(init.body)};return Response.json({id_token:await idToken(nextClaims)});}
 let m=url.match(/^https:\/\/api\.telegram\.org\/botTESTTOKEN\/(\w+)$/);
 if(m){const method=m[1];let body;
  if(init.body instanceof FormData){body=Object.fromEntries(init.body.entries());}else body=JSON.parse(init.body||'{}');
  if(method==='getChat')return Response.json({ok:true,result:{id:-100,type:'channel',pinned_message:channel.pinned}});
  if(method==='sendDocument'){const id='F'+(++fid);channel.files[id]={blob:body.document,path:'documents/file_'+fid+'.'+(body.document.name.split('.').pop())};
    const msg={message_id:100+fid,document:{file_id:id,file_name:body.document.name}};channel.msgs.push(msg);return Response.json({ok:true,result:msg});}
  if(method==='pinChatMessage'){channel.pinned=channel.msgs.find(x=>x.message_id===body.message_id);return Response.json({ok:true,result:true});}
  if(method==='getFile'){const f=channel.files[body.file_id];if(!f)return Response.json({ok:false,description:'Bad Request: invalid file_id'});return Response.json({ok:true,result:{file_id:body.file_id,file_path:f.path}});}
  return Response.json({ok:false,description:'unknown method'});}
 m=url.match(/^https:\/\/api\.telegram\.org\/file\/botTESTTOKEN\/(.+)$/);
 if(m){const f=Object.values(channel.files).find(x=>x.path===m[1]);return new Response(f.blob,{headers:{'content-type':'application/octet-stream'}});}
 throw new Error('unexpected fetch '+url);
};
const env={TG_CLIENT_ID:CLIENT,TG_CLIENT_SECRET:'sec',BOT_TOKEN:'TESTTOKEN',SESSION_SECRET:'x'.repeat(40),CHANNEL_ID:'-100',ADMIN_USER_ID:'111',ALLOWED_USER_IDS:'222, 333',
 ASSETS:{fetch:()=>new Response('<html>app</html>',{headers:{'content-type':'text/html'}})}};
const O='https://fam.example.workers.dev';
const call=(path,init={})=>worker.fetch(new Request(O+path,init),env);
const cookieOf=(res,name)=>{for(const c of res.headers.getSetCookie()){if(c.startsWith(name+'='))return c.split(';')[0];}return null;};

// 1. login redirect
let r=await call('/auth/login');
assert(r.status===302,'login redirects');
const loc=new URL(r.headers.get('location'));
assert(loc.origin==='https://oauth.telegram.org'&&loc.pathname==='/auth','to telegram /auth');
assert(loc.searchParams.get('code_challenge_method')==='S256'&&loc.searchParams.get('client_id')===CLIENT&&loc.searchParams.get('redirect_uri')===O+'/auth/callback','pkce + client + redirect params');
const flowCookie=cookieOf(r,'tg_oauth');assert(flowCookie,'flow cookie set');
const state=loc.searchParams.get('state');

// 2. callback, bad state
r=await call('/auth/callback?code=abc&state=WRONG',{headers:{cookie:flowCookie}});
assert(r.headers.get('location')==='/#login_error=state_mismatch','state mismatch rejected');

// 3. callback denied user
nextClaims={iss:'https://oauth.telegram.org',aud:CLIENT,sub:'999999',iat:now(),exp:now()+3600,id:999,name:'Stranger'};
r=await call(`/auth/callback?code=abc&state=${state}`,{headers:{cookie:flowCookie}});
assert(r.headers.get('location')==='/#denied=999','non-allowlisted user denied with id');
assert(!cookieOf(r,'session'),'no session for denied user');

// 4. wrong audience
nextClaims={iss:'https://oauth.telegram.org',aud:'other',sub:'1',iat:now(),exp:now()+3600,id:111,name:'Admin'};
r=await call(`/auth/callback?code=abc&state=${state}`,{headers:{cookie:flowCookie}});
assert(r.headers.get('location')==='/#login_error=invalid_id_token','wrong aud rejected');

// 5. tampered token signature
{const good=await idToken({iss:'https://oauth.telegram.org',aud:CLIENT,sub:'1',iat:now(),exp:now()+3600,id:222,name:'X'});
 const parts=good.split('.');parts[1]=b64u(JSON.stringify({iss:'https://oauth.telegram.org',aud:CLIENT,exp:now()+3600,id:111,name:'Evil'}));
 const save=globalThis.fetch;globalThis.fetch=async(u,i)=>u==='https://oauth.telegram.org/token'?Response.json({id_token:parts.join('.')}):save(u,i);
 r=await call(`/auth/callback?code=abc&state=${state}`,{headers:{cookie:flowCookie}});globalThis.fetch=save;
 assert(r.headers.get('location')==='/#login_error=invalid_id_token','tampered id_token rejected');}

// 6. admin success
nextClaims={iss:'https://oauth.telegram.org',aud:CLIENT,sub:'abc',iat:now(),exp:now()+3600,id:111,name:'Praveen Admin',preferred_username:'padmin'};
r=await call(`/auth/callback?code=abc&state=${state}`,{headers:{cookie:flowCookie}});
assert(r.status===302&&r.headers.get('location')==='/','admin signed in');
assert(lastTokenReq.body.get('code_verifier')&&lastTokenReq.headers.authorization.startsWith('Basic '),'token request has verifier + basic auth');
const sess=cookieOf(r,'session');assert(sess,'session cookie set');
assert(r.headers.getSetCookie().some(c=>c.includes('HttpOnly')&&c.includes('Secure')),'cookie HttpOnly+Secure');

// 7. api
r=await call('/api/me');assert(r.status===401,'no cookie -> 401');
r=await call('/api/me',{headers:{cookie:sess}});let j=await r.json();assert(j.user.id==='111'&&j.user.admin===true,'me returns admin');
r=await call('/api/me',{headers:{cookie:sess.slice(0,-3)+'AAA'}});assert(r.status===401,'tampered session -> 401');
r=await call('/api/data',{headers:{cookie:sess}});j=await r.json();assert(j.data===null&&j.version===null,'empty data initially');
const H={cookie:sess,origin:O,'content-type':'application/json'};
r=await call('/api/data',{method:'PUT',headers:{...H,origin:'https://evil.com'},body:'{}'});assert(r.status===403,'cross-origin PUT blocked');
r=await call('/api/data',{method:'PUT',headers:H,body:JSON.stringify({version:null,data:{people:[{id:'p1',name:'Raman'}],memories:[]}})});
j=await r.json();assert(r.status===200&&j.version===101,'save v1 -> pinned');
r=await call('/api/data',{headers:{cookie:sess}});j=await r.json();assert(j.version===101&&j.data.people[0].name==='Raman','load returns saved data');
r=await call('/api/data',{method:'PUT',headers:H,body:JSON.stringify({version:null,data:{people:[],memories:[]}})});
assert(r.status===409,'stale version -> 409 conflict');
r=await call('/api/data',{method:'PUT',headers:H,body:JSON.stringify({version:101,data:{people:[1]}})});assert(r.status===400,'invalid data rejected');

// 8. upload + proxy
const png=new Uint8Array([137,80,78,71,13,10,26,10,1,2,3]);
let fd=new FormData();fd.append('file',new File([png],'kid.png',{type:'image/png'}));
r=await call('/api/upload',{method:'POST',headers:{cookie:sess,origin:O},body:fd});j=await r.json();
assert(r.status===200&&j.fileId,'upload returns fileId');
r=await call('/api/file/'+encodeURIComponent(j.fileId),{headers:{cookie:sess}});
const bytes=new Uint8Array(await r.arrayBuffer());
assert(r.headers.get('content-type')==='image/png'&&bytes.length===png.length,'file proxy streams image with type');
fd=new FormData();fd.append('file',new File(['hi'],'a.txt',{type:'text/plain'}));
r=await call('/api/upload',{method:'POST',headers:{cookie:sess,origin:O},body:fd});assert(r.status===415,'non-image rejected');
r=await call('/api/file/x',{});assert(r.status===401,'file proxy requires session');

// 9. revocation & other member
const env2={...env,ALLOWED_USER_IDS:''};env.ADMIN_USER_ID='111';
nextClaims={iss:'https://oauth.telegram.org',aud:CLIENT,sub:'m',iat:now(),exp:now()+3600,id:222,name:'Divya'};
r=await call(`/auth/callback?code=abc&state=${state}`,{headers:{cookie:flowCookie}});const s2=cookieOf(r,'session');assert(s2,'allowlisted member signs in');
r=await worker.fetch(new Request(O+'/api/me',{headers:{cookie:s2}}),env2);assert(r.status===401,'removed from allowlist -> revoked');

// 10. logout + assets
r=await call('/auth/logout',{method:'POST',headers:{origin:O}});assert(r.status===204&&r.headers.get('set-cookie').includes('Max-Age=0'),'logout clears cookie');
r=await call('/');assert((await r.text()).includes('app'),'static assets served');
console.log('\nALL TESTS PASSED');
