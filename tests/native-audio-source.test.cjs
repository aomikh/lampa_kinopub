'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {runtime}=require('./runtime.cjs');
const audios=[{index:1,lang:'rus',type:{title:'Дубляж'},author:{title:'Studio A'}},
 {index:2,lang:'rus',type:{title:'Дубляж'},author:{title:'Studio B'}},
 {index:3,lang:'eng',type:{title:'Оригинал'}},
 {index:4,lang:'fra',type:{title:'Оригинал'}}];
const files=[{quality:'1080p',file:'/movie.mp4',urls:{hls2:'https://cdn.example/single.m3u8',hls4:'https://cdn.example/master.m3u8?sig=a%2B+b'}}];
function source(rt, serial=false) {
 const view={reset(){},loading(){},filter(data){this.filters=data;},draw(items,options){this.items=items;this.options=options;}};
 const src=new rt.api.kpapi(view,{movie:{id:111,title:'Movie',name:serial?'Show':undefined}});
 const video={files,audios,subtitles:[{lang:'rus',url:'https://cdn.example/sub.srt'}]};
 src.find(22);rt.requests.at(-1).ok({item:serial?{id:22,title:'Show',seasons:[{number:1,episodes:[{number:1,...video},{number:2,...video}]}]}:{id:22,title:'Movie',videos:[video]}});
 view.items.forEach(e=>e.timeline={time:37,percent:1});return {view,src};
}
for(const player of ['tvosl','tvos','tvospro']) test(player+': full multi-audio source reaches the adapter without decorative voiceovers',()=>{
 const rt=runtime({storage:{kp_token:'catalog',player,kp_subtitles_enabled:true}});
 const {view}=source(rt);view.options.onEnter(view.items[0]);
 const play=rt.internal[0];
 assert.equal(play.url,files[0].urls.hls4);
 assert.equal(play.voiceovers,undefined);assert.equal(play.translate,undefined);
 assert.equal(rt.api.getPendingVoice(),null);
 assert.equal(play.playlist.length,1,'single movies also serialize timeline and subtitles');
 assert.equal(play.playlist[0].timeline.time,37);assert.equal(play.playlist[0].subtitles[0].url,'https://cdn.example/sub.srt');
 assert.equal(rt.storage.kp_format,'auto');
});
test('native audio names are informational and an old JS selection is not shown as an applied track',()=>{
 const rt=runtime({storage:{kp_token:'catalog',player:'tvospro'}});
 const {view,src}=source(rt);
 src.extendChoice({season:0,voice:1,voice_name:'Old selected voice',voice_key:'rus|fixture'});
 assert.equal(view.filters.voice.length,0);
 assert.equal(view.items[0].voice_name,'');
 const c=new rt.api.component({movie:{id:111,title:'Movie'}});
 c.draw(view.items,{onEnter(){}});
 assert.doesNotMatch(rt.rows.at(-1).element.voices,/kp-voice-chip[^\"]*is-active/);
});
test('browser audio discovery is not replaced with one fake voiceover',()=>{
 const rt=runtime({storage:{kp_token:'catalog',player:'inner'}});const {view}=source(rt);
 view.options.onEnter(view.items[0]);assert.equal(rt.internal[0].voiceovers,undefined);
});
test('explicit native and other player source preferences remain intact',()=>{
 const rt=runtime({storage:{player:'tvos',kp_format:'hls2'}});
 assert.equal(rt.api.preferredFormat('tvos'),'hls2');assert.equal(rt.api.preferredFormat('infuse'),'hls2');
 assert.equal(rt.api.preferredFormat('vlc'),'hls2');
});
test('native Auto cannot silently replace a missing master with a single video source',()=>{
 const rt=runtime({storage:{kp_token:'catalog',player:'tvos'}});
 const {view}=source(rt);
 view.items[0].kp.files[0].urls.hls4=null;
 view.options.onEnter(view.items[0]);
 assert.equal(rt.internal.length,0);
 assert.equal(rt.notices.at(-1),'online_nolink');
});
test('native source failure cannot change the explicit file quality',()=>{
 const rt=runtime({storage:{kp_token:'catalog',player:'tvosl'}});
 const {view}=source(rt);
 view.options.onEnter(view.items[0],{}, {quality:'720p'});
 assert.equal(rt.internal.length,0);
 assert.equal(rt.notices.at(-1),'online_nolink');
});
module.exports={source};
