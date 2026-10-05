'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {runtime}=require('./runtime.cjs');

// Fictional signatures only. The selected address must survive exactly one
// encoding layer, including an encoded nested URL and signed query values.
const signed='https://video.example/private-fixture/hls2/movie.mp4?sig=a+b%26%2F%25&preload=1&x=?=&nested=https%3A%2F%2Fexample.test%2Fp%3Fa%3D1';
function fixture(options={}, serial=false) {
  const rt=runtime({...options,storage:{kp_token:'fixture-token',player:'vlc',kp_max_quality:'1080',kp_launch_trace:true,...options.storage}});
  const view={reset(){},loading(){},filter(){},draw(items,callbacks){this.items=items;this.callbacks=callbacks;}};
  const files=[2160,1080].map(q=>({quality:q+'p',file:'/private-fixture/movie-'+q+'.mp4',urls:{
    http:'https://video.example/private-fixture/http/movie-'+q+'.mp4?sig=direct',
    hls:signed+'&delivery=hls&q='+q,hls2:signed+'&q='+q,hls4:signed+'&delivery=hls4&q='+q}}));
  const video={files,audios:[{index:1,lang:'ru'}],subtitles:[{lang:'ru',url:'https://sub.example/private-fixture/sub.srt?sig=private'}]};
  const item={id:22,year:2024,title:'Fixture',...(serial?{seasons:[{number:1,episodes:[1,2].map(number=>({number,...video,files:files.map(f=>({...f,urls:Object.fromEntries(Object.entries(f.urls).map(([k,u])=>[k,u+'&ep='+number]))}))}))}]}:{videos:[video]})};
  const src=new rt.api.kpapi(view,{movie:{id:11,title:'Fixture',name:serial?'Fixture':undefined}});
  src.find(22);rt.requests.at(-1).ok({item});
  let marks=0;
  view.items.forEach(i=>{i.timeline={time:127};i.mark=()=>marks++;});
  function enter(player='infuse', extra={}, index=0) {
    view.callbacks.onEnter(view.items[index],{}, {player,...(player==='infuse'?{delivery:'vlc-source'}:{}),...extra});
  }
  return {rt,view,src,item,enter,marks:()=>marks,report:()=>JSON.parse(JSON.stringify(rt.api.LaunchTrace.snapshot()))};
}

for(const format of ['auto','hls','hls2','hls4','http']) {
  test('Infuse comparison uses the exact VLC selection for '+format+' without resolver/metadata work',()=>{
    const f=fixture({storage:{kp_format:format,kp_subtitles_enabled:true}});
    const before=JSON.stringify(f.rt.storage);
    f.enter('vlc');f.enter();
    assert.equal(f.rt.internal.length,1);assert.equal(f.rt.launches.length,1);
    const result=new URL(f.rt.launches[0]);
    assert.equal(result.protocol,'infuse:');assert.equal(result.pathname,'/play');
    assert.deepEqual([...result.searchParams.keys()],['url']);
    assert.equal(result.searchParams.get('url'),f.rt.internal[0].url);
    assert.equal(f.rt.requests.length,1); // only the original item request
    assert.equal(f.rt.mediaRequests.length,0);assert.equal(f.marks(),0);
    assert.equal(JSON.stringify(f.rt.storage),before);
    const [vlc,infuse]=f.report();
    assert.equal(vlc.file,infuse.file);assert.equal(vlc.output,infuse.output);
    assert.equal(infuse.input,infuse.output);assert.equal(infuse.mode,'vlc-source');
    assert.equal(infuse.delivery,format==='auto'?'hls2':format);
    assert.equal(infuse.item_ms,null);assert.equal(infuse.link_ms,null);
    assert.equal(infuse.entries,1);assert.equal(infuse.position,null);
    assert.equal(infuse.status,'submitted');assert.equal(f.rt.api.getPendingVoice(),null);
    assert.doesNotMatch(JSON.stringify(f.rt.logs),/private-fixture|sig=|nested=|fixture-token/);
  });
}

test('loaded episode address is sent as one video, without refreshing the season or sending resume/subtitles',()=>{
  const f=fixture({storage:{kp_subtitles_enabled:true}},true);
  f.enter('vlc',{},1);f.enter('infuse',{},1);
  const p=new URL(f.rt.launches[0]).searchParams;
  assert.equal(p.get('url'),f.rt.internal[0].url);assert.match(p.get('url'),/&ep=2$/);
  assert.equal(p.getAll('url').length,1);assert.equal(p.has('playlist'),false);
  assert.equal(p.has('position'),false);assert.equal(p.has('sub'),false);
  assert.equal(p.has('filename'),false);assert.equal(f.rt.requests.length,1);
  assert.equal(f.report().at(-1).episode,2);assert.equal(f.view.items[1].timeline.time,127);
});

