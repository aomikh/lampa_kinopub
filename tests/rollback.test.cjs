'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {runtime}=require('./runtime.cjs');

test('mx.21 does not restore obsolete Infuse experiments, probing or launch tracing',()=>{
  const code=fs.readFileSync(path.join(__dirname,'../docs/kp.js'),'utf8');
  assert.match(code,/PLUGIN_VERSION\s*=\s*'1\.0\.73-mx\.21'/);
  assert.doesNotMatch(code,/infuseFileNetwork|earlyFile|deferAuthRefresh/);
  assert.doesNotMatch(code,/LaunchTrace|lastInfuseAttempt|probeInfuseResource|showInfuseDiagnostic|infuseHls2Test|InfuseVlcSource|kp_launch_trace|kp_infuse_delivery|kp_action_infuse_check|kp_trace_/);
});
for(const platform of ['apple_tv','apple','tizen']) test(platform+': settings preserve user preferences and add independent Infuse login only on Apple',()=>{
  const rt=runtime({platform,storage:{kp_token:'fixture',kp_infuse_delivery:'hls4',kp_launch_trace:true,
    kp_format_migrated_v4:'1',kp_format_migrated_v5:'1'}});
  const names=[];
  rt.Lampa.SettingsApi={addComponent(){},addParam(p){names.push(p.param.name);}};
  const before={...rt.storage};
  rt.api.addSettings();
  assert.deepEqual(names,['kp_log_url','kp_max_quality','kp_format',
    ...(platform==='tizen'?[]:['kp_action_infuse_login','kp_action_infuse_logout','kp_action_infuse_last_handoff']), 'kp_proxy','kp_subtitles_enabled',
    'kp_action_logout','kp_action_login','kp_action_region']);
  assert.deepEqual(rt.storage,platform==='tizen'?before:{...before,kp_infuse_format_v1:'http'});
  assert.equal(rt.requests.length,0);assert.equal(rt.mediaRequests.length,0);
});
test('saved mx.15 HLS4 and trace preferences cannot override restored file delivery',()=>{
  const rt=runtime({storage:{kp_token:'fixture',player:'infuse',kp_infuse_delivery:'hls4',kp_launch_trace:true}});
  assert.equal(rt.api.preferredFormat('infuse'),'http');
  const view={reset(){},loading(){},filter(){},draw(items,options){this.items=items;this.options=options;}};
  const src=new rt.api.kpapi(view,{movie:{id:123,title:'Fixture'}});
  const item={id:22,title:'Fixture',videos:[{files:[{quality:'1080p',file:'/fixture/movie.mp4',
    urls:{hls4:'https://video.example/hls4/file.mp4',http:'https://video.example/http/file.mp4'}}],audios:[]}]};
  src.find(22);rt.requests.at(-1).ok({item});
  view.options.onEnter(view.items[0]);rt.requests.at(-1).ok({item});
  const resolve=rt.requests.at(-1),params=new URL(resolve.url).searchParams;
  assert.equal(params.get('type'),'http');assert.equal(params.get('file'),'/fixture/movie.mp4');
  const signed='https://video.example/http/file.mp4?sig=a%2B+b%26&preload=1';
  resolve.ok({url:signed});
  assert.equal(new URL(rt.launches[0]).searchParams.get('url'),signed);
  assert.equal(rt.mediaRequests.length,0);assert.equal(rt.internal.length,0);
});
test('long-press keeps one Infuse action without quality selection, without one-off experiments',()=>{
  const rt=runtime(),c=new rt.api.component({movie:{id:123,title:'Fixture'}});
  c.draw([{title:'Fixture',kp:{kind:'movie',files:rt.api.parseFiles([{quality:'1080p',file:'/fixture/movie.mp4'}]),audios:[]}}],{
    onEnter(){},onContextMenu(_item,_html,_options,cb){cb({});}});
  rt.rows.at(-1).trigger('hover:long');
  const items=rt.menus.at(-1).items;
  assert.ok(items.some(i=>i.player==='infuse'));assert.equal(items.some(i=>i.infuseQuality),false);
  assert.ok(items.every(i=>!i.infuseHls2Test&&!i.infuseVlcSource));
  assert.equal(rt.requests.length,0);
});
