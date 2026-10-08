'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {runtime} = require('./runtime.cjs');
const signed = 'https://video.example/secret-path-token/direct/file.mp4?sig=a%2Bb%2Fc%3D&key=a+b%25&loc=ru&preload=1&x=?%26=';
const files = [
  {quality:'1080p',urls:{http:signed,hls4:'https://video.example/hls4/master.m3u8',hls2:'https://video.example/hls2/main.m3u8'}},
  {quality:'720p',url:{http:'https://video.example/direct/720.mp4',hls2:'https://video.example/hls2/720.m3u8'}}
];
function source(rt, serial = false) {
  const view = {reset() {},loading() {},filter() {},doesNotAnswer() {throw Error('source error');},draw(items,options) {this.items=items;this.options=options;}};
  const src = new rt.api.kpapi(view,{movie: {id:111,title:'Fixture',name:serial?'Fixture':undefined}});
  const item = serial ? {id:22,title:'Fixture',seasons:[{number:'1',episodes:[{number:'1',files},{number:2,files}]}]} : {id:22,title:'Fixture',videos:[{files}]};
  src.find(22); rt.requests.at(-1).ok({item});
  return {src,view,item};
}

test('Infuse selects a real http field; Tizen retains HLS4 proxy and HLS2 fallback', () => {
  const rt = runtime({platform:'tizen',storage:{player:'tizen',kp_format_migrated_v4:'1',kp_format_migrated_v5:'1'}});
  rt.api.setProxy(true);
  const parsed = rt.api.parseFiles(files);
  assert.equal(rt.api.preferredFormat('infuse'),'http');
  assert.equal(rt.api.pickStream(parsed,'http','1080p').url,signed);
  assert.equal(rt.api.preferredFormat('tizen'),'hls4');
  assert.match(rt.api.proxyUrlFor(parsed[0].urls.hls4,2,'tizen'),/^https:\/\/kinopub.fastcdn.pics\/manifest-proxy\?/);
  assert.equal(rt.api.proxyUrlFor(signed,1,'infuse'),null);
  rt.api.setProxy(false);
  assert.equal(rt.api.preferredFormat('tizen'),'hls2');
});
test('explicit HLS2 wins over a healthy proxy; non-Tizen stays out of the reducer', () => {
  const rt = runtime({platform:'tizen',storage:{player:'tizen',kp_format:'hls2'}});
  rt.api.setProxy(true);
  assert.equal(rt.api.preferredFormat(),'hls2');
  assert.equal(rt.api.proxyUrlFor('https://video.example/master.m3u8',1),null);
  const apple = runtime(); apple.api.setProxy(true);
  assert.equal(apple.api.preferredFormat('inner'),'hls2');
});
test('one-off Infuse is chosen before format and does not change the saved player', () => {
  const rt = runtime({storage:{kp_token:'dummy-fixture',player:'inner'}}); rt.api.setProxy(true);
  const {view,item} = source(rt);
  view.options.onEnter(view.items[0],{}, {player:'infuse'});
  assert.equal(rt.launches.length,0);
  rt.requests.at(-1).ok({item});
  assert.equal(rt.internal.length,0);
  assert.equal(new URL(rt.launches[0]).searchParams.get('url'),signed);
  assert.equal(rt.storage.player,'inner');
});
test('signed query and path survive exactly one layer of encoding; play has no playlist parameter', () => {
  const rt = runtime();
  const url = rt.api.buildInfuseUrl({_kpInfuse:true,url:signed,title:'S1 E1 & + = ?',timeline:{time:38.9},subtitles:[{url:'https://subs.example/secret/file.srt?sig=a+b%2F'}]});
  const p = new URL(url).searchParams;
  assert.equal(p.get('url'),signed);
  assert.equal(p.get('position'),'38');
  assert.equal(p.get('filename'),'S1 E1 & + = ?');
  assert.equal(p.get('sub'),'https://subs.example/secret/file.srt?sig=a+b%2F');
  assert.equal(p.has('playlist'),false);
  assert.equal(p.has('x-success'),false);
  assert.equal(new URL(url).pathname,'/play');
});
test('no direct resource or selected quality fails without substituting HLS or another quality', () => {
  const rt = runtime();
  assert.equal(rt.api.pickStream(rt.api.parseFiles([{quality:'1080p',url:{hls4:'https://video.example/a.m3u8'}}]),'http'),null);
  assert.equal(rt.api.pickStream(rt.api.parseFiles(files),'http','480p'),null);
  rt.storage.kp_max_quality='480';
  assert.equal(rt.api.pickStream(rt.api.parseFiles(files),'http'),null);
});
test('episode list is refreshed once; every transferred resource is a direct file', () => {
  const rt = runtime({storage:{kp_token:'dummy-fixture',player:'infuse'}});
  const {view,item} = source(rt,true);
  let marks=0; view.items.forEach(i => i.mark=() => marks++);
  view.options.onEnter(view.items[0]);
  const refresh = rt.requests.at(-1);
  const fresh = JSON.parse(JSON.stringify(item));
  fresh.seasons[0].episodes[0].files[0].urls.http = signed + '&fresh=1';
  refresh.ok({item:fresh});
  const links = new URL(rt.launches[0]).searchParams.getAll('url');
  assert.equal(links.length,2);
  assert.equal(links[0],signed+'&fresh=1');
  assert.equal(links.some(x => x.includes('manifest-proxy') || x.includes('.m3u8')),false);
  assert.equal(marks,0);
  assert.equal(rt.internal.length,0);
  assert.equal(rt.requests.length,2);
});
test('dispatch error has no retry and no mark; closed source rejects late refresh', () => {
  const rt = runtime({dispatchError:true,storage:{kp_token:'dummy-fixture',player:'infuse'}});
  const {src,view,item} = source(rt); let marks=0; view.items[0].mark=() => marks++;
  view.options.onEnter(view.items[0]); rt.requests.at(-1).ok({item}); rt.tickAll();
  assert.equal(rt.launches.length,0); assert.equal(marks,0); assert.equal(rt.requests.length,2);
  view.options.onEnter(view.items[0]); const pending=rt.requests.at(-1); src.destroy(); pending.ok({item});
  assert.equal(rt.launches.length,0); assert.equal(pending.cleared,true);
});
test('identity mismatch and hung refresh cannot launch stale media', () => {
  const rt = runtime({storage:{kp_token:'dummy-fixture',player:'infuse'}});
  const {view} = source(rt); view.options.onEnter(view.items[0]);
  rt.requests.at(-1).ok({item:{id:999,videos:[{files}]}});
  assert.equal(rt.launches.length,0);
  view.options.onEnter(view.items[0]); rt.tickAll();
  assert.equal(rt.launches.length,0);
});
test('diagnostics redact nested URL paths, encoded URL values, token keys and manifest content', () => {
  const rt = runtime();
  rt.api.dispatchInfuse({_kpInfuse:true,url:signed,title:'Fixture'});
  const safe = JSON.stringify(rt.api.redactDiagnostic({url:signed,access_token:'fixture-secret',keep:['/secret-path-token/file'],
    nested:{urls:{http:signed}},encoded:encodeURIComponent(signed),message:'Bearer fixture-secret '+signed}));
  assert.equal(safe.includes('secret-path-token'),false);
  assert.equal(safe.includes('fixture-secret'),false);
  assert.equal(JSON.stringify(rt.logs).includes('secret-path-token'),false);
  assert.match(safe,/redacted-host/);
  assert.equal(safe.includes('video.example'),false);
});
test('Tizen launch still wraps the current episode and every playlist entry', () => {
  const rt=runtime({platform:'tizen',storage:{kp_token:'dummy-fixture',player:'tizen'}});rt.api.setProxy(true);
  const {view}=source(rt,true);view.options.onEnter(view.items[0]);
  assert.equal(rt.launches.length,0);assert.equal(rt.internal.length,1);
  assert.equal(rt.internal[0].quality,undefined);
  assert.match(rt.internal[0].url,/manifest-proxy/);
  assert.equal(rt.playlists[0].length,2);
  rt.playlists[0].forEach(p=>assert.match(p.url,/manifest-proxy/));
});
test('one-off internal player remains internal when the saved player is Infuse', () => {
  const rt=runtime({storage:{kp_token:'dummy-fixture',player:'infuse'}});
  const {view}=source(rt);view.options.onEnter(view.items[0],{}, {player:'lampa'});
  assert.equal(rt.launches.length,0);assert.equal(rt.internal.length,1);
  assert.match(rt.internal[0].url,/hls2/);
  assert.equal(rt.requests.length,1);
});
test('an oversized selected link is rejected rather than playing a later episode', () => {
  const rt = runtime();
  const play={_kpInfuse:true,url:signed+'&long='+ 'x'.repeat(66000)};
  play.playlist=[play,{_kpInfuse:true,url:'https://video.example/other.mp4'}];
  assert.equal(rt.api.buildInfuseUrl(play),null);
});

