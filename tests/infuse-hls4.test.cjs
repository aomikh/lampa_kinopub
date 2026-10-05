'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {runtime}=require('./runtime.cjs');

// Only synthetic media, signatures and credentials; no real film requests.
const hls='https://video.example/hls4/private-fixture/master.m3u8?sig=a+b%26%2F%25&preload=1&nested=https%3A%2F%2Fexample.test%2Fa%3Fx%3D1';
const direct='https://video.example/http/private-fixture/movie.mp4?sig=file';
function fixture({serial=false,references=true,files, ...options}={}) {
  const rt=runtime({...options,storage:{kp_token:'fixture-token',player:'infuse',kp_max_quality:'1080',kp_launch_trace:true,...options.storage}});
  const entries=files || [2160,1080,720].map(q=>({quality:q+'p',...(references?{file:'/private-fixture/'+q+'.mp4'}:{}),
    urls:{http:direct+'&q='+q,hls2:'https://video.example/hls2/private-fixture/'+q+'.mp4',hls4:hls+'&q='+q}}));
  const video={files:entries,subtitles:[{lang:'ru',url:'https://subs.example/sub.srt?sig=a+b%26'}]};
  const item={id:22,title:'Fixture',...(serial?{seasons:[{number:1,episodes:[1,2].map(number=>({number,...video}))}]}:{videos:[video]})};
  const view={reset(){},loading(){},filter(){},draw(items,options){this.items=items;this.options=options;}};
  const src=new rt.api.kpapi(view,{movie:{id:11,title:'Fixture',...(serial?{name:'Fixture'}:{})}});
  src.find(22);rt.requests.at(-1).ok({item});
  let marks=0;
  view.items.forEach(i=>{i.timeline={time:127.9};i.mark=()=>marks++;});
  return {rt,src,view,item,marks:()=>marks,enter:(options={},index=0)=>view.options.onEnter(view.items[index],{},options),
    params:()=>new URL(rt.launches.at(-1)).searchParams};
}

test('ordinary Apple Infuse defaults to HLS4 independently of shared format and proxy',()=>{
  for(const platform of ['apple_tv','apple']) {
    const f=fixture({platform,storage:{kp_format:'http',kp_subtitles_enabled:true}});
    f.rt.api.setProxy(true);f.rt.api.setFormat('hls2');
    assert.equal(f.rt.api.preferredFormat('infuse'),'hls4');
    assert.equal('kp_infuse_delivery' in f.rt.storage,false);
    f.enter();
    const request=f.rt.requests.at(-1),params=new URL(request.url).searchParams;
    assert.equal(params.get('type'),'hls4');assert.equal(params.get('file'),'/private-fixture/1080.mp4');
    assert.equal(f.rt.requests.length,2);
    request.ok({url:hls});
    assert.equal(f.params().get('url'),hls);assert.equal(f.params().get('position'),'127');
    assert.equal(f.params().get('sub'),'https://subs.example/sub.srt?sig=a+b%26');
    assert.doesNotMatch(f.params().get('filename'),/\.(mp4|mkv)$/);
    assert.deepEqual(f.params().getAll('url'),[hls]);assert.equal(f.rt.internal.length,0);
    assert.equal(f.rt.mediaRequests.length,0);assert.equal(f.marks(),0);
    assert.equal(f.rt.api.getPendingVoice(),null);
    const report=f.rt.api.LaunchTrace.snapshot().at(-1);
    assert.equal(report.delivery,'hls4');assert.equal(report.mode,'hls4');assert.equal(report.status,'submitted');
    assert.doesNotMatch(JSON.stringify(f.rt.logs),/private-fixture|fixture-token|sig=/);
  }
});

test('a signed HLS4 API entry point ending in mp4 is preserved, never renamed',()=>{
  const f=fixture();f.enter();
  const url='https://api.service-kp.com/hls4/client/private-fixture/movie.mp4?sig=a+b%26&loc=de';
  f.rt.requests.at(-1).ok({url});assert.equal(f.params().get('url'),url);
  assert.doesNotMatch(f.params().get('filename'),/\.mp4$/);
});

test('URL-only metadata refresh uses its real hls4 field, not the http/hls2 alternatives',()=>{
  const f=fixture({references:false});f.enter();
  assert.equal(new URL(f.rt.requests.at(-1).url).pathname,'/v1/items/22');
  f.item.videos[0].files[1].urls.hls4=hls+'&fresh=1';
  f.rt.requests.at(-1).ok({item:f.item});
  assert.equal(f.params().get('url'),hls+'&fresh=1');assert.equal(f.rt.requests.length,2);
});

test('selected episode keeps its identity, requested quality and resume; only one video is handed off',()=>{
  const f=fixture({serial:true});f.enter({quality:'720p'},1);
  f.item.seasons[0].episodes[1].files.unshift({quality:'720p',file:'/private-fixture/replacement.mp4',urls:{hls4:hls}});
  f.rt.requests.at(-1).ok({item:f.item});
  const p=new URL(f.rt.requests.at(-1).url).searchParams;
  assert.equal(p.get('file'),'/private-fixture/720.mp4');assert.equal(p.get('type'),'hls4');
  f.rt.requests.at(-1).ok({url:hls+'&episode=2'});
  assert.deepEqual(f.params().getAll('url'),[hls+'&episode=2']);assert.match(f.params().get('filename'),/s1e02/);
  assert.equal(f.params().get('position'),'127');assert.equal(f.rt.requests.length,3);
});

