'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {runtime}=require('./runtime.cjs');
const signed='https://video.example/http/episode?sig=a%2B+b%26&preload=1&x=?%25=';
function fixture() {
  const rt=runtime({storage:{kp_token:'fixture',kp_refresh:'refresh-fixture',player:'infuse',kp_subtitles_enabled:true}});
  const view={reset(){},loading(){},filter(){},draw(items,options){this.items=items;this.options=options;}};
  const src=new rt.api.kpapi(view,{movie:{id:111,name:'Fixture'}});
  const item={id:22,title:'Fixture',type:'serial',seasons:[{number:1,episodes:[1,2,3].map(number=>({
    number,files:[1080,720].map(q=>({quality:q+'p',file:'/fixture/s1e'+number+'-'+q+'.mp4',
      urls:{http:'https://video.example/old/'+number+'/'+q,hls2:'https://video.example/hls2/'+number+'/'+q+'.m3u8'}})),
    audios:[{lang:'eng',index:0},{lang:'rus',index:1}],
    subtitles:[{url:'https://subs.example/'+number+'.srt?sig=a+b%26',lang:'eng'}]
  }))}]};
  src.find(22);rt.requests.at(-1).ok({item});
  const before={...rt.storage};
  view.items.forEach(i=>{
    i.timeline={time:37,percent:1};
    i.mark=()=>assert.fail('handoff is not a watched event');
  });
  function start(quality) {
    const count=rt.requests.length;
    view.options.onEnter(view.items[1],{},quality?{player:'infuse',quality}:undefined);
    const added=rt.requests.slice(count);
    assert.equal(added.length,2,'only item refresh and selected exact-file resolution');
    return {resolve:added.find(r=>r.url.includes('/media-video-link?')),refresh:added.find(r=>r.url.endsWith('/items/22'))};
  }
  return {rt,view,src,item,before,start};
}
function fresh(item) {return JSON.parse(JSON.stringify(item));}
function urls(rt) {return new URL(rt.launches[0]).searchParams;}

