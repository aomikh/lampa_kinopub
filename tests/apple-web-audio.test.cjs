'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {runtime} = require('./runtime.cjs');
const root = process.env.LAMPA_SOURCE_DIR || path.resolve(__dirname, '../../lampa-source');
const filename = path.join(root, 'src/interaction/player.js');
const available = fs.existsSync(filename);
const upstream = available ? fs.readFileSync(filename, 'utf8') : '';

function fixture(player, serial, platform = 'apple_tv') {
  const rt = runtime({platform, storage: {player, kp_token:'fixture', kp_format:'hls4', kp_subtitles_enabled:true}});
  const view = {reset(){},loading(){},filter(){},draw(items, options){this.items=items;this.options=options;}};
  const src = new rt.api.kpapi(view, {movie:{id:100,title:'Fixture',name:serial?'Fixture':undefined}});
  const video = {files:[{quality:'1080p',urls:{hls4:'https://video.example/multi.m3u8?sig=a%2Bb&token=fixture'}}],
    audios:[{lang:'ru',index:1},{lang:'en',index:2}], subtitles:[{lang:'en',url:'https://video.example/sub.srt'}]};
  src.find(77);
  rt.requests.at(-1).ok({item:serial?{id:77,title:'Fixture',seasons:[{number:1,episodes:[1,2].map(number=>({number,...video}))}]}:
    {id:77,title:'Fixture',videos:[video]}});
  view.items.forEach(e=>{e.timeline={time:91,percent:10};e.mark=()=>{};});
  view.options.onEnter(view.items[0]);
  return {rt,video};
}

function deliverDiscoveredTracks(work, tracks) {
  // Run the real core listener: voiceovers suppresses this event even if
  // the underlying media exposes multiple selectable tracks.
  const start = upstream.indexOf("Video.listener.follow('tracks',");
  const end = upstream.indexOf('\n    })', start);
  assert.ok(start>=0 && end>start, 'Expected upstream audio-track listener');
  let receive;
  const rendered=[];
  vm.runInNewContext(upstream.slice(start,end+7), {
    work, Video:{listener:{follow(_name,fn){receive=fn;}}}, Panel:{setTracks(v){rendered.push(v);}}
  });
  receive({tracks});
  return rendered;
}

for (const player of ['inner','lampa']) for (const serial of [false,true]) {
  test(`Apple TV ${player}: discovered audio remains selectable for ${serial?'episodes':'movie'}`,
    {skip:!available && 'Set LAMPA_SOURCE_DIR to the documented core revision'}, ()=>{
      const {rt,video}=fixture(player,serial);
      const discovered=[{name:'Russian',index:0},{name:'English',index:1},{name:'Commentary',index:2}];
      for(const play of [rt.internal[0],...rt.playlists[0]]) {
        const rendered=deliverDiscoveredTracks(play,discovered);
        assert.equal(rendered.length,1,'Plugin must not suppress real discovered tracks');
        assert.equal(rendered[0],discovered);
        assert.equal(play.url,video.files[0].urls.hls4);
        assert.equal(play.timeline.time,91);
        assert.equal(play.subtitles[0].url,video.subtitles[0].url);
        assert.equal(play.translate,undefined,'Do not claim the filter label is the current player track');
      }
      assert.notEqual(rt.api.getPendingVoice(),null,'Existing initial voice preference stays available');
      assert.equal(rt.mediaRequests.length,0);
      assert.equal(rt.requests.length,1);
      assert.equal(rt.storage.kp_format,'hls4');
    });
}

test('Tizen retains its legacy voice list when the manifest proxy is unavailable',()=>{
  const {rt}=fixture('tizen',false,'tizen');
  assert.equal(rt.internal[0].voiceovers.length,1);
  assert.notEqual(rt.internal[0].translate,undefined);
});
