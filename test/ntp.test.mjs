import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { writeTimestamp, readTimestamp, parseResponse, probe, summarize } from '../ntp.mjs';

function fixture(){
  const t1=Date.UTC(2026,10,4), request=Buffer.alloc(48), response=Buffer.alloc(48);
  writeTimestamp(request,40,t1);response[0]=0x24;response[1]=1;
  request.copy(response,24,40,48);
  // Symmetric network: 10 ms each way, server clock 7 ms ahead, processing 2 ms.
  writeTimestamp(response,32,t1+17);writeTimestamp(response,40,t1+19);
  return {t1,request,response};
}
test('four timestamps recover offset, delay and processing duration',()=>{
  const {t1,request,response}=fixture(),r=parseResponse(response,request,t1,t1+22);
  assert.ok(Math.abs(r.offsetMs-7)<.001);assert.ok(Math.abs(r.delayMs-20)<.001);assert.ok(Math.abs(r.processingMs-2)<.001);
});
test('asymmetric network produces the expected half-asymmetry bias',()=>{
  const {t1,request,response}=fixture();
  writeTimestamp(response,32,t1+27);writeTimestamp(response,40,t1+29);
  const r=parseResponse(response,request,t1,t1+32);
  assert.ok(Math.abs(r.offsetMs-12)<.001);
});
test('NTP era rollover in 2036 is decoded correctly',()=>{
  for(const date of [Date.UTC(2026,10,4),Date.UTC(2036,1,8),Date.UTC(2040,0,1)]){
    const b=Buffer.alloc(8);writeTimestamp(b,0,date+123.25);assert.ok(Math.abs(readTimestamp(b,0,date)-(date+123.25))<.001);
  }
});
test('invalid replies are rejected',()=>{
  const checks=[
    [r=>r[0]=0xe4,/синхронизации/],
    [r=>r[1]=16,/синхронизации/],
    [r=>r[0]=0x23,/mode 4/],
    [r=>r[24]^=1,/originate/],
    [r=>r.fill(0,40,48),/Нулевая/],
    [r=>{r[1]=0;r.write('RATE',12);},/Kiss-o'-Death: RATE/]
  ];
  for(const [mutate,pattern] of checks){const f=fixture();mutate(f.response);assert.throws(()=>parseResponse(f.response,f.request,f.t1,f.t1+22),pattern);}
  const f=fixture();assert.throws(()=>parseResponse(Buffer.alloc(20),f.request,f.t1,f.t1+22),/Короткий/);
});
test('statistics use absolute percentiles and population standard deviation',()=>{
  const r=summarize([-3,1,2]);assert.equal(r.mean,0);assert.ok(Math.abs(r.std-Math.sqrt(14/3))<1e-10);assert.equal(r.p95Abs,3);assert.equal(r.maxAbs,3);assert.equal(summarize([]).count,0);
});
test('real UDP roundtrip against a controlled local NTP responder',async()=>{
  const udp=dgram.createSocket('udp4');udp.bind(0,'127.0.0.1');await once(udp,'listening');
  udp.on('message',(request,peer)=>{
    const response=Buffer.alloc(48);response[0]=0x24;response[1]=2;request.copy(response,24,40,48);
    const now=Date.now()+25;writeTimestamp(response,32,now);writeTimestamp(response,40,now);
    udp.send(response,peer.port,peer.address);
  });
  try{const r=await probe('127.0.0.1',{port:udp.address().port,timeoutMs:1000});assert.equal(r.stratum,2);assert.ok(Math.abs(r.offsetMs-25)<10);assert.equal(r.ip,'127.0.0.1');}
  finally{udp.close();}
});
test('nonresponsive UDP server times out',async()=>{
  const udp=dgram.createSocket('udp4');udp.bind(0,'127.0.0.1');await once(udp,'listening');
  try{await assert.rejects(probe('127.0.0.1',{port:udp.address().port,timeoutMs:100}),/тайм-аут/);}
  finally{udp.close();}
});
test('HTTP interface, request protection and validation',async()=>{
  const child=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:'0'},stdio:['ignore','pipe','pipe']});
  try{
    const url=await new Promise((resolve,reject)=>{
      let output='';const timer=setTimeout(()=>reject(new Error('Server readiness timeout')),5000);
      child.stdout.on('data',data=>{output+=data;const match=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});
      child.on('error',reject);
    });
    const page=await fetch(url);assert.equal(page.status,200);assert.match(await page.text(),/Сравнение координат и времени/);
    const state=await (await fetch(url+'/api/state')).json();assert.equal(state.run,null);
    const blocked=await fetch(url+'/api/start',{method:'POST',body:'{}'});assert.equal(blocked.status,403);
    const invalid=await fetch(url+'/api/start',{method:'POST',headers:{'X-Session-Token':state.token},body:JSON.stringify({ukus:'127.0.0.1',mnav:'127.0.0.1',internet:'127.0.0.1',interval:1})});assert.equal(invalid.status,400);assert.match((await invalid.json()).error,/Интервал/);
    assert.equal((await fetch(url+'/api/csv')).status,404);
  }finally{child.kill();await once(child,'exit');}
});

