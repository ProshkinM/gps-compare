import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import dgram from 'node:dgram';
import { once } from 'node:events';
import { checksum,readRequest,decodeResponse,readBlock } from '../ukus.mjs';
import { parseSentence,NmeaStream } from '../nmea.mjs';
import { positionDifference,Navigation } from '../navigation.mjs';
import { makeReport,reportHtml,drift,timeStats } from '../report.mjs';

const captured=JSON.parse(fs.readFileSync(new URL('./fixtures/ukus.json',import.meta.url),'utf8'));
const requests=captured.filter(r=>Buffer.from(r.hex,'hex').readUInt16LE(8)===5);
function response(request){const row=captured.find(r=>{const b=Buffer.from(r.hex,'hex');return b.readUInt16LE(8)===133&&b.readUInt16LE(10)===request.readUInt16LE(10);});const packet=Buffer.from(row.hex,'hex');packet.writeUInt16LE(request.readUInt16LE(2),2);packet.writeUInt16LE(checksum(packet),6);return packet;}
export function sentence(body){let c=0;for(const ch of body)c^=ch.charCodeAt(0);return '$'+body+'*'+c.toString(16).toUpperCase().padStart(2,'0')+'\r\n';}
const gga=(tod='140019.00',quality='1')=>sentence(`GNGGA,${tod},5000.000000,N,03000.000000,E,${quality},12,1.3,100.000,M,13.500,M,,`);
const rmc=(tod='140019.00',status='A')=>sentence(`GNRMC,${tod},${status},5000.000000,N,03000.000000,E,0.1,90.0,010120,,,A`);
test('all synthetic TO request/response pairs match framing, checksum and coordinates',()=>{
  assert.equal(requests.length,6);
  for(const row of requests){const req=Buffer.from(row.hex,'hex');assert.deepEqual(readRequest(req.readUInt16LE(2),req.readUInt16LE(10),req.readUInt16LE(12)),req);const decoded=decodeResponse(response(req),req);if(decoded.offset===0){assert.match(decoded.firmware,/CSM24 04.08/);assert.match(decoded.receiver,/NV08C 07.03/);}else{assert.ok(Math.abs(decoded.latitude-50.000000000)<1e-8);assert.ok(Math.abs(decoded.longitude-30.000000000)<1e-8);assert.equal(decoded.validity,'unknown');}}
  // Also validate each distinct synthetic response, without substituting the first fixture.
  for(const row of captured.filter(r=>Buffer.from(r.hex,'hex').readUInt16LE(8)===133)){const b=Buffer.from(row.hex,'hex'),req=readRequest(b.readUInt16LE(2),b.readUInt16LE(10),b.readUInt16LE(12));assert.ok(decodeResponse(b,req));}
});
test('TO parser rejects corruption, wrong transaction and impossible position',()=>{
  const req=readRequest(42,252,170),b=response(req);b[20]^=1;assert.throws(()=>decodeResponse(b,req),/контрольной/);
  assert.throws(()=>decodeResponse(response(req),readRequest(43,252,170)),/номера/);
  const invalid=response(req);invalid.writeDoubleLE(8,18);invalid.writeUInt16LE(checksum(invalid),6);assert.throws(()=>decodeResponse(invalid,req),/Координаты/);
  assert.throws(()=>readRequest(1,256,100),/Unsupported/);
});
test('real UDP TO client sends read-only request and decodes a replayed block',async()=>{
  const udp=dgram.createSocket('udp4');udp.bind(0,'127.0.0.1');await once(udp,'listening');
  udp.on('message',(req,peer)=>{assert.equal(req.readUInt16LE(8),5);udp.send(response(req),peer.port,peer.address);});
  try{const result=await readBlock('127.0.0.1',252,{port:udp.address().port,timeoutMs:1000});assert.ok(Math.abs(result.latitude-50.000000000)<1e-8);}finally{udp.close();}
});
test('NMEA checksums, coordinates, heights and UTC are parsed',()=>{
  const g=parseSentence(gga());assert.ok(Math.abs(g.latitude-50.00000000)<1e-8);assert.equal(g.altitudeMsl,100);assert.equal(g.geoid,13.5);
  const r=parseSentence(rmc());assert.equal(r.utc,'2020-01-01T14:00:19.000Z');assert.ok(Math.abs(r.speedMps-.0514444444)<1e-8);
  assert.throws(()=>parseSentence(gga().replace('*','*FF')),/контрольной|Не строка/);
});
test('fragmented TCP lines, coalesced packets and invalid fixes never reuse a previous epoch',()=>{
  const stream=new NmeaStream(),line=gga();stream.feed(Buffer.from(line.slice(0,17)));assert.equal(stream.current,null);stream.feed(Buffer.from(line.slice(17)+rmc()));assert.equal(stream.current.valid,true);assert.equal(stream.current.altitudeEllipsoid,113.5);
  stream.feed(Buffer.from(gga('140020.00')));assert.equal(stream.current.utc,null);assert.equal(stream.current.speedMps,null);
  stream.feed(Buffer.from(rmc('140020.00','V')));assert.equal(stream.current.valid,false);
  stream.feed(Buffer.from(gga('140021.00','0')));assert.equal(stream.current.valid,false);
  stream.feed(Buffer.from('$GNGGA,garbage*00\r\n'));assert.equal(stream.bad,1);
});
test('NMEA epoch order handles UTC midnight and rejects out-of-order sentences',()=>{
  const stream=new NmeaStream();stream.feed(Buffer.from(gga('235959.00')+gga('000000.00')));assert.equal(stream.current.tod,0);stream.feed(Buffer.from(gga('235958.00')));assert.equal(stream.current.tod,0);
});
test('repeated NMEA epoch cannot refresh the solution age indefinitely',()=>{
  const stream=new NmeaStream();stream.feed(Buffer.from(gga()));const original=stream.current.epochFirstReceivedMs;
  stream.epochs.get(stream.current.tod).firstReceivedMs=original-5000;
  stream.feed(Buffer.from(gga()+rmc()));assert.equal(stream.current.epochFirstReceivedMs,original-5000);assert.ok(Date.now()-stream.current.epochFirstReceivedMs>=5000);
});
test('position differences account for antenna baselines and do not assume height datum',()=>{
  const ref={latitude:45,longitude:42,heightRaw:600},mnav={latitude:45,longitude:42,altitudeMsl:590,altitudeEllipsoid:603};
  const unknown=positionDifference(ref,mnav);assert.equal(unknown.horizontalM,0);assert.equal(unknown.verticalM,null);
  assert.equal(positionDifference(ref,mnav,{ukusHeightType:'ellipsoid',heightCorrectionM:1}).verticalM,2);
  const shifted=positionDifference(ref,mnav,{northCorrectionM:3,eastCorrectionM:4});assert.equal(shifted.horizontalM,5);
});
test('live navigation combines TCP NMEA with read-only UDP, persists raw data and excludes invalid MNAV',async()=>{
  const udp=dgram.createSocket('udp4');udp.bind(0,'127.0.0.1');await once(udp,'listening');udp.on('message',(req,peer)=>udp.send(response(req),peer.port,peer.address));
  const peers=new Set();const tcp=net.createServer(socket=>{peers.add(socket);socket.on('close',()=>peers.delete(socket));socket.on('error',()=>{});socket.write(gga()+rmc());});tcp.listen(0,'127.0.0.1');await once(tcp,'listening');
  const base=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'ntp-navigation-test-')),'run');
  const nav=new Navigation({ukus:'127.0.0.1',mnav:'127.0.0.1',nmeaPort:tcp.address().port,timeout:1000,navInterval:60,maxNmeaAgeMs:3000,ukusHeightType:'unknown'},base,{port:udp.address().port});
  try{
    nav.start();for(let i=0;i<100;i++){if(!nav.busy&&nav.client.stream.current)break;await new Promise(r=>setTimeout(r,10));}await nav.cycle();
    const state=nav.snapshot();assert.ok(state.paired>=1);assert.equal(state.stats.verticalM.count,0);assert.equal(state.validityKnown,false);assert.match(fs.readFileSync(nav.paths.raw,'utf8'),/GNGGA/);assert.match(fs.readFileSync(nav.paths.csv,'utf8'),/horizontal_m/);
    for(const peer of peers)peer.write(gga('140020.00','0')+rmc('140020.00','V'));
    for(let i=0;i<100;i++){if(nav.client.stream.current?.tod===50420000)break;await new Promise(r=>setTimeout(r,10));}await nav.cycle();assert.equal(nav.samples.at(-1).validPair,false);
  }finally{nav.stop();for(const peer of peers)peer.destroy();await new Promise(r=>tcp.close(r));udp.close();}
});
test('report includes actual counts, correct drift, delay-filtered results and escaped user text',()=>{
  const start=Date.UTC(2026,10,4),run={id:'test',active:false,startedAt:new Date(start).toISOString(),message:'Готово',config:{testTitle:'<script>x</script>',testNotes:'<img src=x>',interval:16,timeout:2500,nmeaPort:6006,navInterval:5},samples:[]};
  for(let i=0;i<10;i++)run.samples.push({utc:new Date(start+i*100000).toISOString(),results:['ukus','mnav','internet'].map(key=>({key,ok:true,deltaMs:key==='ukus'?0:i*.1,delayMs:10-i,referenceDelayMs:1,offsetMs:0}))});
  assert.ok(Math.abs(drift(run.samples,'mnav')-1)<1e-10);const stats=timeStats(run);assert.equal(stats.mnav.lowDelayDelta.count,2);assert.ok(Math.abs(stats.mnav.lowDelayDelta.mean-.85)<1e-10);
  const report=makeReport(run);assert.equal(report.ntp.mnav.delta.count,10);const html=reportHtml(run);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);assert.match(html,/абсолютная погрешность|абсолютной погрешности/);
});
