'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {runtime} = require('./runtime.cjs');

const players = ['tvospro', 'tvos', 'tvosl', 'tvosSelect', 'vlc', 'senplayer', 'vidhub', 'svplayer'];
const signed = 'https://video.example/private-fixture/2160.m3u8?sig=a%2Bb%2Fc%3D&k=a+b%25&x=?%26=';
const files = [
  {quality: '2160p', file: '/fixture/2160.mp4', urls: {hls2: signed, hls4: signed + '&fmt=4', http: 'https://video.example/2160.mp4?sig=a%2B'}},
  {quality: '1080p', urls: {hls2: 'https://video.example/1080.m3u8', http: 'https://video.example/1080.mp4'}}
];
const subtitles = [{lang: 'en', url: 'https://sub.example/fixture.srt?sig=x%2B+y'}];
function source(rt, serial = false) {
  const view = {reset() {}, loading() {}, filter() {}, draw(items, options) {this.items = items; this.options = options;}};
  const src = new rt.api.kpapi(view, {movie: {id: 111, title: 'Fixture', name: serial ? 'Fixture' : undefined}});
  const video = {files, audios: [{lang: 'en', index: 1}], subtitles};
  const item = serial ? {id: 22, title: 'Fixture', seasons: [{number: 1, episodes: [1, 2].map(number => ({number, ...video}))}]} :
    {id: 22, title: 'Fixture', videos: [video]};
  src.find(22); rt.requests.at(-1).ok({item});
  let marks = 0;
  view.items.forEach(e => {e.timeline = {time: 237, percent: 12}; e.mark = () => marks++;});
  return {view, src, marks: () => marks};
}
function native(player, extra = {}) {
  return runtime({storage: {kp_token: 'dummy-fixture', player, kp_format: 'auto', kp_max_quality: '2160', kp_subtitles_enabled: true, ...extra}});
}

for (const player of players) test(player + ': one core handoff, exact maximum URL, no extra download or watched mark', () => {
  const rt = native(player); rt.api.setProxy(true);
  const {view, marks} = source(rt);
  view.options.onEnter(view.items[0]);
  assert.equal(rt.internal.length, 1); // Calls to Lampa.Player, not proof of native playback.
  const play = rt.internal[0];
  assert.equal(play.url, signed);
  assert.equal(play.quality, undefined, 'Lampa must not overwrite the chosen URL with its stored quality');
  assert.equal(play.callback, undefined);
  assert.equal(play.error, undefined, 'Web-player retries must not control a delegated player');
  assert.equal(play.timeline.time, 237);
  assert.equal(rt.api.getPendingVoice(), null);
  assert.equal(rt.mediaRequests.length, 0, 'No manifest dump or video prefetch');
  assert.equal(rt.requests.length, 1, 'No extra sequential API request');
  assert.equal(rt.launches.length, 0, 'Plugin must use the existing core adapter');
  assert.equal(marks(), 0);
  assert.equal(rt.storage.player, player);
  rt.tickAll(); assert.equal(rt.internal.length, 1); assert.equal(marks(), 0);
});

test('native playlist keeps positions, subtitle and audio metadata without internal callbacks', () => {
  const rt = native('tvos'); const {view, marks} = source(rt, true);
  view.options.onEnter(view.items[1]);
  assert.equal(rt.playlists[0].length, 2);
  for (const play of rt.playlists[0]) {
    assert.equal(play.url, signed); assert.equal(play.timeline.time, 237);
    assert.equal(play.quality, undefined); assert.equal(play.callback, undefined); assert.equal(play.error, undefined);
    assert.equal(play.voiceovers.length, 1); assert.equal(play.voiceovers[0].url, signed);
    assert.equal(play.subtitles[0].url, subtitles[0].url);
  }
  assert.match(rt.internal[0].title, /s1e02/); assert.equal(marks(), 0);
});

test('native destination resolves maximum after a stored player changes, not from the old row label', () => {
  const rt = native('infuse'); const {view} = source(rt);
  // A previously drawn row only offered a 1080p direct file.
  view.items[0].quality = view.items[0]._kpListedQuality = '1080p ';
  rt.storage.player = 'tvosl';
  view.options.onEnter(view.items[0]);
  assert.equal(rt.internal[0].url, signed);
});

test('explicit episode quality is identical in the main handoff and selected playlist entry', () => {
  const rt = native('tvos'); const {view} = source(rt, true);
  view.options.onEnter(view.items[1], {}, {quality: '1080p'});
  assert.equal(rt.internal[0].url, files[1].urls.hls2);
  assert.equal(rt.playlists[0][1].url, files[1].urls.hls2);
  assert.equal(rt.playlists[0][0].url, signed);
});

test('explicit native quality and format survive; saved limits are not changed', () => {
  const rt = native('tvospro', {kp_format: 'http'}); const {view} = source(rt);
  view.options.onEnter(view.items[0], {}, {quality: '1080p'});
  assert.equal(rt.internal[0].url, files[1].urls.http);
  assert.equal(rt.mediaRequests.length, 0, 'An explicit video file must not be downloaded as a manifest');
  assert.equal(rt.storage.kp_max_quality, '2160'); assert.equal(rt.storage.kp_format, 'http');
  const capped = native('tvos', {kp_max_quality: '1080'}); const second = source(capped);
  second.view.options.onEnter(second.view.items[0]);
  assert.equal(capped.internal[0].url, files[1].urls.hls2);
});

test('native handoff failure reports once and neither retries nor marks watched', () => {
  const rt = runtime({playerError: true, storage: {player: 'tvos', kp_token: 'dummy-fixture'}});
  const {view, marks} = source(rt);
  assert.doesNotThrow(() => view.options.onEnter(view.items[0]));
  rt.tickAll(); assert.equal(rt.internal.length, 0); assert.equal(rt.playlists.length, 0);
  assert.equal(rt.notices.length, 1); assert.match(rt.notices[0], /KP-A1/); assert.equal(marks(), 0);
  assert.equal(rt.mediaRequests.length, 0);
});

test('one-off web playback with a saved native player keeps web quality and recovery behavior', () => {
  const rt = native('tvos'); const {view} = source(rt);
  view.options.onEnter(view.items[0], {}, {player: 'lampa'});
  assert.equal(typeof rt.internal[0].error, 'function');
  assert.equal(typeof rt.internal[0].callback, 'function');
  assert.equal(Object.keys(rt.internal[0].quality).length, 2);
  assert.notEqual(rt.api.getPendingVoice(), null);
  assert.equal(rt.mediaRequests.length, 1); assert.equal(rt.launches.length, 0);
});