function movieWithFile(rt, {noLinks = false} = {}) {
  const fixture = source(rt);
  fixture.item.videos[0].files = files.map((f, i) => ({
    quality: f.quality, file: '/private-fixture/file-' + (i ? '720' : '1080') + '.mp4',
    urls: noLinks ? {} : (f.urls || f.url)
  }));
  return fixture;
}
test('movie resolves the exact selected file with type=http before opening Infuse', () => {
  const rt = runtime({storage:{kp_token:'dummy-fixture',player:'infuse'}});
  const {view,item} = movieWithFile(rt);
  view.items[0].quality = '720p';
  view.options.onEnter(view.items[0]);
  rt.requests.at(-1).ok({item});
  assert.equal(rt.launches.length,0);
  const resolve = rt.requests.at(-1), params = new URL(resolve.url).searchParams;
  assert.equal(new URL(resolve.url).pathname,'/v1/items/media-video-link');
  assert.equal(params.get('file'),'/private-fixture/file-1080.mp4');
  assert.equal(params.get('type'),'http');
  resolve.ok({url:signed+'&fresh=exact'});
  assert.equal(new URL(rt.launches[0]).searchParams.get('url'),signed+'&fresh=exact');
  assert.equal(rt.requests.length,3);
  assert.equal(rt.internal.length,0);
  assert.equal(JSON.stringify(rt.logs).includes('/private-fixture'),false);
});
test('file references without item URLs resolve without constructing a media address', () => {
  const rt = runtime({storage:{kp_token:'dummy-fixture',player:'infuse'}});
  const {view,item} = movieWithFile(rt,{noLinks:true});
  view.options.onEnter(view.items[0]);rt.requests.at(-1).ok({item});
  assert.equal(rt.launches.length,0);
  rt.requests.at(-1).ok(JSON.stringify({url:signed}));
  assert.equal(new URL(rt.launches[0]).searchParams.get('url'),signed);
});
test('resolver error never reuses the old movie URL and reports a safe stage/status', () => {
  const rt = runtime({storage:{kp_token:'dummy-fixture',player:'infuse'}});
  const {view,item} = movieWithFile(rt);
  view.options.onEnter(view.items[0]);rt.requests.at(-1).ok({item});
  const resolve=rt.requests.at(-1);
  resolve.fail({status:403,responseText:signed});resolve.ok({url:signed});rt.tickAll();
  assert.equal(rt.launches.length,0);
  assert.equal(rt.requests.length,3);
  assert.match(rt.notices.at(-1),/KP-I2 HTTP 403/);
  assert.equal(JSON.stringify(rt.logs).includes('secret-path-token'),false);
});
test('resolver timeout or closing a card suppresses late results', () => {
  for (const close of [false,true]) {
    const rt = runtime({storage:{kp_token:'dummy-fixture',player:'infuse'}});
    const {src,view,item} = movieWithFile(rt);
    view.options.onEnter(view.items[0]);rt.requests.at(-1).ok({item});
    const resolve=rt.requests.at(-1);
    if(close) src.destroy(); else rt.tickAll();
    resolve.ok({url:signed});
    assert.equal(rt.launches.length,0);assert.equal(resolve.cleared,true);
  }
});
test('duplicate presses and callbacks cannot create repeated resolver requests or launches', () => {
  const rt = runtime({storage:{kp_token:'dummy-fixture',player:'infuse'}});
  const {view,item} = movieWithFile(rt);
  view.options.onEnter(view.items[0]);view.options.onEnter(view.items[0]);
  const refresh=rt.requests.at(-1);refresh.ok({item});refresh.ok({item});
  assert.equal(rt.requests.length,3);
  const resolve=rt.requests.at(-1);resolve.ok({url:signed});resolve.ok({url:signed});
  assert.equal(rt.launches.length,1);
});
test('resolver cannot send a manifest, reducer or malformed response to Infuse', () => {
  for (const url of [null,'https://video.example/hls4/token/file.mp4','https://video.example/master.m3u8',
    'https://kinopub.fastcdn.pics/manifest-proxy?master=fixture']) {
    const rt = runtime({storage:{kp_token:'dummy-fixture',player:'infuse'}});
    const {view,item} = movieWithFile(rt);
    view.options.onEnter(view.items[0]);rt.requests.at(-1).ok({item});rt.requests.at(-1).ok({url});
    assert.equal(rt.launches.length,0);assert.match(rt.notices.at(-1),/KP-I2/);
  }
});
test('selected episode in the playlist uses its resolved URL; later direct URLs stay intact', () => {
  const rt = runtime({storage:{kp_token:'dummy-fixture',player:'infuse'}});
  const {view,item} = source(rt,true);
  const fresh=JSON.parse(JSON.stringify(item));
  fresh.seasons[0].episodes[0].files[0].file='/private-fixture/episode-1.mp4';
  view.options.onEnter(view.items[0]);rt.requests.at(-1).ok({item:fresh});
  rt.requests.at(-1).ok({url:signed+'&selected=fresh'});
  const links=new URL(rt.launches[0]).searchParams.getAll('url');
  assert.deepEqual(links,[signed+'&selected=fresh',signed]);
});
test('invalid selected resource cannot skip ahead to another episode', () => {
  const rt=runtime();
  const play={_kpInfuse:true,url:'https://video.example/hls/token/file.mp4'};
  play.playlist=[play,{_kpInfuse:true,url:signed}];
  assert.equal(rt.api.buildInfuseUrl(play),null);
});

