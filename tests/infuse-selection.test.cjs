'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {runtime} = require('./runtime.cjs');

function episode() {
  const rt = runtime({storage: {kp_token: 'dummy-fixture', player: 'infuse', kp_max_quality: '2160'}});
  const file = (name, quality = '1080p') => ({file: '/fixture/' + name + '.mp4', quality,
    urls: {http: 'https://video.example/' + name + '.mp4?sig=a+b%26&x=?=', hls2: 'https://video.example/' + name + '.m3u8'}});
  const original = file('original');
  const item = {id: 22, seasons: [{number: 1, episodes: [{number: 2, files: [original]}]}]};
  const view = {reset() {}, loading() {}, filter() {}, draw(items, options) {this.items = items; this.options = options;}};
  const src = new rt.api.kpapi(view, {movie: {id: 11, name: 'Fixture'}});
  src.find(22); rt.requests.at(-1).ok({item});
  view.items[0].timeline = {time: 127};
  view.options.onEnter(view.items[0]);
  return {rt, view, src, item, file, original, refresh: rt.requests.at(-1)};
}

test('normal Infuse pins the selected episode file and quality across reordered/refreshed metadata', () => {
  const {rt, item, file, original, refresh} = episode();
  item.seasons[0].episodes[0].files = [file('new-4k', '2160p'), file('other-1080'), original];
  refresh.ok({item});
  const resolve = rt.requests.at(-1), params = new URL(resolve.url).searchParams;
  assert.equal(params.get('file'), original.file);
  assert.equal(params.get('type'), 'http');
  resolve.ok({url: original.urls.http});
  const handed = new URL(rt.launches[0]).searchParams;
  assert.equal(handed.get('url'), original.urls.http);
  assert.equal(handed.get('position'), '127');
  assert.equal(rt.internal.length, 0); assert.equal(rt.mediaRequests.length, 0);
});

test('a disappeared selected file fails instead of substituting the same resolution', () => {
  const {rt, item, file, refresh} = episode();
  item.seasons[0].episodes[0].files = [file('replacement')];
  refresh.ok({item});
  assert.equal(rt.requests.length, 2); assert.equal(rt.launches.length, 0);
  assert.equal(rt.notices.length, 1);
});

test('choosing another player cancels a pending Infuse refresh', () => {
  const {rt, view, item, refresh} = episode();
  rt.storage.player = 'vlc';
  view.options.onEnter(view.items[0]);
  refresh.ok({item}); rt.tickAll();
  assert.equal(rt.launches.length, 0); assert.equal(rt.internal.length, 1);
  assert.equal(rt.requests.length, 2);
});

test('opening another material invalidates the pending Infuse operation', () => {
  const {rt, src, item, refresh} = episode();
  src.find(33); refresh.ok({item});
  assert.equal(rt.launches.length, 0); assert.equal(rt.requests.length, 3);
});
