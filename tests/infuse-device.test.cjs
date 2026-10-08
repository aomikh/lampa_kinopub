'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {runtime}=require('./runtime.cjs');
const linked=()=>runtime({storage:{kp_token:'catalog-access',kp_refresh:'catalog-refresh'}});
const grants=rt=>rt.requests.filter(r=>r.url.endsWith('/oauth2/token'));
const item={id:22,title:'Fixture',videos:[{files:[
  {quality:'2160p',file:'/fixture/4k.mp4',urls:{http:'https://cdn.example/new-device-4k.mp4'}},
  {quality:'1080p',file:'/fixture/1080.mp4',urls:{http:'https://cdn.example/new-device-1080.mp4'}}
]}]};
function source(rt){
  const view={reset(){},loading(){},filter(){},draw(items,options){this.items=items;this.options=options;}};
  const src=new rt.api.kpapi(view,{movie:{id:111,title:'Fixture'}});
  src.find(22);rt.requests.at(-1).ok({item});return {src,view};
}
function verify(rt){
  const info=rt.requests.at(-1);assert.match(info.url,/\/device\/info$/);
  info.ok({device:{id:99,title:'Separate device'}});
  const settings=rt.requests.at(-1);assert.match(settings.url,/\/device\/99\/settings$/);
  const body=new URLSearchParams(settings.body);
  assert.equal(body.get('support4k'),'1');assert.equal(body.get('supportHevc'),'1');assert.equal(body.get('supportHdr'),'1');
  assert.equal(body.has('serverLocation'),false);assert.equal(body.has('streamingType'),false);
  settings.ok({status:200});
  const notify=rt.requests.at(-1);assert.match(notify.url,/\/device\/notify$/);
  assert.match(new URLSearchParams(notify.body).get('title'),/^Infuse \(Apple TV\)$/);
  notify.ok({status:200});
}

test('Infuse has independent refresh flights and logout never clears the catalog grant',()=>{
  const rt=linked();
  rt.api.KP.profile(null,()=>{},assert.fail);rt.api.KPInfuse.deviceInfo(null,()=>{},assert.fail);
  rt.requests.slice().forEach(r=>r.fail({status:401}));assert.equal(grants(rt).length,2);
  assert.deepEqual(grants(rt).map(r=>new URLSearchParams(r.body).get('refresh_token')),['catalog-refresh','infuse-fixture-refresh']);
  grants(rt)[0].ok({access_token:'new-catalog',refresh_token:'new-catalog-refresh'});
  grants(rt)[1].ok({access_token:'new-infuse',refresh_token:'new-infuse-refresh'});
  assert.equal(rt.storage.kp_token,'new-catalog');assert.equal(rt.storage.kp_infuse_token_v1,'new-infuse');
  rt.api.KPInfuse.clearTokens();
  assert.equal(rt.storage.kp_token,'new-catalog');assert.equal(rt.storage.kp_refresh,'new-catalog-refresh');
  assert.equal(rt.api.KPInfuse.hasToken(),false);assert.equal(rt.api.KPInfuse.deviceReady(),false);
});

test('main logout and revoked Infuse refresh never modify the other profile',()=>{
  const rt=linked();rt.api.KP.clearTokens();
  assert.equal(rt.api.KPInfuse.hasToken(),true);
  rt.api.KPInfuse.refresh(null,assert.fail,()=>{});
  grants(rt)[0].fail({status:400,responseText:JSON.stringify({error:'invalid_grant'})});
  assert.equal(rt.api.KPInfuse.hasToken(),false);
  const second=linked();second.api.KPInfuse.refresh(null,assert.fail,()=>{});
  grants(second)[0].fail({status:400,responseText:JSON.stringify({error:'invalid_grant'})});
  assert.equal(second.storage.kp_token,'catalog-access');assert.equal(second.storage.kp_refresh,'catalog-refresh');
});

test('separate activation keeps existing catalog tokens and declares maximum-quality capabilities',()=>{
  const rt=runtime({infuseLinked:false,storage:{kp_token:'catalog-access',kp_refresh:'catalog-refresh'}});let ready=0;
  rt.api.openAuthModal(()=>ready++,rt.api.KPInfuse);
  rt.requests[0].ok({code:'infuse-code',user_code:'ABCDEF',interval:5,expires_in:600});
  assert.equal(rt.modals[0].title,'kp_infuse_login');rt.tickAll();
  rt.requests.at(-1).ok({access_token:'infuse-new',refresh_token:'infuse-new-refresh'});
  assert.equal(ready,0);verify(rt);assert.equal(ready,1);
  assert.equal(rt.storage.kp_token,'catalog-access');assert.equal(rt.storage.kp_refresh,'catalog-refresh');
  assert.equal(rt.storage.kp_infuse_token_v1,'infuse-new');assert.equal(rt.api.KPInfuse.deviceReady(),true);
  assert.ok(rt.requests.filter(r=>r.url.includes('/v1/')).every(r=>r.params.headers.Authorization==='Bearer infuse-new'));
});

