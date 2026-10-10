'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {runtime}=require('./runtime.cjs');
const linked=opts=>runtime({infuseReady:false,...opts,storage:{kp_token:'catalog-access',kp_refresh:'catalog-refresh',...opts?.storage}});
function notify(rt, id=99) {
  rt.requests.at(-1).ok({device:{id,title:'Old name',hardware:'Apple TV',software:'Old software'}});
  rt.requests.at(-1).ok({status:200}); // capabilities
  const req=rt.requests.at(-1);
  assert.match(req.url,/\/device\/notify$/);
  return req;
}
function confirmed(rt, req, id=99) {
  const data=Object.fromEntries(new URLSearchParams(req.body));
  req.ok({status:200});
  assert.match(rt.requests.at(-1).url,/\/device\/info$/);
  rt.requests.at(-1).ok({device:{id,...data}});
}
test('Infuse description names the integration, contains only documented fields and is read back before readiness',()=>{
  const rt=linked();let ready=0;
  rt.api.notifyDeviceIdentity(null,()=>ready++,assert.fail,rt.api.KPInfuse);
  const req=notify(rt);
  const body=new URLSearchParams(req.body);
  assert.equal(body.get('title'),'Lampa MX / Infuse / Apple TV');
  assert.deepEqual([...body.keys()].sort(),['hardware','software','title']);
  confirmed(rt,req);
  assert.equal(ready,1);
  assert.equal(rt.storage.kp_infuse_device_id_v1,99);
  assert.equal(rt.storage.kp_infuse_device_info_v1.identityConfirmed,true);
  assert.equal(rt.api.KPInfuse.deviceReady(),true);
  assert.equal(rt.storage.kp_token,'catalog-access');
});
test('body-level notify rejection cannot confirm the identity and keeps the registration',()=>{
  const rt=linked();let ready=0,errors=0;
  rt.api.notifyDeviceIdentity(null,()=>ready++,()=>errors++,rt.api.KPInfuse);
  notify(rt).ok({status:400});
  assert.equal(ready,0);assert.equal(errors,1);
  assert.equal(rt.api.KPInfuse.deviceReady(),false);assert.equal(rt.api.KPInfuse.hasToken(),true);
});
test('temporary notify failure retains tokens but cannot claim the new description is verified',()=>{
  const rt=linked();let ready=0,errors=0;
  rt.api.notifyDeviceIdentity(null,()=>ready++,()=>errors++,rt.api.KPInfuse);
  notify(rt).fail({status:503},'unavailable');
  assert.equal(ready,0);assert.equal(errors,1);
  assert.equal(rt.api.KPInfuse.hasToken(),true);
  assert.equal(rt.storage.kp_infuse_device_info_v1.identityConfirmed,false);
});
test('readback with another id cannot confirm the device',()=>{
  const rt=linked();let ready=0,errors=0;
  rt.api.notifyDeviceIdentity(null,()=>ready++,()=>errors++,rt.api.KPInfuse);
  const req=notify(rt);req.ok({status:200});
  assert.match(rt.requests.at(-1).url,/\/device\/info$/);
  rt.requests.at(-1).ok({device:{id:101,title:'Different registration'}});
  assert.equal(ready,0);assert.equal(errors,1);assert.equal(rt.api.KPInfuse.deviceReady(),false);
});
test('a copied or colliding catalog grant must never rename the catalog as Infuse',()=>{
  for (const storage of [{kp_infuse_token_v1:'catalog-access'},{kp_device_id_v1:99}]) {
    const rt=linked({storage});let errors=0;
    rt.api.notifyDeviceIdentity(null,assert.fail,()=>errors++,rt.api.KPInfuse);
    if(rt.requests.length) rt.requests[0].ok({device:{id:99,title:'Catalog'}});
    assert.equal(errors,1);
    assert.equal(rt.requests.some(r=>r.url.endsWith('/device/notify')||r.url.endsWith('/settings')),false);
    assert.equal(rt.storage.kp_token,'catalog-access');
  }
});
test('catalog notification keeps the existing custom device name',()=>{
  const rt=linked();rt.api.notifyDeviceIdentity(null,()=>{},assert.fail);
  rt.requests[0].ok({device:{id:7,title:'My living room'}});
  assert.equal(new URLSearchParams(rt.requests.at(-1).body).get('title'),'My living room');
});
test('logout forgets only that profile identity and a late check cannot restore it',()=>{
  const rt=linked();let ready=0;
  rt.api.notifyDeviceIdentity(null,()=>ready++,()=>{},rt.api.KPInfuse);
  const req=notify(rt);
  rt.storage.kp_device_id_v1=7;rt.api.KPInfuse.clearTokens();
  req.ok({status:200});
  assert.equal(ready,0);assert.equal(rt.storage.kp_infuse_device_id_v1,'');
  assert.equal(rt.storage.kp_device_id_v1,7);assert.equal(rt.storage.kp_token,'catalog-access');
});
test('an old-token successful link response after rotation is retried rather than handed out',()=>{
  const rt=linked();let url;
  rt.api.KPInfuse.mediaVideoLink(null,'/movie.mp4',r=>url=r.url,assert.fail);
  const old=rt.requests[0];rt.api.KPInfuse.refresh(null,()=>{},assert.fail);
  rt.requests.at(-1).ok({access_token:'rotated',refresh_token:'rotated-refresh',expires_in:3600});
  old.ok({url:'https://cdn.example/old.mp4'});
  assert.equal(url,undefined);assert.equal(rt.requests.at(-1).params.headers.Authorization,'Bearer rotated');
  rt.requests.at(-1).ok({url:'https://cdn.example/fresh.mp4'});assert.equal(url,'https://cdn.example/fresh.mp4');
});
test('a cancelled request waiting for a shared refresh does not issue a retry',()=>{
  const rt=linked(),net=new rt.Lampa.Reguest();let complete=0;
  rt.api.KPInfuse.item(net,22,()=>complete++,()=>{});rt.requests[0].fail({status:401});
  const refresh=rt.requests.at(-1);net.clear();
  refresh.ok({access_token:'rotated',refresh_token:'rotated-refresh'});
  assert.equal(rt.requests.length,2);assert.equal(complete,0);
  assert.equal(rt.storage.kp_infuse_token_v1,'rotated','shared grant still rotates for other callers');
});
test('iPad desktop user agent is identified without pretending it is an iPhone',()=>{
  const rt=linked({platform:'apple',userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit Safari/605',navigatorPlatform:'MacIntel',maxTouchPoints:5});
  rt.api.notifyDeviceIdentity(null,()=>{},assert.fail,rt.api.KPInfuse);
  const req=notify(rt);assert.equal(new URLSearchParams(req.body).get('hardware'),'iPad');
  assert.equal(new URLSearchParams(req.body).get('title'),'Lampa MX / Infuse / iPad');
});
test('parallel identity checks share one notification; cancellation belongs only to the waiting source',()=>{
 const rt=linked(),first=new rt.Lampa.Reguest(),second=new rt.Lampa.Reguest();let a=0,b=0;
 rt.api.notifyDeviceIdentity(first,()=>a++,assert.fail,rt.api.KPInfuse);
 rt.api.notifyDeviceIdentity(second,()=>b++,assert.fail,rt.api.KPInfuse);
 assert.equal(rt.requests.length,1);first.clear();
 confirmed(rt,notify(rt));
 assert.equal(a,0);assert.equal(b,1);
 assert.equal(rt.requests.filter(r=>r.url.endsWith('/device/notify')).length,1);
 assert.equal(rt.storage.kp_infuse_device_id_v1,99);
});
test('a saved mx.21 grant is described again without requesting a new device code',()=>{
 const rt=linked({storage:{kp_infuse_token_v1:'saved-access',kp_infuse_refresh_v1:'saved-refresh'}});
 rt.api.notifyDeviceIdentity(null,()=>{},assert.fail,rt.api.KPInfuse);
 confirmed(rt,notify(rt));
 assert.equal(rt.requests.some(r=>r.url.includes('/oauth2/device')),false);
 assert.equal(rt.storage.kp_infuse_token_v1,'saved-access');
 assert.equal(rt.storage.kp_infuse_refresh_v1,'saved-refresh');
});
