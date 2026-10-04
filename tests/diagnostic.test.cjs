'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {runtime}=require('./runtime.cjs');
const signed='https://video.example/private-token/movie.mp4?secret=fixture-signature';
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function response(status=206,headers={}) {
  return {status,url:'https://cdn.example/hidden-token/file.mp4?sig=fixture-secret',redirected:true,
    headers:{get:name=>headers[name]||null},
    body:{cancelled:false,cancel(){this.cancelled=true;return Promise.resolve();}},
    arrayBuffer(){throw Error('must not download body');},text(){throw Error('must not download body');}};
}
test('diagnostic checks HEAD and small Range GET without credentials or reading a movie body',async()=>{
  const calls=[], replies=[];
  const rt=runtime({fetch:async(url,options)=>{
    calls.push({url,options});
    const r=response(options.method==='HEAD'?200:206,{'Content-Type':'video/mp4','Content-Length':options.method==='HEAD'?'9000000':'1024',
      'Content-Range':'bytes 0-1023/9000000','Accept-Ranges':'bytes'});
    replies.push(r);return r;
  }});
  let result;
  rt.api.probeInfuseResource(signed,r=>result=r);await flush();
  assert.equal(calls.length,2);
  assert.equal(calls[0].options.method,'HEAD');assert.equal(calls[1].options.headers.Range,'bytes=0-1023');
  for(const c of calls){assert.equal(c.url,signed);assert.equal(c.options.credentials,'omit');assert.equal(c.options.signal.aborted,true);}
  assert.equal(replies.every(r=>r.body.cancelled),true);
  assert.equal(result[1].status,206);assert.equal(result[1].range,'bytes 0-1023/9000000');
  assert.equal(result[1].redirected,true);assert.equal(result[1].host,'cdn.example');
  assert.doesNotMatch(JSON.stringify(result),/hidden-token|private-token|fixture-signature|fixture-secret/);
});
test('server ignoring Range is reported as 200 and its full body is cancelled',async()=>{
  const replies=[];const rt=runtime({fetch:async()=>{const r=response(200);replies.push(r);return r;}});
  let result;rt.api.probeInfuseResource(signed,r=>result=r);await flush();
  assert.equal(result[1].status,200);assert.equal(result[1].range,null);
  assert.equal(replies.every(r=>r.body.cancelled),true);
});
test('CORS or network rejection is never presented as proof the server is down in Infuse',async()=>{
  const rt=runtime({fetch:async()=>{throw Error(signed);}});let result;
  rt.api.probeInfuseResource(signed,r=>result=r);await flush();
  assert.equal(result.length,2);result.forEach(r=>assert.equal(r.error,'network-or-cors'));
  assert.doesNotMatch(JSON.stringify(result),/private-token/);
});
test('probe has two bounded attempts and cancel suppresses late callbacks',async()=>{
  const pending=[];const rt=runtime({fetch:()=>new Promise(resolve=>pending.push(resolve))});let result;
  rt.api.probeInfuseResource(signed,r=>result=r);rt.tickAll();rt.tickAll();
  assert.equal(pending.length,2);assert.equal(result.length,2);
  result.forEach(r=>assert.equal(r.error,'timeout'));
  const other=runtime({fetch:()=>new Promise(resolve=>pending.push(resolve))});let finished=false;
  const cancel=other.api.probeInfuseResource(signed,()=>finished=true);cancel();
  pending.at(-1)(response());await flush();assert.equal(finished,false);
});
test('diagnostic is explicit, can close while loading, and displays no signed paths',async()=>{
  const pending=[];const rt=runtime({fetch:()=>new Promise(resolve=>pending.push(resolve))});
  rt.api.dispatchInfuse({_kpInfuse:true,_kpQuality:1080,_kpPrepareMs:75,url:signed});
  assert.equal(pending.length,0);
  rt.api.showInfuseDiagnostic();
  assert.equal(pending.length,1);
  const modal=rt.modals.at(-1);
  assert.match(modal.html.value,/video.example/);assert.match(modal.html.value,/75 ms/);
  assert.doesNotMatch(modal.html.value,/private-token|fixture-signature/);
  const old=modal.html.value;modal.onBack();pending[0](response());await flush();
  assert.equal(modal.html.value,old);
  assert.equal(rt.launches.length,1);
});
test('unsupported shell reports limitation without starting playback or a request',()=>{
  const rt=runtime();let result;rt.api.probeInfuseResource(signed,r=>result=r);
  assert.equal(result[0].error,'unsupported');assert.equal(rt.launches.length,0);
});
