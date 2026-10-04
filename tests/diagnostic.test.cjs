'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {runtime}=require('./runtime.cjs');
const signed='https://video.example/private-token/movie.mp4?secret=fixture-signature';
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function response(status=206,headers={}) {
  return {status,url:'https://cdn.example/hidden-token/file.mp4?sig=fixture-secret',redirected:true,
    headers:{get:name=>headers[name]||null},
    body:{cancelled:false,cancel(){this.cancelled=true;return Promise.resolve();},
      getReader(){throw Error('browser must not read an uncontrolled stream chunk');}},
    arrayBuffer(){throw Error('must not download body');},text(){throw Error('must not download body');}};
}
function server(options,size=14620759377) {
  if(options.method==='HEAD') return response(200,{'Content-Length':String(size),'Content-Type':'video/mp4'});
  let [start,end]=options.headers.Range.slice(6).split('-');
  if(!start){start=Math.max(0,size-Number(end));end=size-1;}
  else {start=Number(start);end=end?Math.min(Number(end),size-1):size-1;}
  return response(206,{'Content-Type':'video/mp4','Content-Length':String(end-start+1),
    'Content-Range':`bytes ${start}-${end}/${size}`,'Accept-Ranges':'bytes'});
}
async function check(fetch){let result;const rt=runtime({fetch});rt.api.probeInfuseResource(signed,r=>result=r);await flush();return {rt,result};}
test('diagnostic checks all four ranges on the exact signed link without reading any browser body',async()=>{
  const calls=[], replies=[];
  const rt=runtime({fetch:async(url,options)=>{
    calls.push({url,options});
    const r=server(options);
    replies.push(r);return r;
  }});
  let result;
  rt.api.probeInfuseResource(signed,r=>result=r);await flush();
  assert.equal(calls.length,5);
  assert.deepEqual(calls.slice(1).map(c=>c.options.headers.Range),
    ['bytes=0-1023','bytes=7310379688-7310380711','bytes=7310379688-','bytes=-1024']);
  assert.equal(calls[0].options.method,'HEAD');assert.equal(calls[1].options.headers.Range,'bytes=0-1023');
  for(const c of calls){assert.equal(c.url,signed);assert.equal(c.options.credentials,'omit');assert.equal(c.options.signal.aborted,true);}
  assert.equal(replies.every(r=>r.body.cancelled),true);
  assert.equal(result[1].status,206);assert.equal(result[1].range,'bytes 0-1023/14620759377');
  result.slice(1).forEach(r=>assert.equal(r.verdict,'headers-match'));
  result.forEach(r=>{assert.equal(r.bodyChecked,false);assert.equal(r.bytesRead,0);});
  assert.equal(result[1].redirected,true);assert.equal(result[1].host,'cdn.example');
  assert.doesNotMatch(JSON.stringify(result),/hidden-token|private-token|fixture-signature|fixture-secret|205444144/);
});
test('server ignoring Range is reported as 200 and its full body is cancelled',async()=>{
  const replies=[];const rt=runtime({fetch:async()=>{const r=response(200);replies.push(r);return r;}});
  let result;rt.api.probeInfuseResource(signed,r=>result=r);await flush();
  assert.equal(result[1].status,200);assert.equal(result[1].range,null);
  assert.equal(result[1].verdict,'range-ignored');
  assert.equal(replies.every(r=>r.body.cancelled),true);
});
test('CORS or network rejection is never presented as proof the server is down in Infuse',async()=>{
  const rt=runtime({fetch:async()=>{throw Error(signed);}});let result;
  rt.api.probeInfuseResource(signed,r=>result=r);await flush();
  assert.equal(result.length,3);result.forEach(r=>assert.equal(r.error,'network-or-cors'));
  assert.doesNotMatch(JSON.stringify(result),/private-token/);
});
test('probe has a finite request count and cancel suppresses late callbacks',async()=>{
  const pending=[];const rt=runtime({fetch:()=>new Promise(resolve=>pending.push(resolve))});let result;
  rt.api.probeInfuseResource(signed,r=>result=r);rt.tickAll();rt.tickAll();rt.tickAll();
  assert.equal(pending.length,3);assert.equal(result.length,3);
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

test('beginning can pass while the middle fails: 200 is never a range success',async()=>{
  const {result}=await check(async(_url,options)=>options.headers?.Range.startsWith('bytes=7310379688')?response(200):server(options));
  assert.equal(result[1].verdict,'headers-match');assert.equal(result[2].verdict,'range-ignored');assert.equal(result[3].verdict,'range-ignored');
});
test('unknown size or blocked HEAD still checks suffix; CORS-hidden headers remain unknown',async()=>{
  const {result}=await check(async(_url,options)=>options.method==='HEAD'?response(405):response(206));
  assert.equal(result.length,3);assert.equal(result[2].requested,'bytes=-1024');
  result.slice(1).forEach(r=>assert.equal(r.verdict,'unknown-range'));
});
test('size can be discovered by initial GET when HEAD is unavailable',async()=>{
  const {result}=await check(async(_url,options)=>options.method==='HEAD'?response(405):server(options,5000));
  assert.equal(result.length,5);assert.equal(result[2].requested,'bytes=2500-3523');
});
test('a HEAD-only access refusal does not prevent a valid GET probe',async()=>{
  const {result}=await check(async(_url,options)=>options.method==='HEAD'?response(403,{'Content-Type':'text/html'}):server(options,5000));
  assert.equal(result.length,5);assert.equal(result[0].status,403);
  result.slice(1).forEach(r=>assert.equal(r.verdict,'headers-match'));
});
test('wrong Content-Range, malformed and inconsistent length fail without echoing unsafe header values',async()=>{
  for(const headers of [
    {'Content-Range':'bytes 0-1023/14620759377'},
    {'Content-Range':'bytes 7310379688-7310380711/14620759377','Content-Length':'999'},
    {'Content-Range':'private-token'},
  ]) {
    const {result}=await check(async(_url,options)=>options.headers?.Range==='bytes=7310379688-7310380711'?response(206,headers):server(options));
    assert.equal(result[2].verdict,'invalid-range');assert.doesNotMatch(JSON.stringify(result),/private-token/);
  }
});
test('416 distinguishes unsatisfiable range, valid range rejection and changed size',()=>{
  const {api}=runtime();const r={status:416,range:'bytes */5000'};
  assert.equal(api.probeRangeVerdict(r,{start:5000,end:6023},5000),'unsatisfiable');
  assert.equal(api.probeRangeVerdict(r,{start:2500,end:3523},5000),'rejected-range');
  assert.equal(api.probeRangeVerdict(r,{suffix:1024},5000),'rejected-range');
  assert.equal(api.probeRangeVerdict(r,{start:2500,end:3523},9000),'size-changed');
  assert.equal(api.probeRangeVerdict({...r,range:'bytes */0'},{suffix:1024},0),'unsatisfiable');
});
test('changed representation stops the sequence instead of using stale size',async()=>{
  const {result}=await check(async(_url,options)=>server(options,options.method==='HEAD'?9000:5000));
  assert.equal(result.length,2);assert.equal(result[1].verdict,'size-changed');
});
test('denied/expired links and HTML error pages stop without retries or response text',async()=>{
  for(const status of [401,403,404,410,200]) {
    let calls=0;const {result}=await check(async()=>{calls++;return response(status,{'Content-Type':'text/html; charset=UTF-8'});});
    assert.equal(calls,2);assert.equal(result[1].status,status);
  }
});
test('access can expire between a successful start range and a later request',async()=>{
  let calls=0;const {result}=await check(async(_url,options)=>++calls===3?response(403):server(options));
  assert.equal(result.length,3);assert.equal(result[1].verdict,'headers-match');
  assert.equal(result[2].verdict,'authorization');assert.equal(result[2].bytesRead,0);
});
test('RFC partial coverage is reported separately; invalid numeric fields fail closed',()=>{
  const {api}=runtime();
  assert.equal(api.probeRangeVerdict({status:206,range:'bytes 2500-3000/5000',length:'501'},{start:2500},5000),'headers-partial');
  assert.equal(api.probeRangeVerdict({status:206,range:'bytes 2500-5000/5000'},{start:2500},5000),'invalid-range');
  assert.equal(api.parseProbeRange('bytes 0-9007199254740992/*'),null);
});
test('small file boundaries and suffix use the actual file size',async()=>{
  const {result}=await check(async(_url,options)=>server(options,5));
  assert.equal(result[2].requested,'bytes=2-4');result.slice(1).forEach(r=>assert.equal(r.verdict,'headers-match'));
});
test('large size boundaries retain exact middle and suffix offsets without browser body reads',async()=>{
  for(const size of [2**31-1,2**31+1,2**32-1,2**32+1,100*2**30]) {
    const {result}=await check(async(_url,options)=>server(options,size));
    const mid=Math.floor(size/2);
    assert.equal(result.length,5);
    assert.equal(result[2].requested,`bytes=${mid}-${mid+1023}`);
    assert.equal(result[2].range,`bytes ${mid}-${mid+1023}/${size}`);
    assert.equal(result[3].requested,`bytes=${mid}-`);
    assert.equal(result[4].range,`bytes ${size-1024}-${size-1}/${size}`);
    result.slice(1).forEach(r=>{assert.equal(r.verdict,'headers-match');assert.equal(r.bytesRead,0);});
  }
});
test('compressed HEAD length is not used for an offset; encoding is visible',async()=>{
  const {result}=await check(async()=>response(200,{'Content-Length':'99999','Content-Encoding':'gzip'}));
  assert.equal(result.length,3);assert.equal(result[0].encoding,'gzip');assert.equal(result[2].requested,'bytes=-1024');
});
test('report uses individual dialogs; navigation never repeats the probe or playback',async()=>{
  let calls=0;const rt=runtime({fetch:async(_url,options)=>{calls++;return server(options);}});
  rt.api.dispatchInfuse({_kpInfuse:true,_kpQuality:2160,url:signed,timeline:{time:91}});
  rt.api.showInfuseDiagnostic();await flush();
  const menu=rt.menus.at(-1);assert.equal(menu.items.length,6);menu.onSelect(menu.items[3]);
  const modal=rt.modals.at(-1);assert.match(modal.html.value,/Content-Range: bytes 7310379688-/);
  assert.match(modal.html.value,/Body: 0 bytes/);assert.doesNotMatch(modal.html.value,/private-token|hidden-token/);
  modal.onBack();assert.equal(calls,5);assert.equal(rt.launches.length,1);
  assert.equal(new URL(rt.launches[0]).searchParams.get('position'),'91');
});
