'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
// Retained direct-file mode; production-default HLS4 is covered in infuse-hls4.test.cjs.
const {fileInfuseRuntime: runtime}=require('./runtime.cjs');

function qualityMenu(rt) {
  const c=new rt.api.component({movie:{id:111,title:'Fixture'}}), calls=[];
  const files=rt.api.parseFiles([
    {quality:'2160p',file:'/private-fixture/4k.mp4'},
    {quality:'1080p',file:'/private-fixture/1080.mp4'},
    {quality:'720p',urls:{http:'https://video.example/private-fixture/720.mp4?sig=fake'}},
    {quality:'720p',file:'/private-fixture/duplicate.mp4'},
    {quality:'480p',urls:{hls:'https://video.example/hls/480.m3u8'}}
  ]);
  c.draw([{title:'Fixture',quality:'1080p',kp:{kind:'movie',files,audios:[]}}],{
    onEnter:(item,html,options)=>calls.push(options),
    onContextMenu:(item,html,options,cb)=>cb({})
  });
  rt.rows.at(-1).trigger('hover:long');
  const actions=rt.menus.at(-1);
  const choice=actions.items.find(i=>i.infuseQuality);
  if(choice) actions.onSelect(choice);
  return {c,calls,choice,menu:rt.menus.at(-1)};
}
test('Infuse quality menu exposes only real, unique choices under the saved limit without network work',()=>{
  const rt=runtime(),{calls,menu}=qualityMenu(rt);
  assert.deepEqual(Array.from(menu.items,i=>i.title),['1080p','720p']);
  assert.doesNotMatch(JSON.stringify(menu.items),/private-fixture|sig=|https/);
  assert.equal(rt.requests.length,0);assert.equal(rt.launches.length,0);
  menu.onBack();assert.equal(calls.length,0);
  menu.onSelect(menu.items[1]);
  assert.equal(calls.length,1);assert.equal(calls[0].player,'infuse');assert.equal(calls[0].quality,'720p');
  assert.equal(rt.storage.player,'inner');assert.equal(rt.storage.kp_max_quality,'1080');
});
test('quality menu from a reset or closed card cannot launch the old movie',()=>{
  for (const action of ['reset','destroy']) {
    const rt=runtime(),{c,calls,menu}=qualityMenu(rt);
    c[action]();menu.onSelect(menu.items[1]);
    assert.equal(calls.length,0);assert.equal(rt.launches.length,0);
  }
});
test('Infuse-only menu does not change Tizen controls',()=>{
  const rt=runtime({platform:'tizen',storage:{player:'tizen'}}),{choice}=qualityMenu(rt);
  assert.equal(choice,undefined);assert.equal(rt.requests.length,0);
});