test('shared selection honors explicit quality, saved cap, fallback field and format override',()=>{
  const f=fixture({storage:{kp_max_quality:'2160'}});
  f.enter('vlc',{quality:'1080p'});f.enter('infuse',{quality:'1080p'});
  assert.equal(new URL(f.rt.launches[0]).searchParams.get('url'),f.rt.internal[0].url);
  f.enter('infuse',{quality:'720p'});assert.equal(f.rt.launches.length,1);
  f.rt.storage.kp_max_quality='480';f.enter();assert.equal(f.rt.launches.length,1);
  f.rt.storage.kp_max_quality='1080';
  delete f.view.items[0].kp.files.find(x=>x.quality===1080).urls.hls2;
  f.enter('vlc');f.enter();
  assert.equal(f.report().at(-1).delivery,'hls4');
  assert.equal(new URL(f.rt.launches[1]).searchParams.get('url'),f.rt.internal[1].url);
  f.rt.api.setFormat('hls');f.enter('vlc');f.enter();
  assert.equal(f.report().at(-1).delivery,'hls');
  assert.equal(new URL(f.rt.launches[2]).searchParams.get('url'),f.rt.internal[2].url);
});

test('switching to the comparison cancels an outstanding normal Infuse resolution',()=>{
  const f=fixture();f.enter('infuse',{delivery:undefined});const late=f.rt.requests.at(-1);
  f.enter();assert.equal(f.rt.launches.length,1);
  late.ok({url:'https://video.example/other-file.mp4'});f.rt.tickAll();
  assert.equal(f.rt.launches.length,1);assert.equal(f.rt.internal.length,0);
  assert.equal(f.report()[0].status,'cancelled');
});

test('normal Infuse after comparison still resolves a fresh direct file and retains resume/subtitles',()=>{
  const f=fixture({storage:{kp_subtitles_enabled:true}});f.enter();
  f.enter('infuse',{delivery:undefined});
  assert.equal(new URL(f.rt.requests.at(-1).url).searchParams.get('type'),'http');
  f.rt.requests.at(-1).ok({url:'https://video.example/current.mp4?sig=a+b%26'});
  const p=new URL(f.rt.launches[1]).searchParams;
  assert.equal(p.get('position'),'127');assert.ok(p.get('sub'));assert.ok(p.get('filename'));
  assert.equal(f.report().at(-1).mode,'standard');assert.equal(f.rt.storage.player,'vlc');
});

test('comparison diagnostic does not probe HLS or invent a file-size verdict',()=>{
  let fetches=0;const f=fixture({fetch:()=>{fetches++;throw Error('unexpected');}});
  f.enter();f.rt.api.showInfuseDiagnostic();
  const report=f.rt.modals.at(-1).html.value;
  assert.match(report,/Delivery: hls2 \/ mode: vlc-source/);
  assert.match(report,/kp_infuse_vlc_limits/);assert.doesNotMatch(report,/private-fixture|sig=/);
  f.rt.modals.at(-1).onBack();f.rt.tickAll();assert.equal(fetches,0);
});

test('dispatch failure, unavailable resource and destroyed source never fall back to another player',()=>{
  const f=fixture({dispatchError:true});assert.doesNotThrow(()=>f.enter());
  assert.equal(f.rt.launches.length,0);assert.equal(f.report()[0].status,'dispatch-error');
  assert.equal(f.rt.internal.length,0);assert.equal(f.rt.requests.length,1);
  const missing=fixture();missing.view.items[0].kp.files=[];missing.enter();
  assert.equal(missing.rt.launches.length,0);assert.equal(missing.rt.requests.length,1);
  const closed=fixture();closed.src.destroy();closed.enter();assert.equal(closed.rt.launches.length,0);
  for(const platform of ['tizen','apple','webos']) {
    const other=fixture({platform});other.enter();
    assert.equal(other.rt.launches.length,0);assert.equal(other.rt.requests.length,1);
  }
});

test('comparison builder rejects invalid/oversized URLs and ignores any supplied playlist',()=>{
  const rt=runtime();
  for(const url of ['file:///private/video.mp4','javascript:alert(1)','https://video.example/a b','https://video.example/'+ 'x'.repeat(65536)])
    assert.equal(rt.api.buildInfuseUrl({_kpInfuse:true,_kpInfuseVlcSource:true,url}),null);
  const play={_kpInfuse:true,_kpInfuseVlcSource:true,url:signed};
  play.playlist=[play,{url:'https://video.example/other.mp4'}];
  assert.deepEqual(new URL(rt.api.buildInfuseUrl(play)).searchParams.getAll('url'),[signed]);
});

test('Apple TV menu launches one-off comparison without changing settings; stale menu and other platforms cannot',()=>{
  for(const platform of ['apple_tv','apple','tizen']) {
    const rt=runtime({platform}),calls=[];
    const c=new rt.api.component({movie:{id:11,title:'Fixture'}});
    c.draw([{title:'Fixture',quality:'1080p',kp:{kind:'movie',files:[],audios:[]}}],{
      onEnter:(_i,_h,o)=>calls.push(o),onContextMenu:(_i,_h,_o,cb)=>cb({})});
    rt.rows.at(-1).trigger('hover:long');
    const menu=rt.menus.at(-1),choice=menu.items.find(x=>x.infuseVlcSource);
    if(platform!=='apple_tv') {assert.equal(choice,undefined);continue;}
    assert.ok(choice);menu.onSelect(choice);
    assert.equal(calls.length,1);assert.equal(calls[0].delivery,'vlc-source');
    assert.equal(calls[0].player,'infuse');assert.equal(rt.storage.player,'inner');
    c.reset();menu.onSelect(choice);assert.equal(calls.length,1);
    assert.equal(rt.requests.length,0);
  }
});
