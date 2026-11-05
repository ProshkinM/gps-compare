import fs from 'node:fs';
import { readBlock,decodeChannels } from './ukus.mjs';
import { NmeaClient } from './nmea.mjs';
import { summarize } from './ntp.mjs';

export function positionDifference(reference,mnav,config={}) {
  const lat=reference.latitude*Math.PI/180,e2=6.69437999014e-3;
  const w=Math.sqrt(1-e2*Math.sin(lat)**2),n=6378137/w,m=6378137*(1-e2)/(w**3);
  const north=(mnav.latitude-reference.latitude)*Math.PI/180*m-(config.northCorrectionM||0);
  const lonDifference=((mnav.longitude-reference.longitude+540)%360)-180;
  const east=lonDifference*Math.PI/180*n*Math.cos(lat)-(config.eastCorrectionM||0);
  const targetHeight=config.ukusHeightType==='msl'?mnav.altitudeMsl:config.ukusHeightType==='ellipsoid'?mnav.altitudeEllipsoid:null;
  const vertical=Number.isFinite(targetHeight)?targetHeight-reference.heightRaw-(config.heightCorrectionM||0):null;
  const horizontalM=Math.hypot(north,east);
  return {northM:north,eastM:east,horizontalM,verticalM:vertical,latitudeDeltaDeg:mnav.latitude-reference.latitude,longitudeDeltaDeg:lonDifference,bearingDeg:horizontalM>1e-6?(Math.atan2(east,north)*180/Math.PI+360)%360:null};
}
const cols=['utc_pc','valid_pair','reason','ukus_lat','ukus_lon','ukus_height_raw','ukus_validity','mnav_lat','mnav_lon','mnav_alt_msl','mnav_geoid','mnav_alt_ellipsoid','mnav_utc','mnav_quality','mnav_rmc_status','mnav_sats','mnav_hdop','mnav_pdop','mnav_vdop','mnav_speed_mps','mnav_age_ms','arrival_gap_ms','north_m','east_m','horizontal_m','vertical_m','mnav_speed_kmh','latitude_delta_deg','longitude_delta_deg','bearing_deg'];
const cell=value=>`"${String(value??'').replaceAll('"','""')}"`;
export class Navigation {
  constructor(config,base,{read=readBlock,port=10554}={}){
    this.config=config;this.base=base;this.read=read;this.port=port;this.samples=[];this.active=false;this.busy=false;this.error=null;this.storageError=null;this.info=null;this.lastUkus=null;
    this.paths={csv:base+'.navigation.csv',raw:base+'.nmea.log',journal:base+'.navigation.jsonl',satellites:base+'.satellites.csv'};
    fs.writeFileSync(this.paths.csv,'\ufeff'+cols.join(',')+'\r\n');fs.writeFileSync(this.paths.raw,'');fs.writeFileSync(this.paths.journal,'');
    fs.writeFileSync(this.paths.satellites,'\ufeffutc_pc,source,system,native_id,channel,signal_id,cno,used,elevation_deg,azimuth_deg,experimental\r\n');
    this.client=new NmeaClient(config.mnav,config.nmeaPort,line=>this.append(this.paths.raw,`${new Date().toISOString()}\t${line.slice(0,4096)}\n`));
  }
  append(file,text){try{fs.appendFileSync(file,text);}catch(error){this.storageError='Ошибка сохранения навигации: '+error.message;this.stop();}}
  start(){this.active=true;this.client.start();void this.cycle();}
  async cycle(){
    if(!this.active||this.busy)return;this.busy=true;
    clearTimeout(this.timer);
    const sample={utc:new Date().toISOString(),validPair:false,reason:null,reference:null,mnav:null,difference:null};
    try{
      this.info=await this.read(this.config.ukus,0,{port:this.port,timeoutMs:this.config.timeout});
      if(!/^CSM24 04\.08/.test(this.info.firmware)||!/^NV08C 07\.03/.test(this.info.receiver))throw new Error('Профиль ТО не подтверждён для этой прошивки: '+this.info.firmware+' / '+this.info.receiver);
      sample.reference=await this.read(this.config.ukus,252,{port:this.port,timeoutMs:this.config.timeout});this.lastUkus=sample.reference;this.error=null;
      const mnavState=this.client.snapshot();sample.mnav=structuredClone(mnavState.fix);
      this.lastSatellites={ukus:decodeChannels(this.info,sample.reference),mnav:mnavState.satellites};
      sample.satelliteCounts={ukusAssigned:this.lastSatellites.ukus.assigned,mnavUnique:this.lastSatellites.mnav.unique,mnavUsed:sample.mnav?.sats??null};
      if(!sample.mnav)sample.reason='Нет полного решения GGA/RMC от МНАВ';
      else{
        sample.mnavAgeMs=Date.now()-(sample.mnav.epochFirstReceivedMs??sample.mnav.receivedMs);
        sample.arrivalGapMs=Math.abs(Date.parse(sample.reference.receivedAt)-sample.mnav.receivedMs);
        if(!sample.mnav.valid)sample.reason='Недостоверное решение МНАВ';
        else if(!this.client.connected||sample.mnavAgeMs>this.config.maxNmeaAgeMs)sample.reason='Устаревшее решение МНАВ';
        else{sample.validPair=true;sample.difference=positionDifference(sample.reference,sample.mnav,this.config);}
      }
    }catch(error){this.error=error.message;sample.reason=error.message;}
    this.samples.push(sample);const r=sample.reference??{},g=sample.mnav??{},d=sample.difference??{};
    this.append(this.paths.csv,[sample.utc,sample.validPair,sample.reason,r.latitude,r.longitude,r.heightRaw,r.validity,g.latitude,g.longitude,g.altitudeMsl,g.geoid,g.altitudeEllipsoid,g.utc,g.quality,g.status,g.sats,g.hdop,g.pdop,g.vdop,g.valid&&Number.isFinite(g.speedMps)?g.speedMps:null,sample.mnavAgeMs,sample.arrivalGapMs,d.northM,d.eastM,d.horizontalM,d.verticalM,g.valid&&Number.isFinite(g.speedMps)?g.speedMps*3.6:null,d.latitudeDeltaDeg,d.longitudeDeltaDeg,d.bearingDeg].map(cell).join(',')+'\r\n');
    const satellites=this.lastSatellites&&sample.reference?this.lastSatellites:null;
    if(satellites){
      const satRows=[...satellites.ukus.channels.filter(s=>s.type!==0&&s.type!==null).map(s=>[sample.utc,'ukus',s.system,s.id,s.channel,null,s.cno,null,null,null,true]),...satellites.mnav.records.map(s=>[sample.utc,'mnav',s.system,s.id,null,s.signalId,s.cno,s.used,s.elevation,s.azimuth,false])];
      if(satRows.length)this.append(this.paths.satellites,satRows.map(row=>row.map(cell).join(',')).join('\r\n')+'\r\n');
    }
    this.append(this.paths.journal,JSON.stringify({...sample,receiverInfo:this.info,satellites})+'\n');this.busy=false;
    this.onUpdate?.();
    if(this.active&&this.samples.length<150000)this.timer=setTimeout(()=>this.cycle(),this.config.navInterval*1000);
    else if(this.samples.length>=150000)this.stop();
  }
  snapshot(){
    const good=this.samples.filter(s=>s.validPair),stats={};
    for(const key of ['northM','eastM','horizontalM','verticalM'])stats[key]=summarize(good.map(s=>s.difference[key]).filter(Number.isFinite));
    const horizontalBiasM=stats.northM.count?Math.hypot(stats.northM.mean,stats.eastM.mean):null;
    const nmea=this.client.snapshot();
    return {active:this.active,busy:this.busy,error:this.error,storageError:this.storageError,info:this.info,lastUkus:this.lastUkus,nmea,satellites:this.lastSatellites?{ukus:this.lastSatellites.ukus,mnav:this.active?nmea.satellites:this.lastSatellites.mnav}:null,count:this.samples.length,paired:good.length,failed:this.samples.length-good.length,stats,horizontalBiasM,last:this.samples.at(-1)||null,samples:this.samples.slice(-500),experimental:true,validityKnown:false};
  }
  stop(){this.active=false;clearTimeout(this.timer);this.client.stop();}
}
