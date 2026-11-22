const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8').replace(/\r\n/g,'\n');

function loadAccounts(){
  const start=html.indexOf('MODULES["accounts.js"]=');
  const end=html.indexOf('\nMODULES[',start+1);
  const MODULES={'data.js':{TANKS:[]}};
  vm.runInNewContext(html.slice(start,end),{MODULES,AbortController,setTimeout,clearTimeout,atob});
  const values=new Map();
  const storage={getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)};
  const requests=[];
  let response={ok:true,status:200,json:async()=>({})};
  const fetcher=async(url,options)=>{requests.push({url,...options});return response;};
  const account=new MODULES['accounts.js'].PlayerAccount({url:'https://example.com',publishableKey:'public-key'},storage,fetcher);
  return {account,storage,requests,setResponse:value=>{response=value;}};
}

test('requests password recovery with the supplied address and masks missing users',async()=>{
  const {account,requests,setResponse}=loadAccounts();
  await account.sendPasswordReset('  player@example.com  ');
  assert.equal(requests[0].url,'https://example.com/auth/v1/recover');
  assert.equal(requests[0].method,'POST');
  assert.equal(requests[0].headers.Authorization,undefined);
  assert.deepEqual(JSON.parse(requests[0].body),{email:'player@example.com'});
  setResponse({ok:false,status:404,json:async()=>({error_code:'user_not_found'})});
  await account.sendPasswordReset('missing@example.com');
  setResponse({ok:false,status:429,json:async()=>({error_code:'over_email_send_rate_limit'})});
  await assert.rejects(account.sendPasswordReset('player@example.com'),{code:'over_email_send_rate_limit'});
  await assert.rejects(account.sendPasswordReset('invalid-email'));
  assert.equal(requests.length,3);
});

test('checks the 7-digit emailed code with Supabase and returns its recovery token',async()=>{
  const {account,storage,requests,setResponse}=loadAccounts();
  await assert.rejects(account.verifyResetCode('player@example.com','123456'),/7 číslic/);
  await assert.rejects(account.verifyResetCode('player@example.com','12345678'),/7 číslic/);
  assert.equal(requests.length,0);
  setResponse({ok:true,status:200,json:async()=>({access_token:'recovery-token',refresh_token:'r'})});
  assert.equal(await account.verifyResetCode(' player@example.com ','123 4567'),'recovery-token');
  assert.equal(requests[0].url,'https://example.com/auth/v1/verify');
  assert.deepEqual(JSON.parse(requests[0].body),{type:'recovery',email:'player@example.com',token:'1234567'});
  assert.equal(storage.getItem(account.key),undefined,'the code does not sign the player in');
  setResponse({ok:false,status:403,json:async()=>({error_code:'otp_expired'})});
  await assert.rejects(account.verifyResetCode('player@example.com','7654321'),{code:'otp_expired'});
});

test('passes the game language to Supabase emails through the return address',async()=>{
  const {account,requests}=loadAccounts();
  account.config.emailRedirect=()=>'https://hsw.neplytegr.cz/?lang=en';
  await account.sendPasswordReset('player@example.com');
  await account.resendConfirmation('player@example.com');
  const query='?redirect_to='+encodeURIComponent('https://hsw.neplytegr.cz/?lang=en');
  assert.equal(requests[0].url,'https://example.com/auth/v1/recover'+query);
  assert.equal(requests[1].url,'https://example.com/auth/v1/resend'+query);
});

test('resends the sign-up confirmation email',async()=>{
  const {account,requests}=loadAccounts();
  await account.resendConfirmation('player@example.com');
  assert.equal(requests[0].url,'https://example.com/auth/v1/resend');
  assert.deepEqual(JSON.parse(requests[0].body),{type:'signup',email:'player@example.com'});
});

test('uses the recovery token for changing the password without replacing the active session',async()=>{
  const {account,storage,requests}=loadAccounts();
  const claims=Buffer.from(JSON.stringify({sub:'first-player'})).toString('base64url');
  const accessToken='header.'+claims+'.signature';
  const signup=new URLSearchParams({type:'signup',access_token:accessToken,refresh_token:'signup-refresh'});
  assert.equal(account.adoptRedirect(signup),true);
  const savedSession=storage.getItem(account.key);
  const recovery=new URLSearchParams({type:'recovery',access_token:accessToken,refresh_token:'recovery-refresh'});
  assert.equal(account.adoptRedirect(recovery),false);
  await assert.rejects(account.resetPassword('recovery-token','short'));
  await account.resetPassword('recovery-token','new-example-password');
  assert.equal(requests.length,1);
  assert.equal(requests[0].url,'https://example.com/auth/v1/user');
  assert.equal(requests[0].method,'PUT');
  assert.equal(requests[0].headers.Authorization,'Bearer recovery-token');
  assert.deepEqual(JSON.parse(requests[0].body),{password:'new-example-password'});
  assert.equal(storage.getItem(account.key),savedSession);
});
