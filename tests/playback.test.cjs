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
  assert.match(safe,/video.example/);
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
