'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {runtime}=require('./runtime.cjs');

test('plugin has no separate Infuse authorization, URL builder, resolver or diagnostics',()=>{
  const code=fs.readFileSync(path.join(__dirname,'../docs/kp.js'),'utf8');
  assert.equal(/KPInfuse|kp_infuse_|KEY_INFUSE|buildInfuseUrl|dispatchInfuse|launchInfuse|pickInfuseStream|infuseFileUrl|mediaVideoLink|_kpInfuse/.test(code),false);
  assert.equal(/infuse:\/\//.test(code),false);
});

for(const platform of ['apple_tv','apple','tizen']) test(platform+': only existing general KinoPub settings remain',()=>{
  const rt=runtime({platform,storage:{kp_token:'catalog',kp_max_quality:'2160',kp_format:'hls2',
    kp_format_migrated_v4:'1',kp_format_migrated_v5:'1',kp_infuse_format_v1:'http'}});
  const names=[];
  rt.Lampa.SettingsApi={addComponent(){},addParam(p){names.push(p.param.name);}};
  const before={...rt.storage};
  rt.api.addSettings();
  assert.deepEqual(names,['kp_log_url','kp_max_quality','kp_format','kp_proxy','kp_subtitles_enabled',
    'kp_action_logout','kp_action_login','kp_action_region']);
  assert.deepEqual(rt.storage,before);
  assert.equal(rt.requests.length,0);
});

for(const platform of ['apple_tv','apple']) test(platform+': saved Infuse choice uses the normal Lampa adapter and catalog source',()=>{
  const rt=runtime({platform,infuseLinked:false,storage:{kp_token:'catalog-access',kp_refresh:'catalog-refresh',
    player:'infuse',kp_max_quality:'1080',kp_subtitles_enabled:true}});
  const view={reset(){},loading(){},filter(){},draw(items,options){this.items=items;this.options=options;}};
  const src=new rt.api.kpapi(view,{movie:{id:111,title:'Fixture'}});
  const signed='https://cdn.example/master.m3u8?sig=a%2B+b%26';
  src.find(22);
  assert.equal(rt.requests[0].params.headers.Authorization,'Bearer catalog-access');
  rt.requests[0].ok({item:{id:22,title:'Fixture',videos:[{files:[{quality:'1080p',urls:{hls2:signed}}],
    subtitles:[{url:'https://subs.example/caption.srt',lang:'en'}]}]}});
  view.items[0].timeline={time:237,percent:12};
  view.options.onEnter(view.items[0]);
  assert.equal(rt.internal.length,1);
  assert.equal(rt.internal[0].url,signed);
  assert.equal(rt.internal[0].timeline.time,237);
  assert.equal(rt.internal[0].subtitles[0].url,'https://subs.example/caption.srt');
  assert.equal(rt.internal[0].quality,undefined);
  assert.equal(rt.internal[0].callback,undefined);
  assert.equal(rt.mediaRequests.length,0);
  assert.equal(rt.requests.length,1,'no second item, exact-file resolver or activation');
  assert.equal(rt.launches.length,0,'scheme is owned by Lampa, not this plugin');
  assert.equal(rt.storage.kp_token,'catalog-access');
  assert.equal(rt.storage.player,'infuse');
});

test('long press no longer adds a custom Infuse action',()=>{
  const rt=runtime(),c=new rt.api.component({movie:{id:123,title:'Fixture'}});
  c.draw([{title:'Fixture',kp:{kind:'movie',files:[],audios:[]}}],{
    onEnter(){},onContextMenu(_item,_html,_options,cb){cb({});}});
  rt.rows.at(-1).trigger('hover:long');
  assert.equal(rt.menus.at(-1).items.some(i=>i.player==='infuse'),false);
});
