'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {runtime} = require('./runtime.cjs');
const fixtures = require('./fixtures/infuse-hls2.json');
const clone = v => JSON.parse(JSON.stringify(v));
const signed = 'https://opaque-fixture.msk-static-05.cdntogo.net/opaque/asset?sig=a%2Bb%2Fc%3D&k=a+b%25&preload=1&x=?%26=&empty=&x=2#keep';
function setup({serial=false, storage={}, item, platform='apple_tv', ...options}={}) {
  const rt = runtime({platform, storage:{kp_token:'fake-token', player:'infuse', kp_format:'auto',
    kp_infuse_format_v1:'hls2', kp_subtitles_enabled:true, ...storage}, ...options});
  const view = {reset(){},loading(){},filter(){},draw(items, opts){this.items=items;this.options=opts;}};
  const src = new rt.api.kpapi(view, {movie:{id:111,title:'Fixture Movie',name:serial?'Fixture Series':undefined}});
  item = item || clone(fixtures[serial?'serial':'movie']);
  src.find(item.id);rt.requests.at(-1).ok({item});
  let marks=0;
  view.items.forEach((row,i)=>{row.timeline={time:137.9+i,percent:2};row.mark=()=>marks++;});
  return {rt,src,view,item,marks:()=>marks};
}
function begin(f, {index=0, quality}={}) {
  const before = f.rt.requests.length;
  f.view.options.onEnter(f.view.items[index],{}, {player:'infuse',quality});
  return {before, metadata:f.rt.requests.at(-1)};
}
function finish(f, opts={}) {
  const {before,metadata}=begin(f,opts);
  assert.equal(f.rt.requests.length,before+1);
  assert.ok(metadata.url.endsWith('/items/'+f.item.id));
  metadata.ok({item:clone(f.item)});
  const resolve=f.rt.requests.at(-1), params=new URL(resolve.url).searchParams;
  assert.equal(params.get('type'),'hls2');
  resolve.ok({url:signed});
  assert.equal(f.rt.launches.length,1);
  assert.equal(f.marks(),0,'Handoff cannot mark watched');
  return {resolve,params,data:new URL(f.rt.launches[0]).searchParams};
}

test('Auto Online selects hls2; Infuse requires opt-in and keeps the explicit file default',()=>{
  const rt=runtime({storage:{kp_format:'auto',kp_infuse_delivery:'hls4'}});
  assert.equal(rt.api.preferredFormat('tvosl'),'hls2');
  assert.equal(rt.api.preferredFormat('infuse'),'http');
  rt.storage.kp_infuse_format_v1='hls2';assert.equal(rt.api.preferredFormat('infuse'),'hls2');
  rt.api.setFormat('hls4');rt.api.setProxy(true);
  assert.equal(rt.api.preferredFormat('infuse'),'hls2');
  rt.storage.kp_infuse_format_v1='http';assert.equal(rt.api.preferredFormat('infuse'),'http');
  rt.storage.kp_infuse_format_v1='unknown';assert.equal(rt.api.preferredFormat('infuse'),null);
});
for (const quality of ['1080p','2160p']) test('fresh movie pins exact '+quality+' and uses only type=hls2',()=>{
  const f=setup({storage:{kp_max_quality:'2160'}}), {params,data}=finish(f,{quality});
  assert.equal(params.get('file'),'/fixture/movie-'+quality.slice(0,-1)+'.mp4');
  assert.equal(data.get('url'),signed);assert.equal(data.get('position'),'137');
  assert.equal(data.get('filename'),'Fixture Movie','HLS is not labelled as a direct MP4');
  assert.equal(f.rt.storage.kp_max_quality,'2160');assert.equal(f.rt.internal.length,0);
  assert.equal(f.rt.mediaRequests.length,0);assert.equal(f.rt.playlists.length,0);
  assert.deepEqual(f.rt.requests.filter(r=>r.url.includes('/media-video-link?')).map(r=>new URL(r.url).searchParams.get('type')),['hls2']);
});
test('signed opaque URL survives exactly one external encoding, including plus, duplicates and preload',()=>{
  const f=setup(),{data}=finish(f);
  assert.equal(data.get('url'),signed);
  assert.ok(f.rt.launches[0].includes('url='+encodeURIComponent(signed)));
  assert.equal(f.rt.launches[0].includes('&preload=1'),false);
  assert.equal(f.rt.mediaRequests.length,0);
});
for(const url of ['https://video.example/hls2/resource.mp4','https://video.example/master.m3u8?signature=fake',signed])
  test('separate HLS2 validation accepts API-proven resource '+url.split('?')[0],()=>{
    const rt=runtime();assert.equal(rt.api.infuseHlsUrl(url,'hls2'),url);
    assert.equal(rt.api.infuseHlsUrl(url,'hls4'),null);
    const scheme=rt.api.buildInfuseUrl({_kpInfuse:true,_kpFormat:'hls2',url,title:'Fixture'});
    assert.equal(new URL(scheme).searchParams.get('url'),url);
    if(/hls2|m3u8/.test(url)) assert.equal(rt.api.infuseFileUrl(url),null);
  });
