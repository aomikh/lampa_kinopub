'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {runtime}=require('./runtime.cjs');
const thumb='https://images.kp.example/ep-1.jpg';
function component(rt) {
  return new rt.api.component({movie:{id:111,name:'Fixture',original_name:'Fixture',first_air_date:'2011-01-01'},source:'tmdb'});
}
function items(season=1) {
  return [1,2].map(n=>({season,episode:n,title:'Episode '+n,thumb,tmdb_id:111,kp:{audios:[]},info:''}));
}
test('TMDB frame has priority; missing still_path falls back to that episode thumbnail',()=>{
  const rt=runtime();
  assert.deepEqual([...rt.api.episodeImages({still_path:'/ep1.jpg'},thumb)],['https://image.example/t/p/w300/ep1.jpg',thumb]);
  for(const path of [null,undefined,'','/null','/undefined',false]) {
    assert.deepEqual([...rt.api.episodeImages({still_path:path},thumb)],[thumb]);
  }
});
test('confirmed thumbnail string and relative media base are handled without casting opaque objects',()=>{
  const rt=runtime();
  assert.equal(rt.api.thumbnailUrl(thumb),thumb);
  assert.equal(rt.api.thumbnailUrl('/media/thumbnail/12345.jpg'),'https://kino.pub/media/thumbnail/12345.jpg');
  assert.equal(rt.api.thumbnailUrl('/arbitrary/unconfirmed-base.jpg'),null);
  for(const value of [null,{},[],42,true,{poster:thumb},{url:42}]) assert.equal(rt.api.thumbnailUrl(value),null);
  // Defensive URL-bearing object support; NOT a claimed live-service fixture.
  assert.equal(rt.api.thumbnailUrl({url:thumb}),thumb);
});
test('load failure and timeout advance once; two unavailable images finish as a placeholder',()=>{
  const rt=runtime(),target={src:''},results=[];
  rt.api.loadImageCandidates(target,['https://image.example/ep.jpg',thumb],ok=>results.push(ok));
  rt.imageRequests[0].onerror();
  assert.equal(rt.imageRequests.length,2);assert.equal(rt.imageRequests[1].src,thumb);
  rt.imageRequests[1].onload();assert.equal(target.src,thumb);assert.deepEqual(results,[true]);
  const fail=runtime(),none=[];
  fail.api.loadImageCandidates({},['https://image.example/missing.jpg',thumb],ok=>none.push(ok));
  fail.tickAll();fail.tickAll();fail.tickAll();
  assert.equal(fail.imageRequests.length,2);assert.deepEqual(none,[false]);
});
test('late image event is ignored after cancellation or after moving to the fallback',()=>{
  const rt=runtime(),target={src:''},done=[];
  const cancel=rt.api.loadImageCandidates(target,['https://image.example/ep.jpg',thumb],ok=>done.push(ok));
  const old=rt.imageRequests[0].onload;
  rt.imageRequests[0].onerror();old();assert.equal(target.src,'');
  const fallback=rt.imageRequests[1].onload;
  cancel();fallback();rt.tickAll();assert.equal(target.src,'');assert.deepEqual(done,[]);
});
test('numeric episode identifiers match exactly within the right season',()=>{
  const rt=runtime(),ep={episode_number:'01',season_number:'1',still_path:'/one.jpg'};
  assert.equal(rt.api.findEpisode([ep],1,'1'),ep);
  assert.equal(rt.api.findEpisode([ep],2,1),null);
  assert.equal(rt.api.findEpisode([ep],1,2),null);
  for(const value of [null,false,'','1.2','1x']) assert.equal(rt.api.numberValue(value),null);
  assert.equal(rt.api.numberValue('01'),1);
});
test('source retains thumbnail across extractData and filtered card creation',()=>{
  const rt=runtime({storage:{kp_token:'dummy-fixture'}});
  const view={reset(){},loading(){},filter(){},draw(list){this.items=list;},doesNotAnswer(){throw Error('fixture');}};
  const src=new rt.api.kpapi(view,{source:'tmdb',movie:{id:111,name:'Fixture',original_name:'Fixture',first_air_date:'2011-01-01'}});
  src.find(22);rt.requests.at(-1).ok({item:{id:22,title:'Fixture',year:2011,seasons:[{number:'1',episodes:[{number:'01',thumbnail:thumb,files:[]}]}]}});
  assert.equal(view.items[0].thumb,thumb);assert.equal(view.items[0].season,1);assert.equal(view.items[0].episode,1);
  assert.equal(view.items[0].tmdb_id,111);
});
test('KinoPub identity cannot be sent as a TMDB identifier; a different selected series uses KP only',()=>{
  const rt=runtime();
  assert.equal(rt.api.tmdbSeriesId({id:22,name:'Fixture',original_name:'Fixture',source:'kp'},'kp'),null);
  assert.equal(rt.api.tmdbSeriesId({tmdb_id:'111',id:22,source:'kp'},'kp'),111);
  assert.equal(rt.api.sameSeries({title:'Other',year:2011},{name:'Fixture',first_air_date:'2011-01-01'}),false);
  assert.equal(rt.api.sameSeries({title:'Fixture',imdb:'222'},{name:'Fixture',imdb_id:'tt111'}),false);
});
test('cards render before one season request finishes and are enriched in place',()=>{
  const rt=runtime(),c=component(rt);
  c.draw(items());
  assert.equal(rt.scrolled.length,2);assert.equal(rt.requests.length,1);
  assert.equal(rt.imageRequests.length,2);
  rt.requests[0].ok({season_number:1,episodes:[{season_number:'1',episode_number:'1',name:'Actual episode',still_path:'/one.jpg',air_date:'2011-01-01',vote_average:7.1}]});
  assert.equal(rt.scrolled.length,2);assert.equal(rt.rows[0].find('.online-prestige__title').value,'Actual episode');
  assert.equal(rt.imageRequests.at(-1).src,'https://image.example/t/p/w300/one.jpg');
  rt.imageRequests.at(-1).onload();
  assert.equal(rt.rows[0].find('img')[0].src,'https://image.example/t/p/w300/one.jpg');
  assert.equal(rt.rows[1].find('img')[0].src,'');
});
test('rapid season switch rejects old metadata and image callbacks',()=>{
  const rt=runtime(),c=component(rt);c.draw(items(1));
  const oldRequest=rt.requests[0],oldImage=rt.imageRequests[0].onload;
  c.reset();c.draw(items(2));
  oldRequest.ok({season_number:1,episodes:[{episode_number:1,season_number:1,still_path:'/old.jpg'}]});oldImage();
  assert.equal(rt.rows[0].find('img')[0].src,'');
  assert.equal(rt.imageRequests.some(i=>i.src && i.src.includes('old.jpg')),false);
  assert.equal(rt.requests[1].url.includes('/season/2'),true);
});
test('closing component clears image and season timers and prevents late writes',()=>{
  const rt=runtime(),c=component(rt);c.draw(items());
  const request=rt.requests[0],oldImage=rt.imageRequests[0].onload;c.destroy();
  request.ok({season_number:1,episodes:[{episode_number:1,still_path:'/late.jpg'}]});oldImage();rt.tickAll();
  assert.equal(rt.rows[0].find('img')[0].src,'');assert.equal(rt.timers.size,0);assert.equal(request.cleared,true);
});
test('temporary season failures are retried; valid season result is cached once per season',()=>{
  const rt=runtime(),c=component(rt),results=[];
  c.getEpisodes(1,x=>results.push(x),111);rt.requests[0].fail({status:503});
  c.getEpisodes(1,x=>results.push(x),111);assert.equal(rt.requests.length,2);
  rt.requests[1].ok({season_number:1,episodes:[{episode_number:1,still_path:'/ep.jpg'}]});
  c.getEpisodes('1',x=>results.push(x),'111');assert.equal(rt.requests.length,2);assert.equal(results.length,3);
});
test('both absent sources show the episode number without requesting a broken image',()=>{
  const rt=runtime(),c=component(rt),list=items();list.forEach(i=>{i.thumb=null;i.tmdb_id=null;});c.draw(list);
  assert.equal(rt.imageRequests.length,0);assert.equal(rt.requests.length,0);
  assert.equal(rt.rows[0].find('.online-prestige__img').content.some(s=>typeof s==='string'&&s.includes('>01<')),true);
});
test('context menu one-off Infuse is explicit and does not overwrite player settings',()=>{
  const rt=runtime(),c=component(rt);let picked=null;
  const html=rt.Lampa.Template.get('online_prestige_full',{});
  c.contextMenu({html,element:{},onFile:cb=>cb({}),onPlay:p=>picked=p});
  html.trigger('hover:long');
  const menu=rt.menus.at(-1);const infuse=menu.items.find(i=>i.player==='infuse');assert.ok(infuse);
  menu.onSelect(infuse);assert.equal(picked,'infuse');assert.equal(rt.storage.player,'inner');
});
