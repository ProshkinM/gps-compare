import dgram from 'node:dgram';
import { randomInt } from 'node:crypto';

export const TO_PORT = 10554;
export function decodeChannels(info,position){
  // 31 records fit in the first observed block. Do not reinterpret the next block's prefix as channel 32.
  const first=Buffer.from(info.rawHex,'hex').subarray(14),second=Buffer.from(position.rawHex,'hex').subarray(14);
  if(first.length!==252||second.length!==170)throw new Error('Неполный массив каналов УКУС');
  const combined=Buffer.concat([first,second]),channels=[];
  for(let i=0;i<32;i++){
    if(i===31){channels.push({channel:32,type:null,system:'Не расшифрован',id:null,cno:null,used:null,experimental:true});continue;}
    const offset=128+i*4,type=combined[offset],id=combined[offset+1],signal=combined[offset+3];
    channels.push({channel:i+1,type,system:({0:'Пусто',1:'GPS',2:'ГЛОНАСС',4:'SBAS'})[type]??`Тип ${type}`,id:type===0?null:id,cno:type===0?null:signal,frequencyChannel:type===2?combined.readInt8(offset+2):null,used:null,experimental:true});
  }
  const assigned=channels.filter(c=>c.type!==0&&c.type!==null);
  return {receivedAt:position.receivedAt,channels,decodedChannels:31,assigned:assigned.length,withSignal:assigned.filter(c=>c.cno>0).length,bySystem:Object.fromEntries([...new Set(assigned.map(c=>c.system))].map(system=>[system,assigned.filter(c=>c.system===system).length])),used:null,experimental:true};
}
export function checksum(packet) {
  let sum = 0;
  for (let i = 2; i < packet.length; i++) if (i !== 6 && i !== 7) sum += packet[i];
  return sum & 65535;
}
// Only the observed read command 0x0005 is implemented. No write/configuration commands.
export function readRequest(sequence, offset, length) {
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 65535 || ![0,252].includes(offset) || length !== (offset === 0 ? 252 : 170)) throw new Error('Unsupported TO read');
  const packet=Buffer.alloc(14);
  packet.writeUInt16LE(0x5bad,0);packet.writeUInt16LE(sequence,2);packet.writeUInt16LE(4,4);
  packet.writeUInt16LE(5,8);packet.writeUInt16LE(offset,10);packet.writeUInt16LE(length,12);
  packet.writeUInt16LE(checksum(packet),6);return packet;
}
export function decodeResponse(packet, request) {
  if(packet.length<14 || packet.readUInt16LE(0)!==0x5bad)throw new Error('Неизвестный заголовок ТО');
  if(packet.length!==10+packet.readUInt16LE(4))throw new Error('Несовпадение длины ТО');
  if(packet.readUInt16LE(6)!==checksum(packet))throw new Error('Ошибка контрольной суммы ТО');
  if(packet.readUInt16LE(2)!==request.readUInt16LE(2))throw new Error('Несовпадение номера запроса ТО');
  if(packet.readUInt16LE(8)!==0x85 || packet.readUInt16LE(10)!==request.readUInt16LE(10) || packet.readUInt16LE(12)!==request.readUInt16LE(12))throw new Error('Неподходящий ответ ТО');
  const data=packet.subarray(14),offset=packet.readUInt16LE(10);
  if(data.length!==request.readUInt16LE(12))throw new Error('Неполный блок ТО');
  const result={offset,rawHex:packet.toString('hex'),receivedAt:new Date().toISOString(),validity:'unknown',profile:'CSM24 04.08 / NV08C 07.03; experimental'};
  if(offset===0){
    result.firmware=data.subarray(40,72).toString('ascii').replace(/\0.*$/s,'').trim();
    result.receiver=data.subarray(72,104).toString('ascii').replace(/\0.*$/s,'').trim();
  }else{
    result.latitude=data.readDoubleLE(4)*180/Math.PI;
    result.longitude=data.readDoubleLE(12)*180/Math.PI;
    result.heightRaw=data.readDoubleLE(20);
    result.flagsHex=data.subarray(0,4).toString('hex');
    result.timeCandidate1=data.readUInt32LE(44);result.timeCandidate2=data.readUInt32LE(48);
    if(!Number.isFinite(result.latitude)||Math.abs(result.latitude)>90||!Number.isFinite(result.longitude)||Math.abs(result.longitude)>180||!Number.isFinite(result.heightRaw)||Math.abs(result.heightRaw)>100000)throw new Error('Координаты не соответствуют экспериментальному профилю ТО');
  }
  return result;
}
export function readBlock(host,offset,{port=TO_PORT,timeoutMs=1500}={}) {
  const request=readRequest(randomInt(65536),offset,offset===0?252:170);
  return new Promise((resolve,reject)=>{
    const socket=dgram.createSocket('udp4');let done=false;
    const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer);try{socket.close();}catch{}error?reject(error):resolve(result);};
    const timer=setTimeout(()=>finish(new Error('Тайм-аут УКУС ТО UDP/'+port)),timeoutMs);
    socket.on('error',error=>finish(error));
    socket.connect(port,host,()=>{
      if(done)return;
      socket.on('message',packet=>{
        // Ignore unrelated/stale replies on the socket, but reject malformed matching replies.
        if(packet.length>=4 && packet.readUInt16LE(2)!==request.readUInt16LE(2))return;
        try{finish(null,decodeResponse(packet,request));}catch(error){finish(error);}
      });
      socket.send(request,error=>{if(error)finish(error);});
    });
  });
}
