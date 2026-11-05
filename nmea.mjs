import net from 'node:net';
import { EventEmitter } from 'node:events';

const number=value=>value!==''&&value!==undefined&&Number.isFinite(Number(value))?Number(value):null;
function system(talker,id,systemId=null){
  const explicit={1:'GPS',2:'ГЛОНАСС',3:'Galileo',4:'BeiDou',5:'QZSS',6:'NavIC'}[systemId];
  if(explicit)return explicit;
  if(talker==='GP')return id>32&&id<=64?'GPS/SBAS':'GPS';
  const named={GL:'ГЛОНАСС',GA:'Galileo',GB:'BeiDou',BD:'BeiDou',GQ:'QZSS',QZ:'QZSS',GI:'NavIC',GS:'SBAS'}[talker];
  if(named)return named;
  if(talker==='GN'){if(id>=65&&id<=96)return 'ГЛОНАСС';if(id>=301&&id<=336)return 'Galileo';if(id>=201&&id<=263)return 'BeiDou';if(id>=193&&id<=200)return 'QZSS';if(id>=1&&id<=32)return 'GPS';}
  return talker;
}
function satKey(constellation,id){
  if(constellation==='ГЛОНАСС'&&id>=65&&id<=96)id-=64;
  else if(constellation==='Galileo'&&id>=301&&id<=336)id-=300;
  else if(constellation==='BeiDou'&&id>=201&&id<=263)id-=200;
  else if(constellation==='QZSS'&&id>=193&&id<=200)id-=192;
  return constellation+':'+id;
}
export function coordinate(text,hemisphere) {
  if(!text || !['N','S','E','W'].includes(hemisphere))return null;
  const n=Number(text);if(!Number.isFinite(n)||n<0)return null;
  const degrees=Math.floor(n/100),minutes=n-degrees*100;
  if(minutes>=60)return null;
  const value=degrees+minutes/60,limit=['N','S'].includes(hemisphere)?90:180;
  if(value>limit)return null;return ['S','W'].includes(hemisphere)?-value:value;
}
function timeOfDay(value){
  if(!/^\d{6}(\.\d+)?$/.test(value||''))return null;
  const h=Number(value.slice(0,2)),m=Number(value.slice(2,4)),s=Number(value.slice(4));
  return h<24&&m<60&&s<61?(h*3600+m*60+s)*1000:null;
}
function utcDate(date,tod){
  if(!/^\d{6}$/.test(date||'')||tod===null)return null;
  const yy=Number(date.slice(4)),year=yy<80?2000+yy:1900+yy,month=Number(date.slice(2,4)),day=Number(date.slice(0,2));
  const base=Date.UTC(year,month-1,day),d=new Date(base);
  if(d.getUTCFullYear()!==year||d.getUTCMonth()!==month-1||d.getUTCDate()!==day)return null;
  return new Date(base+tod).toISOString();
}
export function parseSentence(line) {
  const match=line.trim().match(/^\$([A-Z0-9]{5},[^*\r\n]*)\*([0-9A-Fa-f]{2})$/);
  if(!match)throw new Error('Не строка NMEA с контрольной суммой');
  let checksum=0;for(const c of match[1])checksum^=c.charCodeAt(0);
  if(checksum!==parseInt(match[2],16))throw new Error('Ошибка контрольной суммы NMEA');
  const fields=match[1].split(','),type=fields[0].slice(-3),talker=fields[0].slice(0,2),f=fields;
  const result={type,talker,raw:line.trim()};
  if(type==='GGA')Object.assign(result,{tod:timeOfDay(f[1]),latitude:coordinate(f[2],f[3]),longitude:coordinate(f[4],f[5]),quality:number(f[6]),sats:number(f[7]),hdop:number(f[8]),altitudeMsl:f[10]==='M'?number(f[9]):null,geoid:f[12]==='M'?number(f[11]):null});
  if(type==='RMC')Object.assign(result,{tod:timeOfDay(f[1]),status:f[2],latitude:coordinate(f[3],f[4]),longitude:coordinate(f[5],f[6]),speedMps:number(f[7])===null?null:Number(f[7])*.5144444444444445,course:number(f[8]),date:f[9],utc:utcDate(f[9],timeOfDay(f[1])),mode:f[12]||null});
  if(type==='GSA')Object.assign(result,{fixType:number(f[2]),usedIds:f.slice(3,15).map(number).filter(v=>v!==null&&v>0),systemId:number(f[18]),pdop:number(f[15]),hdop:number(f[16]),vdop:number(f[17])});
  if(type==='VTG')Object.assign(result,{speedMps:number(f[7])!==null?Number(f[7])/3.6:number(f[5])!==null?Number(f[5])*.5144444444444445:null,mode:f[9]||null});
  if(type==='GSV'){
    const extra=(f.length-4)%4===1,limit=f.length-(extra?1:0),satellites=[];
    for(let i=4;i+3<limit;i+=4){const id=number(f[i]);if(id===null||id<=0)continue;const elevation=number(f[i+1]),azimuth=number(f[i+2]),cno=number(f[i+3]);satellites.push({id,system:system(talker,id),talker,elevation:elevation!==null&&elevation>=0&&elevation<=90?elevation:null,azimuth:azimuth!==null&&azimuth>=0&&azimuth<360?azimuth:null,cno:cno!==null&&cno>=0&&cno<=99?cno:null});}
    Object.assign(result,{total:number(f[1]),index:number(f[2]),inView:number(f[3]),signalId:extra?(f.at(-1)||null):null,satellites});
    if(!Number.isInteger(result.total)||result.total<1||result.total>32||!Number.isInteger(result.index)||result.index<1||result.index>result.total)throw new Error('Некорректная последовательность GSV');
  }
  return result;
}

