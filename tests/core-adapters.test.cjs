'use strict';
// Execute the actual upstream JS adapter, not a native tvOS decoder.
// git clone https://github.com/yumata/lampa-source <reference directory>
// git -C <reference directory> checkout 7cb2ce0ce320070785ca0be4f43a14f638c1d7d8
// LAMPA_SOURCE_DIR=<reference directory> node --test tests/core-adapters.test.cjs
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = process.env.LAMPA_SOURCE_DIR || path.resolve(__dirname,'../../lampa-source');
const filename = path.join(root,'src/interaction/player.js');
const available = fs.existsSync(filename);
const source = available ? fs.readFileSync(filename,'utf8') : '';
function fn(name) {
  const start = source.indexOf('function '+name+'('), end = source.indexOf('\n}',start);
  assert.ok(start >= 0 && end > start, 'Expected upstream function '+name);
  return source.slice(start,end+2);
}
const schemes = {tvospro:['lampa:','tvospro'],tvos:['lampa:','tvos'],tvosl:['lampa:','tvosav'],
  tvosSelect:['lampa:','lists'],vlc:['vlc-x-callback:'],senplayer:['senplayer:'],vidhub:['open-vidhub:'],svplayer:['svplayer:']};
for (const [player,[protocol,native]] of Object.entries(schemes)) {
  test('upstream Apple TV adapter '+player+': actual encoded destination and payload', {skip: !available && 'Set LAMPA_SOURCE_DIR to the documented source revision'}, () => {
    const launches=[];
    const context={encodeURIComponent,encodeURI,JSON,
      Storage:{field:k=>k==='player'?player:''}, Torserver:{toPlayUrl:u=>u},
      Platform:{is:p=>p==='apple_tv',macOS:()=>false}, Video:{verifyTube:()=>false},
      Preroll:{show:(_d,cb)=>cb()},listener:{send(){}},window:{location:{assign:u=>launches.push(u)}}};
    vm.createContext(context);
    vm.runInContext('let launch_player;\n'+['externalPlayer','prepareInfuseLaunch','launchExternalPlayer','start'].map(fn).join('\n'),context);
    const data={url:'https://video.example/fixture/file?sig=a+b%2B%26&preload=1&x=?=',
      timeline:{time:127},subtitles:[{url:'https://sub.example/file.srt'}],voiceovers:[{index:1}],
      playlist:[{url:'https://video.example/fixture/part2',timeline:{time:237}}],segments:[{start:0,end:12}]};
    context.start(data,undefined,()=>assert.fail('No internal decoder may launch'));
    assert.equal(launches.length,1);
    const url=new URL(launches[0]); assert.equal(url.protocol,protocol);
    assert.equal(url.searchParams.get(native?'src':'url'),data.url);
    if(native) {
      assert.equal(url.searchParams.get('player'),native);
      assert.deepEqual(JSON.parse(url.searchParams.get('playlist')),data.playlist);
      assert.deepEqual(JSON.parse(url.searchParams.get('segments')),data.segments);
      assert.equal(url.searchParams.has('position'),false);
    } else assert.deepEqual([...url.searchParams.keys()],['url']);
  });
}

for(const platform of ['apple_tv','apple']) {
  test('upstream '+platform+' Infuse uses the unmodified core URL builder', {skip: !available && 'Set LAMPA_SOURCE_DIR'},()=>{
    const module=fs.readFileSync(path.join(root,'src/core/infusePlayer.js'),'utf8');
    const launches=[];
    const context={encodeURIComponent,encodeURI,JSON,
      Storage:{field:k=>k==='player'?'infuse':k==='infuse_launch_mode'?'play':''},
      Torserver:{toPlayUrl:u=>u},Utils:{clearHtmlTags:s=>s},Activity:{active:()=>({movie:{title:'Fixture'}})},
      Platform:{is:p=>p===platform,macOS:()=>false},Video:{verifyTube:()=>false},
      Preroll:{show:(_d,cb)=>cb()},listener:{send(){}},window:{location:{assign:u=>launches.push(u)}}};
    vm.createContext(context);
    vm.runInContext(module.replace(/^import .+$/gm,'').replace('export default {','globalThis.InfusePlayer = {'),context);
    vm.runInContext('let launch_player;\n'+['externalPlayer','prepareInfuseLaunch','launchExternalPlayer','start'].map(fn).join('\n'),context);
    const data={url:'https://video.example/master.m3u8?sig=a+b%2B%26&x=?=',title:'Fixture',timeline:{time:237},
      subtitles:[{url:'https://sub.example/caption.srt'}]};
    context.start(data,undefined,()=>assert.fail('No browser decoder may launch'));
    assert.equal(launches.length,1);
    const url=new URL(launches[0]);
    assert.equal(url.protocol,'infuse:');
    assert.equal(url.searchParams.get('url'),data.url);
    assert.equal(url.searchParams.get('position'),'237');
    assert.equal(url.searchParams.get('sub'),'https://sub.example/caption.srt');
  });
}
