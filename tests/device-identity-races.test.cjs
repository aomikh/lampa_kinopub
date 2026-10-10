'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {runtime}=require('./runtime.cjs');
const linked=opts=>runtime({...opts,storage:{kp_token:'catalog-access',kp_refresh:'catalog-refresh',...opts?.storage}});
function notify(rt) {
 rt.requests.at(-1).ok({device:{id:7,title:'My living room',hardware:'Old hardware',software:'Old software'}});
 const req=rt.requests.at(-1);assert.match(req.url,/\/device\/notify$/);return req;
}
test('catalog notification preserves the custom name and uses only documented identity fields',()=>{
 const rt=linked();let ready=0;rt.api.notifyDeviceIdentity(null,()=>ready++,assert.fail);
 const req=notify(rt),body=new URLSearchParams(req.body);
 assert.equal(body.get('title'),'My living room');
 assert.deepEqual([...body.keys()].sort(),['hardware','software','title']);
 assert.equal(body.get('hardware'),'Apple TV');
 req.ok({status:200});assert.equal(ready,1);assert.equal(rt.storage.kp_device_id_v1,7);
 assert.equal(rt.requests.some(r=>r.url.endsWith('/settings')||r.url.endsWith('/oauth2/device')),false);
});
test('body-level notify rejection keeps the catalog credentials',()=>{
 const rt=linked();let ready=0,errors=0;
 rt.api.notifyDeviceIdentity(null,()=>ready++,()=>errors++);notify(rt).ok({status:400});
 assert.equal(ready,0);assert.equal(errors,1);assert.equal(rt.api.KP.hasToken(),true);
});
test('logout during identity notification cannot restore the old registration',()=>{
 const rt=linked();let ready=0;rt.api.notifyDeviceIdentity(null,()=>ready++,()=>{});
 const req=notify(rt);rt.api.KP.clearTokens();req.ok({status:200});
 assert.equal(ready,0);assert.equal(rt.storage.kp_device_id_v1,'');assert.equal(rt.api.KP.hasToken(),false);
});
test('an old-token successful item response after rotation is retried with the current token',()=>{
 const rt=linked();let result;
 rt.api.KP.item(null,22,r=>result=r,assert.fail);const old=rt.requests[0];
 rt.api.KP.refresh(null,()=>{},assert.fail);
 rt.requests.at(-1).ok({access_token:'rotated',refresh_token:'rotated-refresh',expires_in:3600});
 old.ok({item:{id:22,title:'Old links'}});
 assert.equal(result,undefined);assert.equal(rt.requests.at(-1).params.headers.Authorization,'Bearer rotated');
 rt.requests.at(-1).ok({item:{id:22,title:'Fresh links'}});assert.equal(result.item.title,'Fresh links');
});
test('a cancelled request waiting for a shared refresh does not issue a retry',()=>{
 const rt=linked(),net=new rt.Lampa.Reguest();let complete=0;
 rt.api.KP.item(net,22,()=>complete++,()=>{});rt.requests[0].fail({status:401});
 const refresh=rt.requests.at(-1);net.clear();
 refresh.ok({access_token:'rotated',refresh_token:'rotated-refresh'});
 assert.equal(rt.requests.length,2);assert.equal(complete,0);assert.equal(rt.storage.kp_token,'rotated');
});
test('iPad desktop user agent retains actual catalog hardware identification',()=>{
 const rt=linked({platform:'apple',userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit Safari/605',navigatorPlatform:'MacIntel',maxTouchPoints:5});
 rt.api.notifyDeviceIdentity(null,()=>{},assert.fail);
 const req=notify(rt);assert.equal(new URLSearchParams(req.body).get('hardware'),'iPad');
});
test('parallel catalog checks share one notification; cancelling a caller does not cancel another',()=>{
 const rt=linked(),first=new rt.Lampa.Reguest(),second=new rt.Lampa.Reguest();let a=0,b=0;
 rt.api.notifyDeviceIdentity(first,()=>a++,assert.fail);rt.api.notifyDeviceIdentity(second,()=>b++,assert.fail);
 assert.equal(rt.requests.length,1);first.clear();notify(rt).ok({status:200});
 assert.equal(a,0);assert.equal(b,1);assert.equal(rt.requests.filter(r=>r.url.endsWith('/device/notify')).length,1);
});
