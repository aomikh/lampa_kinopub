'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function runtime(options = {}) {
  const storage = {kp_max_quality: '1080', kp_format: 'auto', player: 'inner', ...options.storage};
  const requests = [], launches = [], internal = [], playlists = [], notices = [], logs = [], imageRequests = [], rows = [], scrolled = [], menus = [], modals = [];
  const timers = new Map();
  let timerId = 0;
  function setTimer(fn) { timers.set(++timerId, fn); return timerId; }
  function jq() {
    const children={}, events={}, data={}, classes=new Set();
    return {0: {src:'',removeAttribute() {this.src='';}}, length: 1, children, events, classes, content: [],
      find(selector) {return children[selector] || (children[selector]=jq());}, render: jq,
      on(event, fn) {events[event]=fn;return this;}, append(value) {this.content.push(value);return this;},
      after() {return this;}, remove() {this.removed=true;}, addClass(k) {classes.add(k);return this;},
      removeClass(k) {classes.delete(k);return this;}, toggleClass(k,v) {if(v) classes.add(k);else classes.delete(k);return this;},
      hasClass(k) {return classes.has(k);}, text(v) {this.value=v;return this;}, html(v) {this.value=v;return this;},
      first() {return this;}, trigger(event) {if(events[event]) events[event]();return this;},
      data(k,v) {if(arguments.length>1) {data[k]=v;return this;} return data[k];}, css() {return this;}};
  }
  class FakeImage {
    constructor() {imageRequests.push(this);}
    set src(value) {this._src=value;}
    get src() {return this._src;}
    removeAttribute() {this._src='';}
  }
  function network() {
    this.owned = [];
    this.silent = this.native = (url, ok, fail) => {
      const request = {url, ok, fail, cleared: false};
      requests.push(request); this.owned.push(request);
    };
    this.timeout = () => {};
    this.clear = () => this.owned.forEach(r => r.cleared = true);
  }
  function moduleStub() {
    this.render = this.body = jq;
    for (const k of ['append','update','clear','destroy','minus','appendFiles','appendHead','set','chosen','show','addButtonBack']) this[k] = () => {};
    this.append = row => scrolled.push(row);
    this.clear = () => scrolled.splice(0);
  }
  const Lampa = {
    Manifest: {app_digital: 200},
    Storage: {get: (k,d) => k in storage ? storage[k] : d, field: k => storage[k], set: (k,v) => storage[k]=v,
      cache: (k,_n,d) => k in storage ? storage[k] : (storage[k]=d), remove: k => delete storage[k]},
    Utils: {uid: () => 'fixture', hash: s => String(s), secondsToTime: () => '', cardImgBackgroundBlur: () => ''},
    Lang: {translate: k => k, add() {}},
    Reguest: network,
    Arrays: {extend: (a,b,force) => {for (const k in b) if (force || !(k in a)) a[k]=b[k];},
      remove: (a,v) => a.splice(a.indexOf(v),1)},
    Platform: {is: p => p === (options.platform || 'apple_tv')},
    Noty: {show: text => notices.push(text)},
    Player: {play: data => internal.push(data), playlist: list => playlists.push(list), runas() {}},
    Scroll: moduleStub, Explorer: moduleStub, Filter: moduleStub,
    Template: {get(name, data, text) {
      if(text) return '<rate>'+data.rate+'</rate>';
      const row=jq(); row.template=name; row.element=data;
      if(name==='online_prestige_full') rows.push(row);
      return row;
    }}, TMDB: {key: () => 'public-test-key', api: u => 'https://tmdb.example/' + u, image: u => 'https://image.example/' + u},
    Timeline: {view: () => ({time: 37,percent: 0}), render: jq, update() {}},
    Controller: {enable() {}, enabled: () => ({name:'content'}), toggle() {}},
    Activity: {active: () => ({})}, Favorite: {add() {}}, Helper: {show() {}}, Select: {show: menu => menus.push(menu)},
    Modal: {open: modal => modals.push(modal), close() {}}
  };
  const sandbox = {URL, Image: FakeImage, console: Object.fromEntries(['log','warn','error'].map(k => [k,(...args) => logs.push(args)])),
    navigator: {userAgent: 'test'}, $, Lampa, document: {},
    setTimeout: setTimer, clearTimeout: id => timers.delete(id), setInterval: setTimer, clearInterval: id => timers.delete(id),
    window: {Lampa,innerWidth:1920, fetch:options.fetch, AbortController:globalThis.AbortController,
      addEventListener() {}, location: {assign: url => {if (options.dispatchError) throw Error('fixture dispatch error'); launches.push(url);}}}};
  function $(arg) {return jq(arg);}
  let code = fs.readFileSync(path.join(__dirname,'../docs/kp.js'),'utf8');
  const exports = ['parseFiles','pickStream','preferredFormat','proxyUrlFor','detectActualPlayer','numberValue','buildInfuseUrl',
    'dispatchInfuse','kpapi','component','redactDiagnostic','resourceInfo','thumbnailUrl','tmdbStillUrl','episodeImages',
    'tmdbSeriesId','sameSeries','findEpisode','loadImageCandidates','probeInfuseResource','showInfuseDiagnostic'];
  code = code.replace('  startPlugin();', 'window.testAPI = {' + exports.join(',') + ',setProxy: function(v){kpProxyAvailable=v;},setFormat: function(v){formatOverride=v;}};');
  vm.runInNewContext(code,sandbox,{filename:'kp.js'});
  return {api: sandbox.window.testAPI, storage, requests, launches, internal, playlists, notices, logs, timers, Lampa, imageRequests, rows, scrolled, menus, modals,
    tickAll() {const active = [...timers.values()]; timers.clear(); active.forEach(fn => fn());}};
}
module.exports = {runtime};
