'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {runtime} = require('./runtime.cjs');

function fixture(movie = {}) {
  const rt = runtime({storage: {kp_token: 'dummy-fixture'}});
  const object = {movie: {id: 123, source: 'tmdb', title: 'Fixture', original_title: 'Original', release_date: '2000-01-01', ...movie}};
  const view = {draws: 0, errors: 0, candidates: [], reset() {}, loading() {}, filter() {},
    draw() {this.draws++;}, doesNotAnswer() {this.errors++;}, similars(items) {this.candidates=items;}};
  const src = new rt.api.kpapi(view, object);
  return {...rt, object, view, src, search() {src.searchByTitle(object,'Original'); return rt.requests.at(-1);}};
}
const candidate = (extra = {}) => ({id: 9, title: 'Fixture / Original', type: 'movie', year: 2000, ...extra});

for (const wrong of [candidate({title:'Unrelated',year:2020}), candidate({year:2001}), candidate({type:'serial'}), candidate({imdb:999})]) {
  test('unverified single result cannot replace the requested material: '+JSON.stringify(wrong), () => {
    const f=fixture({imdb_id:'tt123'}); f.search().ok({items:[wrong]});
    assert.equal(f.requests.length,1); assert.equal(f.view.draws,0);
    assert.equal(f.view.errors,1);
  });
}
test('exact title/year/type identifies KinoPub id without mixing it with TMDB', () => {
  const f=fixture(); f.search().ok({items:[candidate()]});
  assert.equal(new URL(f.requests.at(-1).url).pathname,'/v1/items/9');
  assert.notEqual(new URL(f.requests.at(-1).url).pathname,'/v1/items/123');
});
test('exact external id wins over different release dates; ambiguous editions require selection', () => {
  const f=fixture({imdb_id:'tt000123'}); f.search().ok({items:[candidate({imdb:123,year:2001})]});
  assert.equal(f.requests.length,2);
  const g=fixture(); g.search().ok({items:[candidate(),candidate({id:10})]});
  assert.equal(g.requests.length,1); assert.equal(g.view.candidates.length,2);
});
test('late search, duplicate result and close cannot load a previous card', () => {
  const f=fixture(); const old=f.search(); const current=f.search();
  old.ok({items:[candidate({id:8})]}); assert.equal(f.requests.length,2);
  current.ok({items:[candidate()]}); current.ok({items:[candidate()]}); assert.equal(f.requests.length,3);
  const pending=f.requests.at(-1); f.src.destroy(); pending.ok({item:{id:9,videos:[]}});
  assert.equal(f.view.draws,0);
});
test('search timeout ignores a late response without retry', () => {
  const f=fixture(); const pending=f.search(); f.tickAll(); pending.ok({items:[candidate()]});
  assert.equal(f.requests.length,1); assert.equal(f.view.errors,1);
});
test('find rejects wrong material id and ignores superseded responses', () => {
  const f=fixture(); f.src.find(9); const old=f.requests.at(-1); f.src.find(10);
  old.ok({item:{id:9,videos:[]}}); assert.equal(f.view.draws,0);
  f.requests.at(-1).ok({item:{id:999,videos:[]}}); assert.equal(f.view.draws,0); assert.equal(f.view.errors,1);
});
