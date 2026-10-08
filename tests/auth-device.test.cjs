'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {runtime}=require('./runtime.cjs');
const linked=()=>runtime({storage:{kp_token:'old-access',kp_refresh:'old-refresh'}});
const grants=rt=>rt.requests.filter(r=>r.url.endsWith('/oauth2/token'));

test('simultaneous device/profile/item 401s rotate once and all retry the new token',()=>{
  const rt=linked(),done=[];
  rt.api.KP.profile(null,()=>done.push('profile'),assert.fail);
  rt.api.KP.deviceInfo(null,()=>done.push('device'),assert.fail);
  rt.api.KP.item(null,22,()=>done.push('item'),assert.fail);
  rt.requests.slice().forEach(r=>r.fail({status:401},'unauthorized'));
  assert.equal(grants(rt).length,1);
  grants(rt)[0].ok({access_token:'new-access',refresh_token:'new-refresh',expires_in:3600});
  const retried=rt.requests.slice(4);assert.equal(retried.length,3);
  retried.forEach(r=>{assert.equal(r.params.headers.Authorization,'Bearer new-access');r.ok({status:200});});
  assert.deepEqual(done,['profile','device','item']);assert.equal(rt.storage.kp_refresh,'new-refresh');
});

test('late old-token 401 retries the current token without another rotation, including POST',()=>{
  const rt=linked(),done=[];
  rt.api.KP.profile(null,()=>done.push('profile'),assert.fail);
  rt.api.KP.deviceNotify(null,{title:'Fixture'},()=>done.push('notify'),assert.fail);
  const [profile,notify]=rt.requests;
  profile.fail({status:401});grants(rt)[0].ok({access_token:'new-access',refresh_token:'new-refresh'});
  notify.fail({status:401});assert.equal(grants(rt).length,1);
  const retry=rt.requests.at(-1);assert.equal(retry.params.headers.Authorization,'Bearer new-access');
  assert.equal(new URLSearchParams(retry.body).get('title'),'Fixture');retry.ok({status:200});
  assert.ok(done.includes('notify'));
});

test('expiring tokens refresh before API requests; legacy tokens remain usable',()=>{
  const rt=linked();rt.storage.kp_token_expires_at_v1=Date.now()+100;
  rt.api.KP.item(null,22,()=>{},assert.fail);rt.api.KP.deviceInfo(null,()=>{},assert.fail);
  assert.equal(rt.requests.length,1);assert.equal(grants(rt).length,1);
  grants(rt)[0].ok({access_token:'new-access',refresh_token:'new-refresh',expires_in:3600});
  assert.equal(rt.requests.length,3);assert.ok(rt.storage.kp_token_expires_at_v1>Date.now()+3500000);
  const legacy=linked();legacy.api.KP.item(null,22,()=>{},assert.fail);
  assert.equal(grants(legacy).length,0);assert.equal(legacy.requests.length,1);
});

test('network failures retain credentials; explicit revoked refresh credentials clear them',()=>{
  for(const status of [0,503,400]) {
    const rt=linked(),errors=[];rt.api.KP.profile(null,assert.fail,(x,s)=>errors.push(s));
    rt.requests[0].fail({status:401});grants(rt)[0].fail({status,responseText:status===400?'{}':''},'offline');
    assert.equal(errors.length,1);assert.equal(rt.storage.kp_token,'old-access');assert.equal(rt.storage.kp_refresh,'old-refresh');
  }
  const rt=linked();rt.api.KP.refresh(null,assert.fail,()=>{});
  grants(rt)[0].fail({status:400,responseText:JSON.stringify({error:'invalid_grant'})});
  assert.equal(rt.api.KP.hasToken(),false);assert.equal(rt.storage.kp_refresh,'');
});