for(const order of ['file-first','item-first']) test('episode '+order+': overlaps two requests, verifies metadata and preserves signed URL and list',()=>{
  const f=fixture(),{rt,item}=f,{resolve,refresh}=f.start();
  assert.equal(new URL(resolve.url).searchParams.get('file'),'/fixture/s1e2-1080.mp4');
  assert.equal(new URL(resolve.url).searchParams.get('type'),'http');
  const updated=fresh(item);updated.seasons[0].episodes[2].files[0].urls.http='https://video.example/fresh/3?sig=next%2B';
  if(order==='file-first') {resolve.ok(JSON.stringify({url:signed}));assert.equal(rt.launches.length,0);refresh.ok({item:updated});}
  else {refresh.ok({item:updated});assert.equal(rt.launches.length,0);resolve.ok({url:signed});}
  assert.equal(rt.launches.length,1);
  assert.deepEqual(urls(rt).getAll('url'),[signed,'https://video.example/fresh/3?sig=next%2B']);
  assert.deepEqual(urls(rt).getAll('position'),['37','37']);
  assert.deepEqual(urls(rt).getAll('sub'),['https://subs.example/2.srt?sig=a+b%26','https://subs.example/3.srt?sig=a+b%26']);
  assert.equal(rt.requests.length,3,'one initial item load plus the two launch requests');
  assert.equal(rt.mediaRequests.length,0);assert.equal(rt.internal.length,0);
  assert.deepEqual(rt.storage,f.before);
  assert.equal(rt.timers.size,0);
});
test('explicit episode quality resolves that file and keeps the same quality for later episodes',()=>{
  const f=fixture(),{resolve,refresh}=f.start('720p');
  assert.equal(new URL(resolve.url).searchParams.get('file'),'/fixture/s1e2-720.mp4');
  refresh.ok({item:f.item});resolve.ok({url:signed});
  assert.deepEqual(urls(f.rt).getAll('url'),[signed,'https://video.example/old/3/720']);
  assert.deepEqual(f.rt.storage,f.before);
});
for(const earlyFailure of [false,true]) test('changed fresh file discards early '+(earlyFailure?'error':'success')+' and resolves the verified file once',()=>{
  const f=fixture(),{resolve,refresh}=f.start(),updated=fresh(f.item);
  updated.seasons[0].episodes[1].files[0].file='/fixture/replacement.mp4';
  if(earlyFailure) resolve.fail({status:404});else resolve.ok({url:signed+'&obsolete=1'});
  refresh.ok({item:updated});
  const correct=f.rt.requests.at(-1);
  assert.equal(new URL(correct.url).searchParams.get('file'),'/fixture/replacement.mp4');
  assert.equal(resolve.cleared,true);assert.equal(f.rt.launches.length,0);
  correct.ok({url:signed});resolve.ok({url:signed+'&late=1'});
  assert.equal(f.rt.launches.length,1);assert.equal(urls(f.rt).get('url'),signed);
});
test('changed file cancels a pending early request; its late callback cannot replace the fresh result',()=>{
  const f=fixture(),{resolve,refresh}=f.start(),updated=fresh(f.item);
  updated.seasons[0].episodes[1].files[0].file='/fixture/replacement.mp4';
  refresh.ok({item:updated});const correct=f.rt.requests.at(-1);
  resolve.ok({url:signed+'&obsolete=1'});assert.equal(f.rt.launches.length,0);
  correct.ok({url:signed});assert.equal(urls(f.rt).get('url'),signed);
});
test('missing explicit quality fails without accepting the already resolved higher/lower file',()=>{
  const f=fixture(),{resolve,refresh}=f.start('1080p'),updated=fresh(f.item);
  updated.seasons[0].episodes[1].files=updated.seasons[0].episodes[1].files.slice(1);
  resolve.ok({url:signed});refresh.ok({item:updated});
  assert.equal(f.rt.launches.length,0);assert.equal(f.rt.notices.length,1);
  assert.equal(f.rt.requests.length,3);assert.equal(resolve.cleared,true);
});
test('both API requests returning 401 cannot race two refresh grants',()=>{
  const f=fixture(),{resolve,refresh}=f.start();
  resolve.fail({status:401});
  assert.equal(f.rt.requests.filter(r=>r.url.endsWith('/oauth2/token')).length,0);
  refresh.fail({status:401});
  const grant=f.rt.requests.at(-1);assert.ok(grant.url.endsWith('/oauth2/token'));
  grant.ok({access_token:'fresh-fixture',refresh_token:'new-refresh-fixture'});
  const retryItem=f.rt.requests.at(-1);assert.ok(retryItem.url.endsWith('/items/22'));
  retryItem.ok({item:f.item});const retryFile=f.rt.requests.at(-1);
  assert.ok(retryFile.url.includes('/media-video-link?'));
  retryFile.ok({url:signed});
  assert.equal(f.rt.requests.filter(r=>r.url.endsWith('/oauth2/token')).length,1);
  assert.equal(f.rt.launches.length,1);assert.equal(f.rt.storage.kp_token,'fresh-fixture');
});
test('file-only 401 defers its ordinary auth refresh until item validation',()=>{
  const f=fixture(),{resolve,refresh}=f.start();
  resolve.fail({status:401});assert.equal(f.rt.requests.length,3);
  refresh.ok({item:f.item});const retryFile=f.rt.requests.at(-1);
  retryFile.fail({status:401});const grant=f.rt.requests.at(-1);
  assert.ok(grant.url.endsWith('/oauth2/token'));
  grant.ok({access_token:'fresh-fixture'});f.rt.requests.at(-1).ok({url:signed});
  assert.equal(f.rt.launches.length,1);
  assert.equal(f.rt.requests.filter(r=>r.url.endsWith('/oauth2/token')).length,1);
});
for(const phase of ['before-item','after-item']) test('timeout '+phase+' cancels both requests and ignores late completion',()=>{
  const f=fixture(),{resolve,refresh}=f.start();
  if(phase==='after-item') refresh.ok({item:f.item});
  f.rt.tickAll();resolve.ok({url:signed});refresh.ok({item:f.item});
  assert.equal(f.rt.launches.length,0);assert.equal(f.rt.notices.length,1);
  assert.equal(resolve.cleared,true);assert.equal(refresh.cleared,true);
});
test('closing source cancels both requests; repeated presses and callbacks hand off once',()=>{
  const f=fixture(),{resolve,refresh}=f.start();
  f.view.options.onEnter(f.view.items[1]);assert.equal(f.rt.requests.length,3);
  refresh.ok({item:f.item});refresh.ok({item:f.item});
  resolve.ok({url:signed});resolve.ok({url:signed});resolve.fail({status:404});
  assert.equal(f.rt.launches.length,1);assert.equal(f.rt.notices.length,0);
  const g=fixture(),pending=g.start();g.src.destroy();
  pending.resolve.ok({url:signed});pending.refresh.ok({item:g.item});
  assert.equal(g.rt.launches.length,0);assert.equal(pending.resolve.cleared,true);
  assert.equal(pending.refresh.cleared,true);
});
for(const value of [null,'https://video.example/hls4/master.m3u8']) test('invalid early resource '+value+' fails without falling back to cached item URL',()=>{
  const f=fixture(),{resolve,refresh}=f.start();
  resolve.ok({url:value});refresh.ok({item:f.item});
  assert.equal(f.rt.launches.length,0);assert.equal(f.rt.notices.length,1);
  assert.match(f.rt.notices[0],/KP-I2/);assert.equal(f.rt.requests.length,3);
});
test('item identity mismatch and exact-file error abort without launching another episode',()=>{
  const f=fixture(),{resolve,refresh}=f.start();
  resolve.ok({url:signed});refresh.ok({item:{...f.item,id:23}});
  assert.equal(f.rt.launches.length,0);assert.equal(f.rt.notices.length,1);
  const g=fixture(),requests=g.start();requests.refresh.ok({item:g.item});requests.resolve.fail({status:404});
  assert.equal(g.rt.launches.length,0);assert.match(g.rt.notices[0],/KP-I2 HTTP 404/);
});
