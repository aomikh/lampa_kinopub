'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {runtime}=require('./runtime.cjs');

function fixture() {
  const rt=runtime({storage:{kp_token:'fixture',kp_refresh:'refresh-fixture',player:'infuse'}});
  const view={reset(){},loading(){},filter(){},draw(items,options){this.items=items;this.options=options;}};
  const src=new rt.api.kpapi(view,{movie:{id:111,name:'Fixture'}});
  const item={id:22,title:'Fixture',type:'serial',seasons:[{number:1,episodes:[1,2].map(number=>({
    number,files:[{quality:'1080p',file:'/fixture/s1e'+number+'.mp4',
      urls:{http:'https://video.example/old/'+number}}],audios:[],subtitles:[]
  }))}]};
  src.find(22);rt.requests.at(-1).ok({item});
  const count=rt.requests.length;
  view.options.onEnter(view.items[0]);
  assert.equal(rt.requests.length,count+1,'launch initially requests only fresh item metadata');
  const refresh=rt.requests.at(-1);
  assert.ok(refresh.url.endsWith('/items/22'));
  return {rt,view,src,item,refresh,count};
}

test('rollback: episode resolves only the file selected from completed fresh metadata',()=>{
  const {rt,item,refresh,count}=fixture();
  item.seasons[0].episodes[0].files[0].file='/fixture/replacement.mp4';
  refresh.ok({item});
  assert.equal(rt.requests.length,count+2);
  const resolve=rt.requests.at(-1),params=new URL(resolve.url).searchParams;
  assert.equal(params.get('file'),'/fixture/replacement.mp4');
  assert.equal(params.get('type'),'http');
  const signed='https://video.example/http/selected?sig=a%2B+b%26&preload=1';
  resolve.ok({url:signed});
  assert.deepEqual(new URL(rt.launches[0]).searchParams.getAll('url'),[signed,'https://video.example/old/2']);
  assert.equal(rt.mediaRequests.length,0);
});

test('rollback: metadata error cannot leave an early file request running',()=>{
  const {rt,refresh,count}=fixture();
  refresh.fail({status:503});
  assert.equal(rt.requests.length,count+1);
  assert.equal(rt.launches.length,0);assert.equal(rt.notices.length,1);
});

test('rollback: metadata auth refresh completes before selected-file request starts',()=>{
  const {rt,item,refresh}=fixture();
  refresh.fail({status:401});
  const grant=rt.requests.at(-1);assert.ok(grant.url.endsWith('/oauth2/token'));
  assert.equal(rt.requests.filter(r=>r.url.includes('/media-video-link?')).length,0);
  grant.ok({access_token:'fresh-fixture',refresh_token:'new-refresh-fixture'});
  const retry=rt.requests.at(-1);assert.ok(retry.url.endsWith('/items/22'));
  retry.ok({item});
  assert.equal(rt.requests.filter(r=>r.url.includes('/media-video-link?')).length,1);
  assert.equal(rt.requests.filter(r=>r.url.endsWith('/oauth2/token')).length,1);
});
