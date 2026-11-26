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
  const storage={getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};
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
  account.config.emailRedirect=()=>'https://hswar.cz/?lang=en';
  await account.sendPasswordReset('player@example.com');
  await account.resendConfirmation('player@example.com');
  const query='?redirect_to='+encodeURIComponent('https://hswar.cz/?lang=en');
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

function signIn(account){
  const claims=Buffer.from(JSON.stringify({sub:'first-player'})).toString('base64url');
  account.adoptRedirect(new URLSearchParams({type:'signup',access_token:'header.'+claims+'.signature',refresh_token:'refresh'}));
}

test('a save queued on an older cloud revision is a conflict and never overwrites the cloud',async()=>{
  const {account,storage,requests,setResponse}=loadAccounts();
  signIn(account);
  const pending=JSON.stringify({progress:{xp:100},revision:4});
  storage.setItem(account.pendingKey,pending);
  setResponse({ok:true,status:200,json:async()=>({username:'player',player_id:'p1',revision:5,progress:{xp:900}})});
  await assert.rejects(account.load(),{code:'cloud_conflict'});
  await assert.rejects(account.flush(),{code:'cloud_conflict'});
  assert.deepEqual(requests.map(r=>r.url),['https://example.com/rest/v1/rpc/hsw_account']);
  assert.equal(storage.getItem(account.pendingKey),pending);
});

test('a save queued on the current cloud revision is uploaded with that revision',async()=>{
  const {account,storage,requests,setResponse}=loadAccounts();
  signIn(account);
  storage.setItem(account.pendingKey,JSON.stringify({progress:{xp:100},revision:5}));
  const replies=[{username:'player',player_id:'p1',revision:5,progress:{xp:900}},6];
  setResponse({ok:true,status:200,json:async()=>replies.shift()});
  await account.load();
  assert.equal(requests[1].url,'https://example.com/rest/v1/rpc/hsw_save_progress');
  const body=JSON.parse(requests[1].body);
  assert.equal(body.p_revision,5);
  assert.equal(body.p_progress.xp,100);
  assert.equal(account.profile.revision,6);
  assert.equal(storage.getItem(account.pendingKey),undefined);
});

test('a queued score refused by the 30-second limit is sent again once the limit is over',async()=>{
  const start=html.indexOf('MODULES["account-ui.js"]=');
  const MODULES={'accounts.js':{},'data.js':{TANKS:[]},'leaderboard.js':{escapeHTML:String}};
  const timers=[];
  vm.runInNewContext(html.slice(start,html.indexOf('\nMODULES[',start+1)),{MODULES,Intl,
    setTimeout:(fn,ms)=>timers.push({fn,ms}),clearTimeout:()=>{}});
  const values=new Map(),sent=[];
  const month=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Prague',year:'numeric',month:'2-digit'}).format(new Date());
  const ui=Object.create(MODULES['account-ui.js'].AccountUI.prototype);
  Object.assign(ui,{toast:()=>{},status:()=>{},account:{
    profile:{player_id:'p1'},
    storage:{getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)},
    async submit(score,run){
      sent.push(run);
      if(sent.length===2)throw Object.assign(Error('Wait 30 s.'),{code:'score_cooldown'});
      return score;
    }
  }});
  values.set(ui.scoresKey,JSON.stringify([{score:100,run:'a',month},{score:200,run:'b',month}]));
  assert.equal(await ui.flushScores(),false);
  assert.equal(timers.length,1);
  assert.ok(timers[0].ms>=30000);
  assert.equal(await timers[0].fn(),true);
  assert.deepEqual(sent,['a','b','b']);
  assert.equal(values.get(ui.scoresKey),'[]');
});

test('deleting the account checks the password, asks the server with the fresh session and signs out here',async()=>{
  const {account,storage,requests,setResponse}=loadAccounts();
  account.persist({access_token:'old',refresh_token:'old-refresh',expires_in:3600,user:{id:'player-1'}});
  account.profile={email:'player@example.com'};
  storage.setItem('hsw-account-pending:player-1','{"progress":{},"revision":1}');
  setResponse({ok:false,status:400,json:async()=>({error_code:'invalid_credentials'})});
  await assert.rejects(account.deleteAccount('wrong-password'),{code:'wrong_password'});
  assert.ok(account.session,'a wrong password keeps the player signed in');
  assert.ok(!requests.some(r=>r.url.endsWith('/rpc/hsw_delete_account')));
  setResponse({ok:true,status:200,json:async()=>({access_token:'fresh',refresh_token:'fresh-refresh',expires_in:3600,user:{id:'player-1'}})});
  await account.deleteAccount('right-password');
  const call=requests.find(r=>r.url==='https://example.com/rest/v1/rpc/hsw_delete_account');
  assert.equal(call.headers.Authorization,'Bearer fresh');
  assert.equal(account.session,null);
  assert.equal(storage.getItem(account.key),undefined);
  assert.equal(storage.getItem('hsw-account-pending:player-1'),undefined);
});

test('an account waiting for deletion is signed out and points the player to support',async()=>{
  const {account,storage,setResponse}=loadAccounts();
  account.persist({access_token:'token',refresh_token:'refresh',expires_in:3600,user:{id:'player-1'}});
  setResponse({ok:false,status:400,json:async()=>({code:'P0001',message:'account_deleted'})});
  await assert.rejects(account.load(),{code:'account_deleted',message:/support@hswar\.cz/});
  assert.equal(account.session,null);
  assert.equal(storage.getItem(account.key),undefined);
  setResponse({ok:false,status:400,json:async()=>({code:400,error_code:'user_banned',msg:'User is banned'})});
  await assert.rejects(account.login('player@example.com','example-password'),{code:'user_banned',message:/support@hswar\.cz/});
});