for(const url of ['https://video.example/http/file.mp4','https://video.example/hls4/file.mp4',
  'https://video.example/hls/master.m3u8','https://video.example/manifest-proxy?master=fake',
  'https://video.example/manifest.mpd','file:///fixture.mp4','javascript:alert(1)',null])
  test('wrong or unsupported HLS2 resolver output is rejected: '+String(url),()=>{
    const f=setup();const {metadata}=begin(f);metadata.ok({item:clone(f.item)});
    f.rt.requests.at(-1).ok({url});
    assert.equal(f.rt.launches.length,0);assert.equal(f.rt.internal.length,0);
    assert.match(f.rt.notices.at(-1),/KP-H2/);
    assert.equal(f.rt.requests.filter(r=>r.url.includes('/media-video-link?')).length,1);
    assert.equal(f.rt.mediaRequests.length,0);
  });
test('missing HLS2 at maximum quality cannot pick available lower HLS2 or HLS4',()=>{
  const item=clone(fixtures.movie);delete item.videos[0].files[0].urls.hls2;
  const f=setup({item,storage:{kp_max_quality:'2160'}}), {before}=begin(f);
  assert.equal(f.rt.requests.length,before);assert.equal(f.rt.launches.length,0);
  assert.match(f.rt.notices.at(-1),/KP-H1/);
});
test('file-only metadata can request exact HLS2 without assuming a cached http URL',()=>{
  const item=clone(fixtures.movie);item.videos[0].files.forEach(file=>delete file.urls);
  const f=setup({item}),{params}=finish(f);
  assert.equal(params.get('file'),'/fixture/movie-1080.mp4');
});
test('HLS2 without an exact file identifier fails without using a file resolver or cached URL',()=>{
  const item=clone(fixtures.movie);item.videos[0].files.forEach(file=>delete file.file);
  const f=setup({item}),{before}=begin(f);
  assert.equal(f.rt.requests.length,before);assert.equal(f.rt.launches.length,0);
  assert.match(f.rt.notices.at(-1),/KP-H1/);
});
test('unsupported saved Infuse format cannot silently select a file or HLS4',()=>{
  const f=setup({storage:{kp_infuse_format_v1:'hls4'}}),{before}=begin(f);
  assert.equal(f.rt.requests.length,before);assert.equal(f.rt.launches.length,0);
});
test('ambiguous same-quality files fail instead of selecting another file',()=>{
  const item=clone(fixtures.movie);item.videos[0].files.push({...clone(item.videos[0].files[1]),file:'/fixture/other.mp4'});
  const f=setup({item}),{before}=begin(f);
  assert.equal(f.rt.requests.length,before);assert.equal(f.rt.launches.length,0);
});
for (const change of ['item','file','quality','format','episode','season'])
  test('fresh '+change+' mismatch cannot substitute content or delivery',()=>{
    const serial=change==='episode'||change==='season', f=setup({serial});
    const {metadata}=begin(f), fresh=clone(f.item);
    if(change==='item') fresh.id=999;
    if(change==='file') fresh.videos[0].files[1].file='/fixture/replacement.mp4';
    if(change==='quality') fresh.videos[0].files=fresh.videos[0].files.filter(x=>x.quality!=='1080p');
    if(change==='format') delete fresh.videos[0].files[1].urls.hls2;
    if(change==='episode') fresh.seasons[0].episodes.shift();
    if(change==='season') fresh.seasons[0].number=3;
    metadata.ok({item:fresh});
    assert.equal(f.rt.launches.length,0);
    assert.equal(f.rt.requests.filter(r=>r.url.includes('/media-video-link?')).length,0);
  });