test('loaded movie refreshes dedicated-device metadata before resolving its selected file', () => {
  const rt=runtime({storage:{kp_token:'dummy-fixture',player:'infuse'}});
  const {src,view,item}=movieWithFile(rt);
  // Reopen using metadata which contains actual file references from the start.
  src.find(22);rt.requests.at(-1).ok({item});
  view.items[0].quality='720p';
  const before=rt.requests.length;
  view.options.onEnter(view.items[0]);rt.requests.at(-1).ok({item});
  const resolve=rt.requests.at(-1), u=new URL(resolve.url);
  assert.equal(u.pathname,'/v1/items/media-video-link');
  assert.equal(u.searchParams.get('file'),'/private-fixture/file-1080.mp4');
  assert.equal(rt.launches.length,0);
  resolve.ok({url:signed});
  assert.equal(rt.requests.length-before,2);
  assert.equal(new URL(rt.launches[0]).searchParams.get('url'),signed);
  assert.equal(rt.internal.length,0);
});

test('one-off Infuse maximum is selected from direct files, not the HLS card label', () => {
  const rt=runtime({storage:{kp_token:'dummy-fixture',player:'inner',kp_max_quality:'2160'}});
  const {src,view,item}=source(rt);
  item.videos[0].files=[{quality:'2160p',file:'/fixture-selected-2160.mp4'},
    {quality:'1080p',file:'/fixture-selected-1080.mp4',urls:{hls2:'https://video.example/1080.m3u8'}}];
  src.find(22);rt.requests.at(-1).ok({item});
  assert.equal(view.items[0].quality.trim(),'1080p'); // Label prepared for saved internal player.
  view.items[0].timeline={time:421};const before=rt.requests.length;
  view.options.onEnter(view.items[0],{}, {player:'infuse'});rt.requests.at(-1).ok({item});
  assert.equal(new URL(rt.requests.at(-1).url).searchParams.get('file'),'/fixture-selected-2160.mp4');
  rt.requests.at(-1).ok({url:signed});
  const params=new URL(rt.launches[0]).searchParams;
  assert.equal(params.get('url'),signed);assert.equal(params.get('position'),'421');
  assert.equal(rt.requests.length-before,2);assert.equal(rt.internal.length,0);
  assert.equal(rt.storage.kp_max_quality,'2160');assert.equal(rt.storage.player,'inner');
});