test('logout during rotation cannot restore the old device or retry pending media requests',()=>{
  const rt=linked(),errors=[];rt.api.KP.item(null,22,assert.fail,(x,s)=>errors.push(s));
  rt.requests[0].fail({status:401});const grant=grants(rt)[0];rt.api.KP.clearTokens();
  grant.ok({access_token:'late-access',refresh_token:'late-refresh'});
  assert.equal(rt.api.KP.hasToken(),false);assert.equal(rt.storage.kp_refresh,'');
  assert.equal(rt.requests.length,2);assert.equal(grant.cleared,true);assert.deepEqual(errors,['auth_changed']);
});

test('new device activation cancels an older token rotation without overwriting the new device',()=>{
  const rt=linked(),errors=[];rt.api.KP.refresh(null,assert.fail,(x,s)=>errors.push(s));
  const grant=grants(rt)[0];
  rt.api.KP.pollDeviceToken(null,'fake-code',()=>{},assert.fail,assert.fail);
  rt.requests.at(-1).ok({access_token:'different-access',refresh_token:'different-refresh',expires_in:3600});
  grant.ok({access_token:'late-access',refresh_token:'late-refresh'});
  assert.equal(rt.storage.kp_token,'different-access');assert.equal(rt.storage.kp_refresh,'different-refresh');
  assert.equal(grant.cleared,true);assert.deepEqual(errors,['auth_changed']);
});

test('registration confirms the existing OAuth device; notify is metadata, not new activation',()=>{
  const rt=linked();let ready=0;rt.api.notifyDeviceIdentity(null,()=>ready++,assert.fail);
  assert.ok(rt.requests[0].url.endsWith('/device/info'));rt.requests[0].ok({device:{id:7,title:'Fixture'}});
  const notify=rt.requests.at(-1);assert.ok(notify.url.endsWith('/device/notify'));
  assert.equal(notify.params.headers.Authorization,'Bearer old-access');
  assert.match(new URLSearchParams(notify.body).get('title'),/Lampa/);
  notify.fail({status:503});assert.equal(ready,1);assert.equal(grants(rt).length,0);
  assert.equal(rt.requests.some(r=>r.url.endsWith('/oauth2/device')),false);
});

test('cancelling activation suppresses a late token response',()=>{
  const rt=runtime(),net=new rt.Lampa.Reguest();let active=true,success=0;
  rt.api.KP.pollDeviceToken(net,'fake-code',()=>success++,()=>{},assert.fail,()=>active);
  active=false;rt.requests[0].ok({access_token:'late-access',refresh_token:'late-refresh'});
  assert.equal(success,0);assert.equal(rt.api.KP.hasToken(),false);
});

test('activation polls sequentially and confirms the device before reporting success',()=>{
  const rt=runtime();let ready=0;rt.api.openAuthModal(()=>ready++);
  rt.requests[0].ok({code:'fake-code',user_code:'ABCDEF',interval:5,expires_in:600});
  rt.tickAll();const token=rt.requests.at(-1);assert.ok(token.url.endsWith('/oauth2/device'));
  const count=rt.requests.length;rt.tickAll();assert.equal(rt.requests.length,count);
  token.ok({error:'authorization_pending'});rt.tickAll();
  rt.requests.at(-1).ok({access_token:'new-access',refresh_token:'new-refresh',expires_in:3600});
  assert.equal(ready,0);assert.ok(rt.requests.at(-1).url.endsWith('/device/info'));
  rt.requests.at(-1).ok({device:{id:7}});rt.requests.at(-1).ok({status:200});
  assert.equal(ready,1);assert.equal(rt.storage.kp_token,'new-access');
});

test('a cancelled activation error cannot close a newer activation',()=>{
  const rt=runtime();rt.api.openAuthModal(()=>{});const old=rt.requests[0];
  rt.api.closeAuthModal('back');rt.api.openAuthModal(()=>{});const current=rt.requests.at(-1);
  old.fail({status:503});assert.equal(current.cleared,false);
  current.ok({code:'new-code',user_code:'ABCDEF',interval:5,expires_in:600});
  rt.tickAll();assert.ok(rt.requests.at(-1).url.endsWith('/oauth2/device'));
  assert.equal(new URLSearchParams(rt.requests.at(-1).body).get('code'),'new-code');
});