test('fresh episode playlist preserves order, position, fresh HLS2 links and enabled subtitles',()=>{
  const f=setup({serial:true});const {metadata}=begin(f,{index:1});
  const fresh=clone(f.item);fresh.seasons[0].episodes[2].files[0].urls.hls2='https://video.example/fresh/episode3?sig=fake';
  fresh.seasons[0].episodes[1].subtitles[0].url='https://subs.example/fresh.srt?sig=a%2B+b';
  metadata.ok({item:fresh});const resolve=f.rt.requests.at(-1);
  assert.equal(new URL(resolve.url).searchParams.get('file'),'/fixture/s2e2.mp4');
  resolve.ok({url:signed});const data=new URL(f.rt.launches[0]).searchParams;
  assert.deepEqual(data.getAll('url'),[signed,fresh.seasons[0].episodes[2].files[0].urls.hls2]);
  assert.deepEqual(data.getAll('position'),['138','139']);
  assert.deepEqual(data.getAll('sub'),['https://subs.example/fresh.srt?sig=a%2B+b']);
  assert.equal(f.rt.mediaRequests.length,0);
});
test('playlist stops before missing HLS2 without jumping to another quality or later episode',()=>{
  const f=setup({serial:true});const {metadata}=begin(f);
  const fresh=clone(f.item);delete fresh.seasons[0].episodes[1].files[0].urls.hls2;
  metadata.ok({item:fresh});f.rt.requests.at(-1).ok({url:signed});
  assert.deepEqual(new URL(f.rt.launches[0]).searchParams.getAll('url'),[signed]);
});
test('builder cannot mix direct files with HLS2 playlist; file validator stays intact',()=>{
  const rt=runtime(), play={_kpInfuse:true,_kpFormat:'hls2',url:signed};
  play.playlist=[play,{_kpInfuse:true,_kpFormat:'http',url:'https://video.example/http/file.mp4'}];
  assert.deepEqual(new URL(rt.api.buildInfuseUrl(play)).searchParams.getAll('url'),[signed]);
  assert.equal(rt.api.buildInfuseUrl({_kpInfuse:true,_kpFormat:'http',url:'https://video.example/master.m3u8'}),null);
});
test('HLS2 builder preserves selected entry and enforces playlist and scheme-size bounds',()=>{
  const rt=runtime(),list=Array.from({length:50},(_,i)=>({_kpInfuse:true,_kpFormat:'hls2',
    url:signed+'&episode='+i,timeline:{time:i+1}}));
  const play=list[1];play.playlist=list;
  const scheme=rt.api.buildInfuseUrl(play),data=new URL(scheme).searchParams;
  assert.equal(data.getAll('url').length,40);assert.equal(data.get('url'),play.url);
  assert.equal(data.get('position'),'2');assert.ok(scheme.length<=65536);
  list[2].url=signed+'&padding='+'a'.repeat(70000);
  assert.deepEqual(new URL(rt.api.buildInfuseUrl(play)).searchParams.getAll('url'),[play.url]);
});
test('no external subtitle is added when disabled; timing-shift limitations stay explicit',()=>{
  const item=clone(fixtures.movie);item.videos[0].subtitles[0].shift=3;
  const f=setup({item}),{data}=finish(f);assert.equal(data.has('sub'),false);
  const disabled=setup({storage:{kp_subtitles_enabled:false}});assert.equal(finish(disabled).data.has('sub'),false);
});
for (const stage of ['metadata','resolver']) for(const status of [400,404,503])
  test(stage+' HTTP '+status+' cannot fall back or launch stale links',()=>{
    const f=setup(),{metadata}=begin(f);
    if(stage==='resolver') metadata.ok({item:clone(f.item)});
    f.rt.requests.at(-1).fail({status});f.rt.tickAll();
    assert.equal(f.rt.launches.length,0);assert.equal(f.rt.internal.length,0);
    assert.equal(f.rt.requests.some(r=>new URL(r.url).searchParams.get('type')==='http'),false);
  });