test('missing selected HLS4 never falls back to file, HLS2, a lower quality, or an over-limit quality',()=>{
  for(const entries of [
    [{quality:'1080p',urls:{http:direct,hls2:hls}},{quality:'720p',urls:{hls4:hls}}],
    [{quality:'2160p',file:'/private-fixture/4k.mp4',urls:{hls4:hls}}]
  ]) {
    const f=fixture({files:entries});f.enter();
    assert.equal(f.rt.requests.length,1);assert.equal(f.rt.launches.length,0);
    assert.match(f.rt.notices.at(-1),/kp_infuse_no_hls4/);
  }
  const exact=fixture();exact.enter({quality:'480p'});
  assert.equal(exact.rt.requests.length,1);assert.equal(exact.rt.launches.length,0);
});

test('a file reference can resolve HLS4 even when old metadata has no HLS4 URL',()=>{
  const f=fixture({files:[{quality:'1080p',file:'/private-fixture/1080.mp4',urls:{http:direct}}]});
  f.enter();assert.equal(new URL(f.rt.requests.at(-1).url).searchParams.get('type'),'hls4');
  f.rt.requests.at(-1).ok({url:hls});assert.equal(f.params().get('url'),hls);
});

test('errors, wrong known delivery, cancellation and timeout do not launch a file or stale request',()=>{
  for(const action of ['error','wrong','timeout','destroy','switch']) {
    const f=fixture();f.enter();const pending=f.rt.requests.at(-1);
    if(action==='error')pending.fail({status:403});
    if(action==='wrong')pending.ok({url:direct});
    if(action==='timeout')f.rt.tickAll();
    if(action==='destroy')f.src.destroy();
    if(action==='switch')f.enter({player:'vlc'});
    pending.ok({url:hls});f.rt.tickAll();
    assert.equal(f.rt.launches.length,0);assert.equal(f.rt.requests.length,2);
    assert.equal(f.rt.internal.length,action==='switch'?1:0);
  }
});

test('duplicate actions/callbacks and app-dispatch failures never start a second player',()=>{
  for(const dispatchError of [false,true]) {
    const f=fixture({dispatchError});f.enter();f.enter();const pending=f.rt.requests.at(-1);
    pending.ok({url:hls});pending.ok({url:hls});
    assert.equal(f.rt.requests.length,2);assert.equal(f.rt.launches.length,dispatchError?0:1);
    assert.equal(f.rt.internal.length,0);
  }
});

test('HLS4 diagnostics never run file-size/range probes against a manifest',()=>{
  let fetches=0;const f=fixture({fetch:()=>{fetches++;throw Error('unexpected fetch');}});
  f.enter();f.rt.requests.at(-1).ok({url:hls});f.rt.api.showInfuseDiagnostic();
  const modal=f.rt.modals.at(-1);
  assert.match(modal.html.value,/Delivery: hls4 \/ mode: hls4/);
  assert.match(modal.html.value,/kp_infuse_hls4_limits/);assert.doesNotMatch(modal.html.value,/sig=|private-fixture/);
  modal.onBack();f.rt.tickAll();assert.equal(fetches,0);
});

test('file-mode selection is reversible and does not alter shared format, player or quality',()=>{
  const f=fixture();const before=JSON.stringify(f.rt.storage);
  f.rt.storage.kp_infuse_delivery='http';f.enter();
  assert.equal(new URL(f.rt.requests.at(-1).url).searchParams.get('type'),'http');
  f.rt.requests.at(-1).ok({url:direct});assert.equal(f.params().get('url'),direct);
  f.rt.storage.kp_infuse_delivery='hls4';f.enter();
  assert.equal(new URL(f.rt.requests.at(-1).url).searchParams.get('type'),'hls4');
  f.rt.requests.at(-1).ok({url:hls});assert.equal(f.params().get('url'),hls);
  delete f.rt.storage.kp_infuse_delivery;assert.equal(JSON.stringify(f.rt.storage),before);
});

test('HLS4 quality menu starts normal Infuse with the explicit quality',()=>{
  const f=fixture();const c=new f.rt.api.component({movie:{id:11,title:'Fixture'}});
  c.draw(f.view.items,{onEnter:(item,html,options)=>f.view.options.onEnter(item,html,options),onContextMenu:(_i,_h,_o,cb)=>cb({})});
  f.rt.rows.at(-1).trigger('hover:long');let menu=f.rt.menus.at(-1);
  menu.onSelect(menu.items.find(x=>x.infuseQuality));menu=f.rt.menus.at(-1);
  assert.deepEqual(Array.from(menu.items,x=>x.quality),['1080p','720p']);
  menu.onSelect(menu.items[1]);const p=new URL(f.rt.requests.at(-1).url).searchParams;
  assert.equal(p.get('type'),'hls4');assert.equal(p.get('file'),'/private-fixture/720.mp4');
});

test('Apple settings expose HLS4 by default and explicit file mode; other platforms are unchanged',()=>{
  for(const platform of ['apple_tv','apple','tizen','webos']) {
    const rt=runtime({platform}),settings=[];
    rt.Lampa.SettingsApi={addComponent(){},addParam:p=>settings.push(p)};
    rt.api.addSettings();
    const option=settings.find(p=>p.param.name==='kp_infuse_delivery');
    if(platform==='apple_tv'||platform==='apple') {
      assert.equal(option.param.default,'hls4');assert.deepEqual(Object.keys(option.param.values),['hls4','http']);
      assert.equal(rt.api.preferredFormat('infuse'),'hls4');
    } else {assert.equal(option,undefined);assert.equal(rt.api.preferredFormat('infuse'),'http');}
  }
});
