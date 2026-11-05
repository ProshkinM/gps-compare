import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {checksum,readRequest,decodeResponse,decodeChannels} from '../ukus.mjs';
import {NmeaStream,parseSentence} from '../nmea.mjs';
import {positionDifference} from '../navigation.mjs';
import {reportHtml} from '../report.mjs';
import {summarize} from '../ntp.mjs';

const capture=JSON.parse(fs.readFileSync(new URL('./fixtures/ukus-2.json',import.meta.url),'utf8'));
const responses=capture.filter(r=>Buffer.from(r.hex,'hex').readUInt16LE(8)===133);
const decoded=responses.map(r=>{const b=Buffer.from(r.hex,'hex');assert.equal(checksum(b),b.readUInt16LE(6));return decodeResponse(b,readRequest(b.readUInt16LE(2),b.readUInt16LE(10),b.readUInt16LE(12)));});
function line(body){let c=0;for(const ch of body)c^=ch.charCodeAt(0);return '$'+body+'*'+c.toString(16).padStart(2,'0')+'\r\n';}
const gga=line('GNGGA,140000.00,5000.0000,N,03000.0000,E,1,12,1.3,100.0,M,13.5,M,,');
function gsa(ids,sys=''){const fields=['GNGSA','A','3',...Array.from({length:12},(_,i)=>ids[i]??''),'1.8','1.3','1.4'];if(sys)fields.push(sys);return line(fields.join(','));}

test('synthetic series: all 16 cycles retain valid checksums and full coordinate precision',()=>{
  assert.equal(responses.length,32);const positions=decoded.filter(d=>d.offset===252);assert.equal(positions.length,16);
  assert.ok(Math.abs(positions[0].latitude-50.00000000000000)<1e-11);assert.ok(Math.abs(positions.at(-1).longitude-30.00000030000000)<1e-11);
  assert.equal(new Set(positions.map(p=>p.latitude)).size,16);assert.ok(positions.every(p=>p.validity==='unknown'));
});
test('UKUS satellites decode slots 1–31 without guessing channel 32 or used status',()=>{
  const sats=decodeChannels(decoded[0],decoded[1]);assert.equal(sats.channels.length,32);assert.equal(sats.decodedChannels,31);assert.equal(sats.assigned,20);
  assert.deepEqual(sats.bySystem,{GPS:10,'ГЛОНАСС':9,SBAS:1});
  const first=sats.channels[0];assert.equal(first.system,'ГЛОНАСС');assert.equal(first.id,5);assert.equal(first.cno,41);assert.equal(first.frequencyChannel,1);assert.equal(first.used,null);
  assert.equal(sats.channels[30].system,'SBAS');assert.equal(sats.channels[30].id,32);assert.equal(sats.channels[31].type,null);assert.equal(sats.channels[31].cno,null);
  const final=decodeChannels(decoded.at(-2),decoded.at(-1));assert.notDeepEqual(final.channels,sats.channels);
});
test('GSV groups are atomic, separate signals and do not double-count unique satellites',()=>{
  const stream=new NmeaStream();
  stream.feed(Buffer.from(line('GPGSV,2,1,05,01,10,100,30,02,20,120,35,03,30,140,40,04,40,160,45,1')));assert.equal(stream.satellites().records.length,0);
  stream.feed(Buffer.from(line('GPGSV,2,2,05,05,50,180,,1')));let sat=stream.satellites();assert.equal(sat.records.length,5);assert.equal(sat.unique,5);assert.equal(sat.records.at(-1).cno,null);
  stream.feed(Buffer.from(line('GPGSV,1,1,01,01,10,100,25,5')));sat=stream.satellites();assert.equal(sat.records.length,6);assert.equal(sat.unique,5);
  stream.feed(Buffer.from(line('GPGSV,1,1,01,02,20,120,36,1')));sat=stream.satellites();assert.equal(sat.records.length,2);assert.equal(sat.unique,2);
  assert.equal(stream.satellites(Date.now()+16000).records.length,0);
});
test('GSA identifies used GNSS satellites and matches GLONASS slot numbering',()=>{
  const stream=new NmeaStream();stream.feed(Buffer.from(gsa(['01'],'1')+gsa(['65'],'2')));
  stream.feed(Buffer.from(line('GPGSV,1,1,02,01,10,100,30,02,20,120,35,1')+line('GLGSV,1,1,01,65,40,200,38,1')));
  const sats=stream.satellites();assert.equal(sats.records.find(s=>s.system==='GPS'&&s.id===1).used,true);assert.equal(sats.records.find(s=>s.id===2).used,false);assert.equal(sats.records.find(s=>s.system==='ГЛОНАСС').used,true);
});
test('speed comes only from explicit valid RMC/VTG; empty speed is not zero',()=>{
  const stream=new NmeaStream();stream.feed(Buffer.from(gga));assert.equal(stream.current.speedMps,null);
  stream.feed(Buffer.from(line('GNVTG,0.0,T,,M,19.4384,N,36.000,K,A')));assert.equal(stream.current.speedMps*3.6,36);assert.equal(stream.current.speedSource,'VTG');
  const invalid=new NmeaStream();invalid.feed(Buffer.from(gga+line('GNVTG,0.0,T,,M,19.4384,N,36.000,K,N')));assert.equal(invalid.current.speedMps,null);
  const r=parseSentence(line('GNRMC,140000.00,A,5000.0000,N,03000.0000,E,,0.0,010120,,,A'));assert.equal(r.speedMps,null);
});
test('legacy GN GSA preserves separate constellations and extended Galileo IDs match local IDs',()=>{
  const stream=new NmeaStream();stream.feed(Buffer.from(gsa(['01'])+gsa(['65'])+gsa(['301'],'3')));
  stream.feed(Buffer.from(line('GPGSV,1,1,01,01,10,100,30')+line('GLGSV,1,1,01,65,40,200,38')+line('GAGSV,1,1,01,01,50,220,42')));
  assert.deepEqual(stream.satellites().records.map(s=>s.used),[true,true,true]);
});
test('coordinate difference includes degrees and correct signed direction',()=>{
  const d=positionDifference({latitude:45,longitude:42,heightRaw:600},{latitude:45.00001,longitude:42.00001});
  assert.ok(d.northM>1);assert.ok(d.eastM>.7);assert.ok(d.bearingDeg>30&&d.bearingDeg<40);assert.ok(Math.abs(d.latitudeDeltaDeg-.00001)<1e-10);
});
test('HTML report includes coordinate scatter and satellites, omits unavailable speed',()=>{
  const stats=Object.fromEntries(['northM','eastM','horizontalM','verticalM'].map(k=>[k,summarize(k==='verticalM'?[]:[1])]));
  const nav={stats,paired:1,failed:0,last:{difference:{horizontalM:1,northM:1,eastM:0},mnav:{valid:true,sats:12,speedMps:null}},nmea:{fix:null},horizontalBiasM:1,info:decoded[0],satellites:{ukus:decodeChannels(decoded[0],decoded[1]),mnav:{unique:0,signals:0,records:[]}}};
  const run={id:'test',startedAt:new Date().toISOString(),config:{},samples:[],navigation:{snapshot:()=>structuredClone(nav),samples:[{difference:{northM:1,eastM:0}}]}};
  const html=reportHtml(run);assert.match(html,/Спутники: последний/);assert.match(html,/Разность координат/);assert.doesNotMatch(html,/Последняя переданная скорость/);
  nav.last.mnav.speedMps=10;assert.match(reportHtml(run),/36 км\/ч/);
});
