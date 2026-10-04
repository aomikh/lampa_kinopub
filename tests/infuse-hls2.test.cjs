'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {runtime} = require('./runtime.cjs');

// Fictional paths/signatures only. An HLS resolver URL can end in .mp4.
const hls = 'https://video.example/hls2/private-fixture/movie.mp4?sig=a%2Bb%2Fc%3D&key=a+b%25&loc=de&preload=1&x=?%26=';
const http = 'https://video.example/http/private-fixture/movie.mp4?sig=dummy';
const file = '/private-fixture/movie-2160.mp4';
const rtOptions = {storage:{kp_token:'dummy-fixture',kp_max_quality:'2160',player:'vlc'}};
function fixture(rt, {serial=false, references=true, entries}={}) {
  const files = entries || [2160,1080].map(q=>({quality:q+'p',
    ...(references ? {file:q===2160 ? file : '/private-fixture/movie-1080.mp4'} : {}),
    urls:{http:http+'&q='+q,hls2:hls+'&q='+q,hls4:'https://video.example/hls4/master.m3u8'}}));
  const video = {files,subtitles:[{url:'https://subs.example/sub.srt?sig=a+b%2F',lang:'en'}]};
  const item = serial ? {id:22,title:'Fixture',seasons:[{number:'1',episodes:[
    {number:'1',...video},{number:'2',...video}]}]} : {id:22,title:'Fixture',videos:[video]};
  const view = {reset(){},loading(){},filter(){},doesNotAnswer(){throw Error('fixture source error');},
    draw(items,options){this.items=items;this.options=options;}};
  const src = new rt.api.kpapi(view,{movie:{id:111,title:'Fixture',name:serial?'Fixture':undefined}});
  src.find(22);rt.requests.at(-1).ok({item});
  return {src,view,item};
}
function launch(view, options={}) {
  view.options.onEnter(view.items[0],{}, {player:'infuse',delivery:'hls2',...options});
}
function menu(rt) {
  const calls=[],c=new rt.api.component({movie:{id:111,title:'Fixture'}});
  c.draw([{title:'Fixture',kp:{kind:'movie',files:[],audios:[]}}],{
    onEnter:(item,html,options)=>calls.push(options),onContextMenu:(item,html,options,cb)=>cb({})});
  rt.rows.at(-1).trigger('hover:long');
  const actions=rt.menus.at(-1),choice=actions.items.find(x=>x.infuseHls2Test);
  return {c,calls,actions,choice};
}