test('complete measurement writes CSV and excludes an unsynchronised reference',async()=>{
  const udp=dgram.createSocket('udp4');
  await new Promise((resolve,reject)=>{udp.once('error',reject);udp.bind(0,'127.0.0.1',resolve);});
  let sequence=0,invalidReference=false;
  udp.on('message',(request,peer)=>{
    const index=sequence++%3,response=Buffer.alloc(48);response[0]=index===0&&invalidReference?0xe4:0x24;response[1]=1;
    request.copy(response,24,40,48);const now=Date.now()+[0,20,50][index];writeTimestamp(response,32,now);writeTimestamp(response,40,now);udp.send(response,peer.port,peer.address);
  });
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'ntp-compare-test-'));
  const child=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:'0',NTP_DATA_DIR:dataDir,NTP_PORT:String(udp.address().port)},stdio:['ignore','pipe','pipe']});
  try{
    const url=await new Promise((resolve,reject)=>{
      let output='';const timer=setTimeout(()=>reject(new Error('Server readiness timeout')),5000);
      child.stdout.on('data',data=>{output+=data;const match=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});child.on('error',reject);
    });
    const state=async()=>await(await fetch(url+'/api/state')).json();
    const {token}=await state();
    const post=async(route,data={})=>await(await fetch(url+route,{method:'POST',headers:{'X-Session-Token':token},body:JSON.stringify(data)})).json();
    const config={ukus:'127.0.0.1',mnav:'127.0.0.1',internet:'127.0.0.1',interval:16,timeout:1000,duration:1};
    for(const invalid of [false,true]){
      invalidReference=invalid;
      await post('/api/start',config);
      let current;
      for(let i=0;i<100;i++){current=(await state()).run;if(current.count)break;await new Promise(resolve=>setTimeout(resolve,20));}
      assert.equal(current.count,1);assert.equal(current.stats.mnav.valid,1);
      if(invalid){assert.equal(current.stats.ukus.failed,1);assert.equal(current.stats.mnav.delta.count,0);assert.equal(current.samples[0].results[1].deltaMs,null);}
      else{assert.equal(current.stats.mnav.delta.count,1);assert.ok(Math.abs(current.stats.mnav.delta.mean-20)<10);assert.ok(Math.abs(current.stats.internet.delta.mean-50)<10);}
      const csv=await(await fetch(url+'/api/csv')).text();assert.equal(csv.trim().split('\r\n').length,4);assert.match(csv,/delta_vs_ukus_ms/);
      const report=await(await fetch(url+'/api/report.json')).json();assert.equal(report.ntp.mnav.delta.count,invalid?0:1);assert.equal(report.navigation,null);
      const html=await(await fetch(url+'/api/report.html')).text();assert.match(html,/ПРОМЕЖУТОЧНЫЙ/);assert.match(html,/Навигационный канал не был включён/);
      await post('/api/stop');
      const stopped=await(await fetch(url+'/api/report.json')).json();assert.equal(stopped.active,false);assert.equal(stopped.pending,false);assert.ok(stopped.stoppedAt);
    }
  }finally{udp.close();child.kill();await once(child,'exit');}
});