test('resolver-declared different format is rejected even when its URL is opaque',()=>{
  const f=setup(),{metadata}=begin(f);metadata.ok({item:clone(f.item)});
  f.rt.requests.at(-1).ok({type:'http',url:signed});assert.equal(f.rt.launches.length,0);
});
for (const action of ['timeout','destroy','delivery-change']) for(const stage of ['metadata','resolver'])
  test(action+' during '+stage+' suppresses late HLS2 launch',()=>{
    const f=setup(),{metadata}=begin(f);
    if(stage==='resolver') metadata.ok({item:clone(f.item)});
    const request=f.rt.requests.at(-1);
    if(action==='timeout') f.rt.tickAll();
    if(action==='destroy') f.src.destroy();
    if(action==='delivery-change') f.rt.storage.kp_infuse_format_v1='http';
    request.ok(stage==='metadata'?{item:clone(f.item)}:{url:signed});
    assert.equal(f.rt.launches.length,0);
    if(stage==='metadata') assert.equal(f.rt.requests.some(r=>r.url.includes('/media-video-link?')),false);
  });
test('authentication retry keeps exact HLS2 file and format',()=>{
  const f=setup({storage:{kp_refresh:'fake-refresh'}}),{metadata}=begin(f);
  metadata.ok({item:clone(f.item)});f.rt.requests.at(-1).fail({status:401});
  const grant=f.rt.requests.at(-1);assert.ok(grant.url.endsWith('/oauth2/token'));
  grant.ok({access_token:'new-fake',refresh_token:'new-fake-refresh'});
  const retry=f.rt.requests.at(-1), params=new URL(retry.url).searchParams;
  assert.equal(params.get('type'),'hls2');assert.equal(params.get('file'),'/fixture/movie-1080.mp4');
  retry.ok({url:signed});assert.equal(f.rt.launches.length,1);
});
test('attempt records contain actual format and stage, no playback success or secrets',()=>{
  const f=setup();finish(f);
  const last=f.rt.storage.kp_infuse_last_handoff_v1;
  assert.equal(last.version,'1.0.73-mx.19');assert.equal(last.format,'hls2');
  assert.equal(last.quality,1080);assert.equal(last.stage,'dispatch-returned');assert.equal(last.playbackConfirmed,false);
  const logs=JSON.stringify(f.rt.logs),record=JSON.stringify(last);
  for(const secret of ['fake-token','opaque-fixture','sig=a','movie-1080.mp4']) {
    assert.equal(logs.includes(secret),false);assert.equal(record.includes(secret),false);
  }
  assert.equal(logs.includes('"format":"hls2"'),true);
  assert.equal(f.rt.api.resourceInfo(signed).host,'*.msk-static-05.cdntogo.net');
});
test('synchronous dispatch error is recorded as handoff failure, never playback success',()=>{
  const f=setup({dispatchError:true}),{metadata}=begin(f);metadata.ok({item:clone(f.item)});
  f.rt.requests.at(-1).ok({url:signed});
  assert.equal(f.rt.launches.length,0);assert.equal(f.rt.storage.kp_infuse_last_handoff_v1.stage,'dispatch-error');
});
test('Apple-only mode and last-attempt display do not probe networks or migrate user preferences',()=>{
  const rt=runtime({storage:{kp_format:'auto'}}),params=[];
  rt.Lampa.SettingsApi={addComponent(){},addParam:p=>params.push(p)};
  const before={...rt.storage};rt.api.addSettings();assert.deepEqual(rt.storage,before);
  const mode=params.find(p=>p.param.name==='kp_infuse_format_v1');assert.equal(mode.param.default,'http');
  assert.deepEqual(Object.keys(mode.param.values),['http','hls2']);
  params.find(p=>p.param.name==='kp_action_infuse_last_handoff').onChange();
  assert.equal(rt.requests.length,0);assert.equal(rt.mediaRequests.length,0);
});
for(const player of ['tvosl','tvos','tvospro','vlc','senplayer','vidhub','svplayer','inner'])
  test(player+' retains existing Auto selection, playlist and dispatch with Infuse HLS2 setting',()=>{
    const results=['http','hls2'].map(delivery=>{
      const f=setup({serial:true,storage:{player,kp_infuse_format_v1:delivery}});
      f.view.options.onEnter(f.view.items[0]);
      return JSON.stringify({internal:f.rt.internal,playlists:f.rt.playlists,launches:f.rt.launches,
        requests:f.rt.requests.map(r=>r.url),notices:f.rt.notices});
    });
    assert.equal(results[0],results[1]);
  });