test('HLS2 is an explicit one-off Apple action, without changing storage or a second menu',()=>{
  const rt=runtime(rtOptions),{calls,actions,choice}=menu(rt);
  assert.ok(choice);actions.onBack();assert.equal(calls.length,0);
  actions.onSelect(choice);
  assert.equal(calls.length,1);assert.equal(calls[0].player,'infuse');
  assert.equal(calls[0].delivery,'hls2');assert.equal(calls[0].quality,undefined);
  assert.equal(rt.menus.length,1);assert.equal(rt.requests.length,0);
  assert.equal(rt.storage.player,'vlc');assert.equal(rt.storage.kp_format,'auto');
  assert.equal(rt.storage.kp_max_quality,'2160');
  assert.equal(menu(runtime({platform:'tizen'})).choice,undefined);
});
test('closed or replaced card cannot use its old HLS2 action',()=>{
  for(const operation of ['destroy','reset']) {
    const rt=runtime(rtOptions),{c,calls,actions,choice}=menu(rt);
    c[operation]();actions.onSelect(choice);assert.equal(calls.length,0);
  }
});
test('exact maximum file gets one fresh HLS2 resolver request, preserving signature, position and subtitles',()=>{
  const rt=runtime({storage:{...rtOptions.storage,kp_subtitles_enabled:true}});rt.api.setProxy(true);rt.api.setFormat('hls4');
  const {view}=fixture(rt);let marks=0;view.items[0].mark=()=>marks++;
  view.items[0].timeline={time:83.9};launch(view);
  const request=rt.requests.at(-1),params=new URL(request.url).searchParams;
  assert.equal(new URL(request.url).pathname,'/v1/items/media-video-link');
  assert.equal(params.get('type'),'hls2');assert.equal(params.get('file'),file);
  request.ok({url:hls});
  const result=new URL(rt.launches[0]);
  assert.equal(result.pathname,'/play');assert.equal(result.searchParams.get('url'),hls);
  assert.equal(result.searchParams.get('position'),'83');
  assert.doesNotMatch(result.searchParams.get('filename'),/\.(mp4|mkv)$/);
  assert.equal(result.searchParams.get('sub'),'https://subs.example/sub.srt?sig=a+b%2F');
  assert.equal(result.searchParams.has('playlist'),false);assert.equal(result.searchParams.has('x-success'),false);
  assert.equal(rt.requests.length,2);assert.equal(rt.mediaRequests.length,0);
  assert.equal(rt.internal.length,0);assert.equal(marks,0);assert.equal(rt.api.getPendingVoice(),null);
  assert.doesNotMatch(JSON.stringify(rt.logs),/private-fixture|sig=a/);
});
test('normal Infuse and VLC remain independent after the HLS2 test',()=>{
  const rt=runtime(rtOptions),{view}=fixture(rt);launch(view);rt.requests.at(-1).ok({url:hls});
  view.options.onEnter(view.items[0],{}, {player:'infuse'});
  assert.equal(new URL(rt.requests.at(-1).url).searchParams.get('type'),'http');
  rt.requests.at(-1).ok({url:http});assert.equal(new URL(rt.launches[1]).searchParams.get('url'),http);
  view.options.onEnter(view.items[0]);
  assert.equal(rt.internal.length,1);assert.equal(rt.internal[0].url,hls+'&q=2160');
  assert.equal(rt.api.preferredFormat('infuse'),'http');assert.equal(rt.storage.player,'vlc');
});
test('URL-only response is refreshed and actual urls.hls2 is preserved, even with an mp4 path',()=>{
  const rt=runtime(rtOptions),{view,item}=fixture(rt,{references:false});launch(view);
  assert.equal(new URL(rt.requests.at(-1).url).pathname,'/v1/items/22');
  const fresh=structuredClone(item);fresh.videos[0].files[0].urls.hls2=hls+'&fresh=1';
  rt.requests.at(-1).ok({item:fresh});
  assert.equal(new URL(rt.launches[0]).searchParams.get('url'),hls+'&fresh=1');
  assert.equal(rt.requests.length,2);
});
test('missing maximum HLS2 fails without choosing lower HLS2, HTTP or HLS4',()=>{
  const rt=runtime(rtOptions),{view}=fixture(rt,{entries:[
    {quality:'2160p',urls:{http,hls4:'https://video.example/hls4/master.m3u8'}},
    {quality:'1080p',urls:{hls2:hls}}
  ]});launch(view);
  assert.equal(rt.launches.length,0);assert.equal(rt.requests.length,1);
  assert.match(rt.notices.at(-1),/kp_infuse_no_hls2/);
});
test('explicit quality is exact and the saved quality limit still applies',()=>{
  const rt=runtime(rtOptions),{view}=fixture(rt);launch(view,{quality:'1080p'});
  assert.equal(new URL(rt.requests.at(-1).url).searchParams.get('file'),'/private-fixture/movie-1080.mp4');
  rt.requests.at(-1).ok({url:hls});
  launch(view,{quality:'480p'});assert.equal(rt.requests.length,2);assert.equal(rt.launches.length,1);
  rt.storage.kp_max_quality='1080';launch(view);
  assert.equal(new URL(rt.requests.at(-1).url).searchParams.get('file'),'/private-fixture/movie-1080.mp4');
});
test('HLS2 test refreshes only the selected episode and sends no season playlist',()=>{
  const rt=runtime(rtOptions),{view,item}=fixture(rt,{serial:true});
  view.items[1].timeline={time:37};
  // Mixed string/number episode and season identifiers must still match.
  view.options.onEnter(view.items[1],{}, {player:'infuse',delivery:'hls2'});
  const fresh=structuredClone(item);fresh.seasons[0].number=1;fresh.seasons[0].episodes[1].number=2;
  rt.requests.at(-1).ok({item:fresh});rt.requests.at(-1).ok({url:hls+'&episode=2'});
  const params=new URL(rt.launches[0]).searchParams;
  assert.deepEqual(params.getAll('url'),[hls+'&episode=2']);assert.match(params.get('filename'),/s1e02/);
  assert.equal(params.get('position'),'37');assert.equal(rt.requests.length,3);
});
test('refresh cannot replace the selected episode file or selected quality',()=>{
  for(const change of ['file','quality','identity']) {
    const rt=runtime(rtOptions),{view,item}=fixture(rt,{serial:true});launch(view);
    const fresh=structuredClone(item);
    if(change==='identity')fresh.id=999;
    else fresh.seasons[0].episodes[0].files[0][change]=change==='file'?'/different/2160.mp4':'1080p';
    rt.requests.at(-1).ok({item:fresh});
    assert.equal(rt.launches.length,0);assert.equal(rt.requests.length,2);
  }
});
test('HLS is accepted only for the explicit test; incompatible known paths and mixed playlists are rejected',()=>{
  const rt=runtime();
  assert.equal(rt.api.buildInfuseUrl({_kpInfuse:true,url:hls}),null);
  for(const url of ['https://video.example/hls4/master.m3u8','https://video.example/hls/master.m3u8',
    'https://kinopub.fastcdn.pics/manifest-proxy?url=fake','https://video.example/master.mpd',http]) {
    assert.equal(rt.api.buildInfuseUrl({_kpInfuse:true,_kpInfuseHls2Test:true,url}),null);
  }
  const play={_kpInfuse:true,_kpInfuseHls2Test:true,url:hls};
  play.playlist=[play,{_kpInfuse:true,url:http}];
  assert.deepEqual(new URL(rt.api.buildInfuseUrl(play)).searchParams.getAll('url'),[hls]);
  assert.equal(new URL(rt.api.buildInfuseUrl({...play,url:'https://video.example/hls2/master.m3u8'})).searchParams.get('url'),
    'https://video.example/hls2/master.m3u8');
});
test('resolver failure, timeout, cancellation and wrong resource never retry or launch a stale URL',()=>{
  for(const action of ['error','timeout','close','wrong']) {
    const rt=runtime(rtOptions),{src,view}=fixture(rt);launch(view);const request=rt.requests.at(-1);
    if(action==='error') request.fail({status:403});
    if(action==='timeout') rt.tickAll();
    if(action==='close') src.destroy();
    if(action==='wrong') request.ok({url:'https://video.example/hls4/master.m3u8'});
    request.ok({url:hls});rt.tickAll();
    assert.equal(rt.launches.length,0);assert.equal(rt.internal.length,0);assert.equal(rt.requests.length,2);
  }
});
test('duplicate resolver callbacks and a failed app handoff never start a second player',()=>{
  for(const dispatchError of [false,true]) {
    const rt=runtime({...rtOptions,dispatchError}),{view}=fixture(rt);launch(view);
    const request=rt.requests.at(-1);request.ok({url:hls});request.ok({url:hls});rt.tickAll();
    assert.equal(rt.launches.length,dispatchError?0:1);assert.equal(rt.internal.length,0);
    assert.equal(rt.requests.length,2);
  }
});
test('HLS diagnostics replace a previous file attempt without probing a manifest as a movie',()=>{
  let fetches=0;const rt=runtime({fetch:()=>{fetches++;throw Error('unexpected media probe');}});
  rt.api.dispatchInfuse({_kpInfuse:true,url:http});
  rt.api.dispatchInfuse({_kpInfuse:true,_kpInfuseHls2Test:true,url:hls,_kpQuality:2160});
  rt.api.showInfuseDiagnostic();
  const modal=rt.modals.at(-1);assert.match(modal.html.value,/Delivery: hls2-test/);
  assert.match(modal.html.value,/kp_infuse_hls2_limits/);assert.doesNotMatch(modal.html.value,/private-fixture|sig=/);
  modal.onBack();rt.tickAll();assert.equal(fetches,0);assert.equal(rt.mediaRequests.length,0);
});
