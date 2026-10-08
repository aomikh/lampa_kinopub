'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {runtime}=require('./runtime.cjs');

test('Infuse launches 4K despite a saved 1080p limit and an obsolete manual 720p option',()=>{
  const rt=runtime({storage:{kp_token:'fixture',player:'inner'}});
  const view={reset(){},loading(){},filter(){},draw(items,options){this.items=items;this.options=options;}};
  const src=new rt.api.kpapi(view,{movie:{id:111,title:'Fixture'}});
  const item={id:22,title:'Fixture',videos:[{files:[
    {quality:'2160p',file:'/fixture/4k.mp4',urls:{hls2:'https://cdn.example/4k.m3u8'}},
    {quality:'1080p',file:'/fixture/1080.mp4',urls:{hls2:'https://cdn.example/1080.m3u8'}},
    {quality:'720p',file:'/fixture/720.mp4',urls:{http:'https://cdn.example/720.mp4'}}
  ]}]};
  src.find(22);rt.requests.at(-1).ok({item});
  view.options.onEnter(view.items[0],{}, {player:'infuse',quality:'720p'});rt.requests.at(-1).ok({item});
  const query=new URL(rt.requests.at(-1).url).searchParams;
  assert.equal(query.get('file'),'/fixture/4k.mp4');assert.equal(query.get('type'),'http');
  const signed='https://cdn.example/http/4k.mp4?sig=a%2B+b%26&x=1&x=2';
  rt.requests.at(-1).ok({url:signed});
  assert.equal(new URL(rt.launches[0]).searchParams.get('url'),signed);
  assert.equal(rt.storage.kp_max_quality,'1080');assert.equal(rt.storage.player,'inner');
  view.options.onEnter(view.items[0],{}, {player:'lampa'});
  assert.equal(rt.internal[0].url,'https://cdn.example/1080.m3u8');
});

test('Infuse has one launch action without a quality submenu or background requests',()=>{
  const rt=runtime(),c=new rt.api.component({movie:{id:111,title:'Fixture'}}),calls=[];
  c.draw([{title:'Fixture',kp:{kind:'movie',files:rt.api.parseFiles([
    {quality:'2160p',file:'/fixture/4k.mp4'}, {quality:'1080p',file:'/fixture/1080.mp4'}]),audios:[]}}],{
    onEnter:(item,html,options)=>calls.push(options),onContextMenu:(item,html,options,cb)=>cb({})
  });
  rt.rows.at(-1).trigger('hover:long');const menu=rt.menus.at(-1);
  assert.equal(menu.items.some(i=>i.infuseQuality),false);
  menu.onSelect(menu.items.find(i=>i.player==='infuse'));
  assert.equal(calls.length,1);assert.equal(calls[0].player,'infuse');assert.equal(calls[0].quality,undefined);
  assert.equal(rt.menus.length,1);assert.equal(rt.requests.length,0);
});

test('saved Infuse displays the maximum file quality even when only a file reference is available',()=>{
  const rt=runtime({storage:{kp_token:'fixture',player:'infuse',kp_max_quality:'1080'}});
  const view={reset(){},loading(){},filter(){},draw(items,options){this.items=items;this.options=options;}};
  const src=new rt.api.kpapi(view,{movie:{id:111,title:'Fixture'}});
  src.find(22);rt.requests.at(-1).ok({item:{id:22,title:'Fixture',videos:[{files:[
    {quality:'2160p',file:'/fixture/4k.mp4'},
    {quality:'1080p',file:'/fixture/1080.mp4',urls:{http:'https://cdn.example/1080.mp4'}}
  ]}]}});
  assert.equal(view.items[0].quality.trim(),'2160p');assert.equal(rt.requests.length,1);
});

test('Infuse cannot reduce quality when the maximum has no playable http resource',()=>{
  const rt=runtime({storage:{kp_token:'fixture',player:'inner'}});
  const view={reset(){},loading(){},filter(){},draw(items,options){this.items=items;this.options=options;}};
  const src=new rt.api.kpapi(view,{movie:{id:111,title:'Fixture'}});
  const item={id:22,title:'Fixture',videos:[{files:[
    {quality:'2160p',urls:{hls2:'https://cdn.example/4k.m3u8'}},
    {quality:'1080p',file:'/fixture/1080.mp4',urls:{http:'https://cdn.example/1080.mp4',hls2:'https://cdn.example/1080.m3u8'}}
  ]}]};
  src.find(22);rt.requests.at(-1).ok({item});
  view.options.onEnter(view.items[0],{}, {player:'infuse'});rt.requests.at(-1).ok({item});
  assert.equal(rt.launches.length,0);assert.equal(rt.requests.some(r=>r.url.includes('/media-video-link?')),false);
  assert.match(rt.notices.at(-1),/KP-I2/);
});