test('capability failure cannot report Infuse ready or silently use a limited-quality device',()=>{
  const rt=runtime({infuseReady:false});let ready=0,errors=0;
  rt.api.notifyDeviceIdentity(null,()=>ready++,()=>errors++,rt.api.KPInfuse);
  rt.requests[0].ok({device:{id:99}});rt.requests.at(-1).fail({status:503});
  assert.equal(ready,0);assert.equal(errors,1);assert.equal(rt.api.KPInfuse.deviceReady(),false);
  assert.equal(rt.api.KPInfuse.hasToken(),true);
});

test('first Play opens Infuse activation and continues with its own links after confirmation',()=>{
  const rt=runtime({infuseLinked:false,storage:{kp_token:'catalog-access',player:'infuse'}}),{view}=source(rt);
  view.options.onEnter(view.items[0]);
  assert.match(rt.requests.at(-1).url,/\/oauth2\/device$/);
  assert.equal(rt.requests.filter(r=>r.url.includes('media-video-link')).length,0);
  rt.requests.at(-1).ok({code:'infuse-code',user_code:'ABCDEF',interval:5,expires_in:600});rt.tickAll();
  rt.requests.at(-1).ok({access_token:'infuse-new',refresh_token:'infuse-refresh'});verify(rt);
  const metadata=rt.requests.at(-1);assert.match(metadata.url,/\/items\/22$/);
  assert.equal(metadata.params.headers.Authorization,'Bearer infuse-new');metadata.ok({item});
  const resolver=rt.requests.at(-1);assert.equal(resolver.params.headers.Authorization,'Bearer infuse-new');
  assert.equal(new URL(resolver.url).searchParams.get('type'),'http');
  resolver.ok({type:'http',url:'https://cdn.example/infuse-new.mp4?sig=a%2B+b'});
  assert.equal(rt.launches.length,1);assert.equal(rt.storage.kp_token,'catalog-access');
  view.options.onEnter(view.items[0]);
  assert.match(rt.requests.at(-1).url,/\/items\/22$/);
  assert.equal(rt.requests.filter(r=>r.url.endsWith('/oauth2/device')).length,2,'no new activation on subsequent Play');
});

test('cancelling Infuse activation permits another Play without granting the catalog credentials to Infuse',()=>{
  const rt=runtime({infuseLinked:false,storage:{kp_token:'catalog-access',player:'infuse'}}),{view}=source(rt);
  view.options.onEnter(view.items[0]);const first=rt.requests.at(-1);
  rt.api.closeAuthModal('back');first.ok({code:'late',user_code:'LATE'});
  assert.equal(rt.api.KPInfuse.hasToken(),false);assert.equal(rt.launches.length,0);
  view.options.onEnter(view.items[0]);assert.notEqual(rt.requests.at(-1),first);
  assert.equal(rt.storage.kp_token,'catalog-access');
});

test('saved experimental delivery cannot override direct files and fresh dedicated-device maximum',()=>{
  const rt=runtime({storage:{kp_token:'catalog-access',player:'infuse',kp_infuse_format_v1:'hls2',kp_max_quality:'720'}});
  const {view}=source(rt);assert.equal(rt.api.preferredFormat('infuse'),'http');
  view.options.onEnter(view.items[0]);const metadata=rt.requests.at(-1);
  assert.equal(metadata.params.headers.Authorization,'Bearer infuse-fixture-access');
  const fresh={...item,videos:[{files:[{quality:'4320p',file:'/fixture/new-8k.mp4'},...item.videos[0].files]}]};
  metadata.ok({item:fresh});const resolve=rt.requests.at(-1),query=new URL(resolve.url).searchParams;
  assert.equal(query.get('file'),'/fixture/new-8k.mp4');assert.equal(query.get('type'),'http');
  const signed='https://cdn.example/http/new.mp4?sig=a%2Bb%2Fc&x=a+b&x=2';resolve.ok({type:'http',url:signed});
  assert.equal(new URL(rt.launches[0]).searchParams.get('url'),signed);
  assert.equal(rt.storage.kp_max_quality,'720');assert.equal(rt.internal.length,0);
});