test('a file-reference-only higher quality is not masked by the lower direct URL in the card',()=>{
  const rt=runtime({storage:{kp_token:'dummy-fixture',player:'infuse',kp_max_quality:'2160'}});
  const {src,view,item}=source(rt);
  item.videos[0].files=[{quality:'2160p',file:'/fixture-2160.mp4'},
    {quality:'1080p',file:'/fixture-1080.mp4',urls:{http:signed}}];
  src.find(22);rt.requests.at(-1).ok({item});
  view.options.onEnter(view.items[0]);rt.requests.at(-1).ok({item});
  assert.equal(new URL(rt.requests.at(-1).url).searchParams.get('file'),'/fixture-2160.mp4');
});

test('obsolete one-off Infuse quality cannot lower either launch', () => {
  const rt=runtime({storage:{kp_token:'dummy-fixture',player:'inner'}});
  const {src,view,item}=movieWithFile(rt);
  src.find(22);rt.requests.at(-1).ok({item});
  const before=rt.requests.length;
  view.options.onEnter(view.items[0],{}, {player:'infuse',quality:'720p'});rt.requests.at(-1).ok({item});
  assert.equal(new URL(rt.requests.at(-1).url).searchParams.get('file'),'/private-fixture/file-1080.mp4');
  rt.requests.at(-1).ok({url:signed+'&quality=1080'});
  assert.equal(rt.requests.length-before,2);
  assert.equal(new URL(rt.launches[0]).searchParams.get('url'),signed+'&quality=1080');
  assert.equal(rt.storage.kp_max_quality,'1080');assert.equal(rt.storage.player,'inner');
  assert.equal(view.items[0].quality.trim(),'1080p');
  view.options.onEnter(view.items[0],{}, {player:'infuse'});rt.requests.at(-1).ok({item});
  assert.equal(new URL(rt.requests.at(-1).url).searchParams.get('file'),'/private-fixture/file-1080.mp4');
  assert.equal(rt.internal.length,0);
});
test('URL-only movie refresh chooses maximum quality without modifying signed links', () => {
  const rt=runtime({storage:{kp_token:'dummy-fixture',player:'infuse'}});
  const {view,item}=source(rt);
  const fresh=JSON.parse(JSON.stringify(item));fresh.videos[0].files[1].url.http=signed+'&q=720';
  view.options.onEnter(view.items[0],{}, {player:'infuse',quality:'720p'});
  rt.requests.at(-1).ok({item:fresh});
  assert.equal(new URL(rt.launches[0]).searchParams.get('url'),signed);
});
test('every Infuse playlist episode uses its own maximum, ignoring old quality options', () => {
  const rt=runtime({storage:{kp_token:'dummy-fixture',player:'infuse'}});
  const {view,item}=source(rt,true);
  view.options.onEnter(view.items[0],{}, {player:'infuse',quality:'720p'});
  rt.requests.at(-1).ok({item});
  assert.deepEqual(new URL(rt.launches[0]).searchParams.getAll('url'),[signed,signed]);
  const fresh=JSON.parse(JSON.stringify(item));fresh.seasons[0].episodes[1].files=[files[0]];
  view.options.onEnter(view.items[0],{}, {player:'infuse',quality:'720p'});
  rt.requests.at(-1).ok({item:fresh});
  assert.deepEqual(new URL(rt.launches[1]).searchParams.getAll('url'),[signed,signed]);
});
test('missing obsolete lower quality does not prevent automatic maximum quality', () => {
  const rt=runtime({storage:{kp_token:'dummy-fixture',player:'infuse'}});
  const {view,item}=source(rt);
  const fresh=JSON.parse(JSON.stringify(item));fresh.videos[0].files=[files[0]];
  view.options.onEnter(view.items[0],{}, {player:'infuse',quality:'720p'});
  rt.requests.at(-1).ok({item:fresh});rt.tickAll();
  assert.equal(new URL(rt.launches[0]).searchParams.get('url'),signed);
});
test('quality selection preserves requested subtitles regardless of source-file embed metadata', () => {
  for (const external of [false,true]) {
    const rt=runtime({storage:{kp_token:'dummy-fixture',player:'infuse',kp_subtitles_enabled:true}});
    const {src,view,item}=movieWithFile(rt);
    item.videos[0].subtitles=[{embed:true,url:'https://subs.example/embedded-copy.srt',lang:'rus'}];
    if(external) item.videos[0].subtitles.push({embed:false,url:'https://subs.example/external.srt',lang:'eng'});
    src.find(22);rt.requests.at(-1).ok({item});
    view.options.onEnter(view.items[0],{}, {player:'infuse',quality:'720p'});rt.requests.at(-1).ok({item});rt.requests.at(-1).ok({url:signed});
    const subs=new URL(rt.launches[0]).searchParams.getAll('sub');
    assert.deepEqual(subs,['https://subs.example/embedded-copy.srt']);
  }
});
test('internal and Infuse players retain existing subtitle behavior', () => {
  const rt=runtime({storage:{kp_token:'dummy-fixture',player:'inner',kp_subtitles_enabled:true}});
  const {src,view,item}=movieWithFile(rt);
  item.videos[0].subtitles=[{embed:true,url:'https://subs.example/embedded-copy.srt'},
    {url:'https://subs.example/unknown.srt'}];
  src.find(22);rt.requests.at(-1).ok({item});
  view.options.onEnter(view.items[0],{}, {player:'inner'});
  assert.equal(rt.internal[0].subtitles.length,2);
  view.options.onEnter(view.items[0],{}, {player:'infuse'});rt.requests.at(-1).ok({item});rt.requests.at(-1).ok({url:signed});
  assert.equal(new URL(rt.launches[0]).searchParams.get('sub'),'https://subs.example/embedded-copy.srt');
});
test('fast movie launch remains cancellable and never retries old media on timeout', () => {
  const rt=runtime({storage:{kp_token:'dummy-fixture',player:'infuse'}});
  const {src,view,item}=movieWithFile(rt,{noLinks:true});
  src.find(22);rt.requests.at(-1).ok({item});
  view.options.onEnter(view.items[0]);rt.requests.at(-1).ok({item});const resolve=rt.requests.at(-1);
  assert.match(resolve.url,/media-video-link/);
  rt.tickAll();resolve.ok({url:signed});
  assert.equal(rt.launches.length,0);
  assert.match(rt.notices.at(-1),/KP-I2/);
});

