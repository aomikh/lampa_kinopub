'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
// Retained direct-file mode; production-default HLS4 is covered in infuse-hls4.test.cjs.
const {fileInfuseRuntime: runtime} = require('./runtime.cjs');

const signed = 'https://video.example/private-fixture-secret/movie.mp4?sig=a+b%26&x=?=&nested=https%3A%2F%2Fprivate.example%2Ftoken';
const file = {file:'/private-fixture-secret/movie.mp4', quality:'1080p', urls:{http:signed, hls2:'https://video.example/hls2/token/movie.mp4?sig=fixture'}};
function fixture(options = {}, serial = false) {
  const rt = runtime({ ...options, storage: {kp_token:'fixture-token', player:'infuse', kp_launch_trace:true, ...options.storage}});
  const view = {reset() {}, loading() {}, filter() {}, draw(items, callbacks) {this.items=items; this.callbacks=callbacks;}};
  const video = {files:[file]};
  const item = {id:22, year:2024, title:'Fixture', ...(serial ? {seasons:[{number:1,episodes:[{number:2,...video}]}]} : {videos:[video]})};
  const src = new rt.api.kpapi(view, {movie:{id:11,title:'Fixture',name:serial ? 'Fixture' : undefined}});
  src.find(22); rt.requests.at(-1).ok({item});
  view.items[0].timeline={time:127};
  function enter(player) {view.callbacks.onEnter(view.items[0],{},player ? {player} : undefined);}
  function report() {return JSON.parse(JSON.stringify(rt.api.LaunchTrace.snapshot()));}
  return {rt,view,src,item,enter,report};
}

test('tracing is off by default and never changes the media URL, resume point or request count', () => {
  const off=fixture({storage:{kp_launch_trace:false}}), on=fixture();
  for(const f of [off,on]) {f.enter(); f.rt.requests.at(-1).ok({url:signed});}
  assert.equal(off.report().length,0); assert.equal(on.report().length,1);
  assert.equal(on.rt.launches[0],off.rt.launches[0]);
  assert.equal(on.rt.requests.length,off.rt.requests.length);
  assert.equal(on.rt.mediaRequests.length,0);
  assert.equal(new URL(on.rt.launches[0]).searchParams.get('position'),'127');
});

test('episode traces distinguish item refresh, playlist build, file resolution and handoff', () => {
  const f=fixture({},true); f.enter();
  f.rt.advance(430); f.rt.requests.at(-1).ok({item:f.item});
  f.rt.advance(670); f.rt.requests.at(-1).ok({url:signed});
  const r=f.report()[0];
  assert.equal(r.item_ms,430); assert.equal(r.link_ms,670); assert.equal(r.build_ms,0);
  assert.equal(r.prepare_ms,1100); assert.equal(r.dispatch_ms,0);
  assert.equal(r.status,'submitted'); assert.equal(r.boundary,'window.location.assign');
  assert.equal(r.kp_id,22); assert.equal(r.year,2024); assert.equal(r.season,1); assert.equal(r.episode,2);
  assert.equal(r.delivery,'http'); assert.equal(r.quality,1080); assert.equal(r.position,127);
  assert.equal(r.entries,1); assert.equal(f.rt.internal.length,0); assert.equal(f.rt.mediaRequests.length,0);
  assert.equal('first_frame_ms' in r,false); assert.equal('app_open_ms' in r,false);
});

test('movie resolution needs no extra item refresh and unobserved stages remain null', () => {
  const f=fixture(); f.enter(); f.rt.advance(1269); f.rt.requests.at(-1).ok({url:signed});
  const r=f.report()[0];
  assert.equal(r.item_ms,null); assert.equal(r.link_ms,1269); assert.equal(r.prepare_ms,1269);
  assert.equal(f.rt.requests.length,2); // initial card plus the existing exact-file resolver
});

for(const player of ['tvospro','tvos','tvosl','tvosSelect','vlc','senplayer','vidhub','inner','svplayer']) {
  test('trace names the selected resource and core boundary for '+player, () => {
    const f=fixture(); f.enter(player);
    const r=f.report()[0];
    assert.equal(r.player,player); assert.equal(r.delivery,'hls2'); assert.equal(r.quality,1080);
    assert.equal(r.boundary,'Lampa.Player.play'); assert.equal(r.input,r.output);
    assert.equal(r.item_ms,null); assert.equal(r.link_ms,null); assert.equal(r.status,'submitted');
    assert.equal(f.rt.requests.length,1); assert.equal(f.rt.mediaRequests.length,0);
    assert.equal(f.rt.internal[0].url,file.urls.hls2);
    assert.equal(JSON.stringify(f.rt.internal[0]).includes('prepare_ms'),false);
  });
}

test('same file across VLC/Infuse shares F; changed delivery/address does not share U', () => {
  const f=fixture(); f.enter('vlc'); f.enter('infuse'); f.rt.requests.at(-1).ok({url:signed});
  const [vlc,infuse]=f.report();
  assert.equal(vlc.file,infuse.file); assert.notEqual(vlc.output,infuse.output);
  assert.equal(vlc.session,infuse.session); assert.equal(vlc.delivery,'hls2'); assert.equal(infuse.delivery,'http');
});

