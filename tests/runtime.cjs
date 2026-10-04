'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function runtime(options = {}) {
  const storage = {kp_max_quality: '1080', kp_format: 'auto', player: 'inner', ...options.storage};
  const requests = [], launches = [], internal = [], notices = [], logs = [];
  const timers = new Map();
  let timerId = 0;
  function setTimer(fn) { timers.set(++timerId, fn); return timerId; }
  function jq() {
    return {0: {}, length: 1, find: jq, render: jq, on() {return this;}, append() {return this;},
      after() {return this;}, remove() {}, addClass() {return this;}, removeClass() {return this;},
      toggleClass() {return this;}, hasClass() {return false;}, text() {return this;}, html() {return this;},
      first() {return this;}, trigger() {return this;}, data() {return this;}, css() {return this;}};
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
    Player: {play: data => internal.push(data), playlist() {}, runas() {}},
    Scroll: moduleStub, Explorer: moduleStub, Filter: moduleStub,
    Template: {get: jq}, TMDB: {key: () => 'public-test-key', api: u => 'https://tmdb.example/' + u, image: u => 'https://image.example/' + u},
    Timeline: {view: () => ({time: 37,percent: 0}), render: jq, update() {}},
    Controller: {enable() {}, enabled: () => ({name:'content'}), toggle() {}},
    Activity: {active: () => ({})}, Favorite: {add() {}}, Helper: {show() {}}
  };
  const sandbox = {URL, console: Object.fromEntries(['log','warn','error'].map(k => [k,(...args) => logs.push(args)])),
    navigator: {userAgent: 'test'}, $, Lampa, document: {},
    setTimeout: setTimer, clearTimeout: id => timers.delete(id), setInterval: setTimer, clearInterval: id => timers.delete(id),
    window: {Lampa, addEventListener() {}, location: {assign: url => {if (options.dispatchError) throw Error('fixture dispatch error'); launches.push(url);}}}};
  function $(arg) {return jq(arg);}
  let code = fs.readFileSync(path.join(__dirname,'../docs/kp.js'),'utf8');
  const exports = ['parseFiles','pickStream','preferredFormat','proxyUrlFor','detectActualPlayer','numberValue','buildInfuseUrl',
    'dispatchInfuse','kpapi','component','redactDiagnostic','resourceInfo'];
  code = code.replace('  startPlugin();', 'window.testAPI = {' + exports.join(',') + ',setProxy: function(v){kpProxyAvailable=v;},setFormat: function(v){formatOverride=v;}};');
  vm.runInNewContext(code,sandbox,{filename:'kp.js'});
  return {api: sandbox.window.testAPI, storage, requests, launches, internal, notices, logs, timers, Lampa,
    tickAll() {const active = [...timers.values()]; timers.clear(); active.forEach(fn => fn());}};
}
module.exports = {runtime};