test('after Infuse handoff, pending timers, proxy state and source teardown do not reopen or replace media', () => {
  const rt=runtime({storage:{kp_token:'dummy-fixture',player:'infuse'}});
  const {src,view,item}=movieWithFile(rt);
  src.find(22); rt.requests.at(-1).ok({item});
  let marks=0; view.items[0].mark=()=>marks++;
  view.items[0].timeline={time:37,percent:1};
  view.options.onEnter(view.items[0]);rt.requests.at(-1).ok({item}); rt.requests.at(-1).ok({url:signed});
  const launch=rt.launches[0], requestCount=rt.requests.length;
  const data=new URL(launch).searchParams;
  assert.equal(data.get('url'),signed); assert.equal(data.get('position'),'37');
  for(const health of [true,false,true]) {rt.api.setProxy(health);rt.tickAll();}
  src.destroy(); rt.tickAll();
  assert.equal(rt.launches.length,1); assert.equal(rt.launches[0],launch);
  assert.equal(rt.requests.length,requestCount); assert.equal(rt.internal.length,0);
  assert.equal(marks,0); assert.equal(rt.notices.length,0);
});

test('large size metadata never lowers quality, changes the file or adds a pre-download before Infuse',()=>{
  for(const size of [2**31-1,2**31+1,2**32+1,100*2**30]) {
    const rt=runtime({storage:{kp_token:'dummy-fixture',player:'infuse',kp_max_quality:'2160'}});
    const {src,view,item}=source(rt);
    item.videos[0].files=[
      {quality:'2160p',size,file:'/fixture/max.mp4',urls:{http:signed}},
      {quality:'1080p',size:1024,file:'/fixture/small.mp4',urls:{http:'https://video.example/small.mp4'}}
    ];
    src.find(22);rt.requests.at(-1).ok({item});
    view.items[0].timeline={time:421,percent:1};
    const before=rt.requests.length;
    view.options.onEnter(view.items[0]);rt.requests.at(-1).ok({item});
    assert.equal(rt.requests.length-before,2);
    const resolve=new URL(rt.requests.at(-1).url);
    assert.match(resolve.pathname,/items\/media-video-link$/);
    assert.equal(resolve.searchParams.get('file'),'/fixture/max.mp4');
    assert.equal(resolve.searchParams.get('type'),'http');
    rt.requests.at(-1).ok({url:signed});
    const data=new URL(rt.launches[0]).searchParams;
    assert.equal(data.get('url'),signed); assert.equal(data.get('position'),'421');
    assert.equal(data.has('size'),false); assert.equal(rt.internal.length,0);
    assert.equal(rt.requests.length-before,2);
  }
});