test('exact signed address equality is preserved without publishing credentials or hashes', () => {
  const f=fixture({storage:{kp_format:'http'}});
  f.enter('vlc'); f.enter('infuse'); f.rt.requests.at(-1).ok({url:signed});
  const [vlc,infuse]=f.report(); assert.equal(vlc.output,infuse.output); assert.equal(vlc.file,infuse.file);
  const safe=JSON.stringify(f.report());
  for(const secret of ['private-fixture','sig=','nested=','private.example','fixture-token',signed,file.file]) assert.equal(safe.includes(secret),false,secret);
  assert.equal(infuse.resource.host,'video.example');
  f.rt.api.LaunchTrace.show(); f.rt.menus.at(-1).onSelect(f.rt.menus.at(-1).items[0]);
  assert.equal(f.rt.modals.at(-1).html.value.includes('private-fixture'),false);
  assert.equal(f.rt.mediaRequests.length,0);
});

test('actual fallback field is reported, not inferred from .mp4 extension or requested HLS2', () => {
  const f=fixture();
  f.view.items[0].kp.files[0].urls={hls4:'https://video.example/hls4/token/movie.mp4'};
  f.enter('vlc');
  assert.equal(f.report()[0].delivery,'hls4'); assert.equal(f.report()[0].extension_hint,'mp4');
});

test('cancellation, timeout and failed resolution retain their status; stale callbacks do not launch', () => {
  const cancelled=fixture({},true); cancelled.enter(); const late=cancelled.rt.requests.at(-1);
  cancelled.rt.advance(10); cancelled.src.destroy(); late.ok({item:cancelled.item});
  assert.equal(cancelled.report()[0].status,'cancelled'); assert.equal(cancelled.report()[0].item_ms,10);
  assert.equal(cancelled.rt.launches.length,0);
  const timeout=fixture(); timeout.enter(); timeout.rt.advance(18000); timeout.rt.tickAll();
  assert.equal(timeout.report()[0].status,'timeout'); assert.equal(timeout.rt.launches.length,0);
  const failed=fixture(); failed.enter(); failed.rt.requests.at(-1).fail({status:403});
  assert.equal(failed.report()[0].status,'prepare-error'); assert.equal(failed.report()[0].http_status,403);
});

test('synchronous dispatch error is not recorded as successful handoff', () => {
  const f=fixture({dispatchError:true}); f.enter(); f.rt.requests.at(-1).ok({url:signed});
  assert.equal(f.report()[0].status,'dispatch-error'); assert.equal(f.rt.launches.length,0);
  const core=fixture({playerError:true}); core.enter('vlc');
  assert.equal(core.report()[0].status,'dispatch-error');
});

test('eight attempts maximum; disabling clears labels and prevents pending completion from restoring them', () => {
  const f=fixture(); for(let i=0;i<11;i++) f.enter('vlc');
  assert.equal(f.report().length,8); assert.equal(f.report()[0].attempt,4);
  const oldLabel=f.report()[0].file;
  f.enter('infuse'); const late=f.rt.requests.at(-1);
  f.rt.storage.kp_launch_trace=false; assert.equal(f.report().length,0);
  f.rt.storage.kp_launch_trace=true; late.ok({url:signed});
  assert.equal(f.report().length,0); // playback proceeds; recording stays cleared
  f.enter('vlc'); assert.notEqual(f.report()[0].file,oldLabel);
});

test('Tizen has no new diagnostic state or requests even when storage flag is set', () => {
  const f=fixture({platform:'tizen',storage:{player:'tizen'}}); f.enter();
  assert.equal(f.report().length,0); assert.equal(f.rt.internal.length,1);
});

test('URL-only metadata refreshed to an exact file reports the resolved file identity', () => {
  const f=fixture();
  f.view.items[0].kp.files[0].file='';
  f.enter('infuse');
  const fresh=JSON.parse(JSON.stringify(f.item));
  fresh.videos[0].files[0].file='/private-fixture-secret/refreshed.mkv';
  f.rt.requests.at(-1).ok({item:fresh});
  f.rt.requests.at(-1).ok({url:signed});
  f.view.items[0].kp.files[0].file=fresh.videos[0].files[0].file;
  f.enter('vlc');
  const [infuse,vlc]=f.report();
  assert.ok(infuse.file);
  assert.equal(infuse.file,vlc.file);
  assert.equal(infuse.extension_hint,'mkv');
  assert.equal(JSON.stringify(f.report()).includes('refreshed.mkv'),false);
  assert.equal(new URL(f.rt.launches[0]).searchParams.get('url'),signed);
});

test('one-off Lampa web player is identified as inner, with absent stages explicit', () => {
  const f=fixture(); f.enter('lampa');
  const r=f.report()[0];
  assert.equal(r.player,'inner');
  assert.equal(r.build_ms,null);
  assert.equal(r.boundary,'Lampa.Player.play');
});
