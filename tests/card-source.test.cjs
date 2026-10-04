'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {runtime} = require('./runtime.cjs');

// Small DOM fixture, limited to the jQuery operations used by card mounting.
// The hierarchy matches full_start_new in Lampa 335 (b4a13b6): the Sources
// container is hidden, while the main button row is visible.
function dom() {
  function node(classes, markup = '') {
    return {classes: new Set(classes.split(/\s+/)), children: [], events: [], parent: null, markup};
  }
  function matches(n, selector) {
    return selector.trim().split('.').filter(Boolean).every(c => n.classes.has(c));
  }
  function descendants(n) {return n.children.flatMap(c => [c, ...descendants(c)]);}
  function wrap(nodes) {
    const q = {length: nodes.length, nodes};
    nodes.forEach((n,i) => q[i] = n);
    q.find = selectors => wrap(nodes.flatMap(n => descendants(n)).filter(n => selectors.split(',').some(s => {
      const parts = s.split('>');
      return matches(n, parts.at(-1)) && (parts.length === 1 || n.parent && matches(n.parent, parts[0]));
    })));
    q.first = () => wrap(nodes.slice(0,1));
    q.remove = () => {nodes.forEach(n => {if(n.parent) n.parent.children = n.parent.children.filter(c => c !== n); n.parent = null;}); return q;};
    q.append = other => {other.remove(); other.nodes.forEach(n => {n.parent=nodes[0]; nodes[0].children.push(n);}); return q;};
    q.after = other => {if(nodes[0] && nodes[0].parent) {const p=nodes[0].parent; other.remove(); other.nodes.forEach((n,i) => {n.parent=p;p.children.splice(p.children.indexOf(nodes[0])+1+i,0,n);});} return q;};
    q.on = (event, fn) => {nodes.forEach(n => n.events.push({event,fn}));return q;};
    q.off = event => {
      nodes.forEach(n => n.events=n.events.filter(h => {
        if(!event) return false;
        const [type,ns]=event.split('.'), [ht,hn]=h.event.split('.');
        return !((!type || type===ht) && (!ns || ns===hn));
      })); return q;
    };
    q.trigger = event => {nodes.forEach(n => n.events.slice().filter(h=>h.event.split('.')[0]===event).forEach(h=>h.fn()));return q;};
    q.toggleClass = (name, yes) => {nodes.forEach(n => yes ? n.classes.add(name) : n.classes.delete(name));return q;};
    q.removeClass = name => q.toggleClass(name,false);
    q.hasClass = name => !!nodes[0] && nodes[0].classes.has(name);
    return q;
  }
  function $(arg) {
    if (typeof arg === 'string') return wrap([node(arg.match(/class="([^"]*)"/)[1], arg)]);
    return arg && arg.nodes ? arg : wrap(arg ? [arg] : []);
  }
  return {$, make: classes => wrap([node(classes)])};
}

function fixture({platform='apple_tv', modern=true, torrent=true, priority='another-source', hasWatch=true} = {}) {
  const d=dom(), rt=runtime({platform,jquery:d.$,storage:{full_btn_priority:priority}});
  const holder=d.make('full-start-new'), visible=d.make(modern ? 'full-start-new__buttons' : 'full-start__buttons');
  holder.append(visible);
  const watch=d.make('full-start__button selector button--play');
  if(hasWatch) visible.append(watch);
  const sources=d.make('hide buttons--container');
  if(modern) {
    holder.append(sources);
    if(torrent) sources.append(d.make('full-start__button view--torrent hide'));
    sources.append(d.make('full-start__button selector view--trailer'));
  }
  const start={modules:[],use(m){this.modules.push(m);},unuse(m){this.modules=this.modules.filter(x=>x!==m);},emit(name){for(const m of this.modules) if(m[name]) m[name]();}};
  // Lampa's core owns/replaces Watch handlers before the appended plugin hook.
  // Simulate that lifecycle to catch the mx.7 regression on re-entry as well.
  const coreMenus=[], focus=[];
  start.use({onGroupButtons(){watch.off().on('hover:enter',()=>coreMenus.push('sources')).on('hover:focus',()=>focus.push('watch'));}});
  start.emit('onGroupButtons');
  const movie={id:123,title:'Fixture movie',original_title:'Original fixture'};
  const event={type:'complite',body:holder,link:{items:[start]},data:{movie},object:{activity:{render:()=>holder}}};
  const activities=[],registered=[];
  rt.Lampa.Template.add=()=>{};
  rt.Lampa.Component={add:(name,component)=>registered.push({name,component})};
  rt.Lampa.Activity.push=value=>activities.push(value);
  rt.Lampa.Favorite.add=()=>assert.fail('Opening a source must not mark the movie watched');
  return {...rt,...d,holder,visible,sources,watch,start,event,movie,activities,registered,coreMenus,focus};
}

test('Apple TV: ordinary Watch opens KinoPub without a source menu or separate button',()=>{
  const f=fixture(); f.api.mountKinoPubCard(f.event);
  assert.equal(f.holder.find('.buttons--container > .view--kinopub').length,1);
  assert.equal(f.visible.find('.kp-card-direct, .view--kinopub').length,0);
  f.watch.trigger('hover:enter');
  assert.equal(f.activities.length,1); assert.equal(f.coreMenus.length,0);
  assert.equal(f.storage.full_btn_priority,'another-source');
});

test('both entries open the same KinoPub activity for the exact movie, without media or watched side effects',()=>{
  const f=fixture(); f.api.mountKinoPubCard(f.event);
  f.sources.find('.view--kinopub').trigger('hover:enter');
  f.watch.trigger('hover:enter');
  assert.equal(f.activities.length,2);
  for(const a of f.activities) {
    assert.equal(a.component,'online_kp'); assert.equal(a.movie,f.movie);
    assert.equal(a.search,'Fixture movie'); assert.equal(a.search_two,'Original fixture');
  }
  assert.equal(f.registered.length,2);
  assert.equal(f.requests.length,0); assert.equal(f.launches.length,0); assert.equal(f.internal.length,0);
});

test('repeated completion keeps one source and activation without extra buttons or observers',()=>{
  const f=fixture(); f.api.mountKinoPubCard(f.event); f.api.mountKinoPubCard(f.event);
  assert.equal(f.sources.find('.view--kinopub').length,1);
  assert.equal(f.visible.find('.kp-card-direct').length,0);
  assert.equal(f.start.modules.length,2); assert.equal(f.timers.size,0);
  f.watch.trigger('hover:enter'); assert.equal(f.activities.length,1); assert.equal(f.coreMenus.length,0);
});

test('native KinoPub pin cannot create a second KinoPub button; other pins/preferences remain',()=>{
  const f=fixture(); f.api.mountKinoPubCard(f.event);
  const pin=f.make('full-start__button button--priority view--kinopub'); f.visible.append(pin);
  f.start.emit('onPriorityButton'); assert.equal(f.visible.find('.view--kinopub').length,0);
  f.visible.append(f.make('full-start__button button--priority another-source'));
  f.start.emit('onPriorityButton'); assert.equal(f.visible.find('.another-source').length,1);
  assert.equal(f.storage.full_btn_priority,'another-source');
  f.watch.trigger('hover:enter'); assert.equal(f.activities.length,1); assert.equal(f.coreMenus.length,0);
});

test('returning to the card rebinds Watch after core grouping and preserves focus handling',()=>{
  const f=fixture(); f.api.mountKinoPubCard(f.event);
  for(let i=0;i<3;i++) {f.start.emit('onGroupButtons'); f.watch.trigger('hover:enter'); f.watch.trigger('hover:focus');}
  assert.equal(f.activities.length,3); assert.equal(f.coreMenus.length,0); assert.equal(f.focus.length,3);
  assert.equal(f.watch.hasClass('hide'),false);
});

test('destroy cancels card activation; a stale callback cannot open the movie',()=>{
  const f=fixture(); f.api.mountKinoPubCard(f.event);
  const stale=f.watch[0].events.find(h=>h.event==='hover:enter.kpWatch').fn;
  f.start.emit('onDestroy'); stale(); f.watch.trigger('hover:enter'); f.start.emit('onGroupButtons');
  assert.equal(f.activities.length,0);
});

test('switching cards does not reuse the previous movie',()=>{
  const f=fixture(); f.api.mountKinoPubCard(f.event);
  const stale=f.watch[0].events.find(h=>h.event==='hover:enter.kpWatch').fn;
  const next={id:456,title:'Another fixture'}; f.event.data.movie=next;
  f.api.mountKinoPubCard(f.event); stale(); f.watch.trigger('hover:enter');
  assert.equal(f.activities.length,1); assert.equal(f.activities[0].movie,next);
});

test('modern layout without torrent anchor still exposes KinoPub through Sources',()=>{
  const f=fixture({torrent:false}); f.api.mountKinoPubCard(f.event);
  assert.equal(f.holder.find('.buttons--container > .view--kinopub').length,1);
});

test('Tizen retains the grouped source, without the Apple TV shortcut',()=>{
  const f=fixture({platform:'tizen'}); f.api.mountKinoPubCard(f.event);
  assert.equal(f.sources.find('.view--kinopub').length,1);
  assert.equal(f.visible.find('.kp-card-direct').length,0); assert.equal(f.start.modules.length,1);
  f.start.emit('onGroupButtons'); f.watch.trigger('hover:enter');
  assert.equal(f.coreMenus.length,1); assert.equal(f.activities.length,0);
});

test('legacy layout with Watch and activity.render fallback opens KinoPub without extra entry',()=>{
  const f=fixture({modern:false}); delete f.event.body; f.api.mountKinoPubCard(f.event);
  assert.equal(f.visible.find('.view--kinopub').length,0);
  assert.equal(f.visible.find('.kp-card-direct').length,0);
  f.watch.trigger('hover:enter'); assert.equal(f.activities.length,1);
});

test('legacy layout without Watch retains its original source button',()=>{
  const f=fixture({modern:false,hasWatch:false}); f.api.mountKinoPubCard(f.event);
  assert.equal(f.visible.find('.view--kinopub').length,1);
});

test('missing movie cannot mount or launch a stale card',()=>{
  const f=fixture(); f.event.data={}; f.api.mountKinoPubCard(f.event);
  assert.equal(f.holder.find('.view--kinopub').length,0); assert.equal(f.activities.length,0);
});

test('source markup has no release version, so later version bumps preserve its pin hash',()=>{
  const f=fixture(); const markup=f.api.kinoPubCardButton('view--online view--kinopub')[0].markup;
  assert.match(markup,/data-subtitle="KinoPub"/); assert.doesNotMatch(markup,/mx\.|1\.0\.73/);
});