export class NmeaStream extends EventEmitter {
  constructor(){super();this.buffer='';this.reset();}
  reset(){this.buffer='';this.epochs=new Map();this.current=null;this.gsa=null;this.vtg=null;this.gsvPending=new Map();this.gsvComplete=new Map();this.gsaSets=new Map();this.good??=0;this.bad??=0;this.lastError=null;}
  satellites(now=Date.now()){
    const used=new Set(),known=new Set();
    for(const entry of this.gsaSets.values())if(now-entry.receivedMs<=15000){for(const id of entry.usedIds){const constellation=system(entry.talker,id,entry.systemId);known.add(constellation);if(entry.fixType>=2)used.add(satKey(constellation,id));}if(entry.talker!=='GN'||entry.systemId)known.add(system(entry.talker,0,entry.systemId));}
    const records=[];let receivedMs=null;
    for(const entry of this.gsvComplete.values())if(now-entry.receivedMs<=15000){receivedMs=Math.max(receivedMs??0,entry.receivedMs);for(const sat of entry.satellites)records.push({...sat,signalId:entry.signalId,used:known.has(sat.system)?used.has(satKey(sat.system,sat.id)):null});}
    const unique=new Set(records.map(s=>satKey(s.system,s.id)));
    return {receivedAt:receivedMs?new Date(receivedMs).toISOString():null,records,signals:records.length,unique:unique.size,used:used.size,usedKnown:known.size>0,bySystem:Object.fromEntries([...new Set(records.map(s=>s.system))].map(s=>[s,new Set(records.filter(r=>r.system===s).map(r=>r.id)).size]))};
  }
  feed(chunk){
    this.buffer+=chunk.toString('ascii');
    if(this.buffer.length>32768){this.buffer=this.buffer.slice(-4096);this.bad++;this.lastError='Переполнение буфера NMEA';}
    let end;
    while((end=this.buffer.indexOf('\n'))>=0){
      const line=this.buffer.slice(0,end).replace(/\r$/,'');this.buffer=this.buffer.slice(end+1);
      if(!line.trim())continue;
      this.emit('raw',line);
      try{
        const sentence=parseSentence(line);this.good++;const now=Date.now();
        if(sentence.type==='GSA'){
          this.gsa={...sentence,receivedMs:now};
          const scope=sentence.systemId??(sentence.talker==='GN'?[...new Set(sentence.usedIds.map(id=>system('GN',id)))].sort().join('+'):'');
          this.gsaSets.set(sentence.talker+':'+scope,this.gsa);
        }
        if(sentence.type==='GSV'){
          const key=sentence.talker+':'+(sentence.signalId??'');let group=this.gsvPending.get(key);
          if(sentence.index===1||!group||now-group.startedMs>5000||group.total!==sentence.total){group={total:sentence.total,parts:new Map(),startedMs:now};this.gsvPending.set(key,group);}
          group.parts.set(sentence.index,sentence.satellites);
          if(group.parts.size===group.total){this.gsvComplete.set(key,{receivedMs:now,signalId:sentence.signalId,satellites:Array.from({length:group.total},(_,i)=>group.parts.get(i+1)).flat()});this.gsvPending.delete(key);}
          for(const map of [this.gsvPending,this.gsvComplete])while(map.size>64)map.delete(map.keys().next().value);
        }
        if(sentence.type==='VTG'){
          this.vtg={...sentence,receivedMs:now};
          if(this.current?.valid&&now-this.current.receivedMs<=1500&&!['N','E','S'].includes(sentence.mode)&&Number.isFinite(sentence.speedMps)&&sentence.speedMps>=0&&this.current.speedSource!=='RMC'){this.current.speedMps=sentence.speedMps;this.current.speedSource='VTG';this.current.speedReceivedMs=now;}
        }
        if(['GGA','RMC'].includes(sentence.type)&&sentence.tod!==null){
          const key=sentence.tod;const epoch=this.epochs.get(key)||{tod:key,firstReceivedMs:now};epoch[sentence.type]=sentence;epoch.receivedMs=now;this.epochs.set(key,epoch);
          while(this.epochs.size>12)this.epochs.delete(this.epochs.keys().next().value);
          const g=epoch.GGA,r=epoch.RMC;
          const fix=g||r,valid=!!fix&&(!g||[1,2,3,4,5].includes(g.quality))&&(!r||(r.status==='A'&&!['N','E','S'].includes(r.mode)))&&fix.latitude!==null&&fix.longitude!==null;
          // Do not merge fields across different UTC epochs; clear absent data.
          if(!this.current || now-this.current.receivedMs>3000 || key===this.current.tod || ((key-this.current.tod+86400000)%86400000)<43200000){
            const freshGsa=this.gsa&&now-this.gsa.receivedMs<2000?this.gsa:null;
            this.current={tod:key,utc:r?.utc??null,latitude:fix?.latitude??null,longitude:fix?.longitude??null,altitudeMsl:g?.altitudeMsl??null,geoid:g?.geoid??null,altitudeEllipsoid:g?.altitudeMsl!==null&&g?.altitudeMsl!==undefined&&g.geoid!==null?g.altitudeMsl+g.geoid:null,speedMps:r?.speedMps??null,quality:g?.quality??null,status:r?.status??null,sats:g?.sats??null,hdop:g?.hdop??freshGsa?.hdop??null,pdop:freshGsa?.pdop??null,vdop:freshGsa?.vdop??null,valid,receivedMs:now,receivedAt:new Date(now).toISOString()};
            this.current.epochFirstReceivedMs=epoch.firstReceivedMs;
            if(Number.isFinite(this.current.speedMps)&&this.current.speedMps>=0){this.current.speedSource='RMC';this.current.speedReceivedMs=now;}
            else if(this.current.valid&&this.vtg&&now-this.vtg.receivedMs<=1500&&!['N','E','S'].includes(this.vtg.mode)&&Number.isFinite(this.vtg.speedMps)&&this.vtg.speedMps>=0){this.current.speedMps=this.vtg.speedMps;this.current.speedSource='VTG';this.current.speedReceivedMs=this.vtg.receivedMs;}
            else this.current.speedMps=null;
            this.emit('fix',this.current);
          }
        }
      }catch(error){this.bad++;this.lastError=error.message;this.emit('invalid',{line,error:error.message});}
    }
  }
}

export class NmeaClient {
  constructor(host,port,onRaw){this.host=host;this.port=port;this.stream=new NmeaStream();this.stream.on('raw',onRaw);this.running=false;this.connected=false;this.lastError=null;}
  start(){this.running=true;this.connect();}
  connect(){
    if(!this.running)return;
    this.stream.reset();this.socket=net.createConnection({host:this.host,port:this.port,family:4});
    this.socket.setTimeout(15000);this.socket.on('connect',()=>{this.connected=true;this.lastError=null;});
    this.socket.on('data',chunk=>this.stream.feed(chunk));
    this.socket.on('timeout',()=>this.socket.destroy(new Error('Нет NMEA по TCP более 15 секунд')));
    this.socket.on('error',error=>{this.lastError=error.message;});
    this.socket.on('close',()=>{this.connected=false;this.stream.current=null;if(this.running)this.timer=setTimeout(()=>this.connect(),5000);});
  }
  snapshot(){return {connected:this.connected,error:this.lastError,good:this.stream.good,bad:this.stream.bad,lastError:this.stream.lastError,fix:this.stream.current,satellites:this.stream.satellites()};}
  stop(){this.running=false;clearTimeout(this.timer);this.socket?.destroy();}
}
