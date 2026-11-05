import dgram from 'node:dgram';
import { lookup } from 'node:dns/promises';
import { performance } from 'node:perf_hooks';
import { randomBytes } from 'node:crypto';

const EPOCH = 2208988800;
const ERA = 4294967296;

export function writeTimestamp(buffer, position, ms) {
  const seconds = Math.floor(ms / 1000) + EPOCH;
  buffer.writeUInt32BE(((seconds % ERA) + ERA) % ERA, position);
  buffer.writeUInt32BE(Math.floor(((ms % 1000 + 1000) % 1000) / 1000 * ERA), position + 4);
}

// Resolve the 2036 era rollover against the measurement computer's date.
export function readTimestamp(buffer, position, nearMs) {
  let seconds = buffer.readUInt32BE(position);
  const nearSeconds = nearMs / 1000 + EPOCH;
  seconds += Math.round((nearSeconds - seconds) / ERA) * ERA;
  return (seconds - EPOCH) * 1000 + buffer.readUInt32BE(position + 4) / ERA * 1000;
}

export function parseResponse(packet, request, t1, t4) {
  if (packet.length < 48) throw new Error('Короткий NTP-пакет');
  const leap = packet[0] >> 6;
  const version = (packet[0] >> 3) & 7;
  const mode = packet[0] & 7;
  if (mode !== 4 || ![3, 4].includes(version)) throw new Error('Ожидался ответ NTPv3/v4, mode 4');
  if (!packet.subarray(24, 32).equals(request.subarray(40, 48))) throw new Error('Не совпадает originate timestamp');
  const stratum = packet[1];
  if (stratum === 0) throw new Error(`Kiss-o'-Death: ${packet.toString('ascii', 12, 16).replace(/[^A-Z0-9]/g, '?')}`);
  if (leap === 3 || stratum > 15) throw new Error('Сервер сообщает об отсутствии синхронизации');
  if (packet.subarray(32, 40).every(v => v === 0) || packet.subarray(40, 48).every(v => v === 0)) throw new Error('Нулевая метка времени');
  const t2 = readTimestamp(packet, 32, t1);
  const t3 = readTimestamp(packet, 40, t1);
  if (t3 < t2) throw new Error('Время передачи ответа раньше времени приёма запроса');
  const delayMs = (t4 - t1) - (t3 - t2);
  if (delayMs < -0.1) throw new Error('Некорректная отрицательная сетевая задержка');
  return {
    offsetMs: ((t2 - t1) + (t3 - t4)) / 2,
    delayMs: Math.max(0, delayMs),
    processingMs: t3 - t2,
    stratum, leap, version,
    rootDelayMs: packet.readInt32BE(4) / 65536 * 1000,
    rootDispersionMs: packet.readUInt32BE(8) / 65536 * 1000,
    t1, t2, t3, t4
  };
}

export async function probe(host, { port = 123, timeoutMs = 2500 } = {}) {
  const start = performance.now();
  let dnsTimer;
  let address;
  try {
    address = await Promise.race([
      lookup(host, { family: 4 }),
      new Promise((_, reject) => { dnsTimer = setTimeout(() => reject(new Error('Тайм-аут DNS')), timeoutMs); })
    ]);
  } finally { clearTimeout(dnsTimer); }
  const remaining = timeoutMs - (performance.now() - start);
  if (remaining <= 0) throw new Error('Тайм-аут DNS');
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    let ended = false;
    const done = (error, result) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      try { socket.close(); } catch {}
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => done(new Error('Нет ответа UDP/123 (тайм-аут)')), remaining);
    socket.on('error', error => done(error));
    socket.connect(port, address.address, () => {
      if (ended) return;
      const request = Buffer.alloc(48);
      request[0] = 0x23; // LI=0, VN=4, mode=3
      request[2] = 4;
      const wallStart = Date.now();
      const monoStart = performance.now();
      writeTimestamp(request, 40, wallStart);
      // Unique request cookie in sub-microsecond fraction bits; t1 uses this exact value.
      const fraction = request.readUInt32BE(44);
      request.writeUInt32BE(((fraction & 0xffff0000) >>> 0) + randomBytes(2).readUInt16BE(), 44);
      const t1 = readTimestamp(request, 40, wallStart);
      socket.on('message', packet => {
        const elapsed = performance.now() - monoStart;
        const wallChange = Date.now() - wallStart - elapsed;
        try {
          if (Math.abs(wallChange) > 5) throw new Error('Скачок часов ПК или приостановка процесса во время запроса');
          // Monotonic duration avoids a wall-clock step between t1 and t4.
          const result = parseResponse(packet, request, t1, t1 + elapsed);
          done(null, { ...result, ip: address.address, receivedAt: new Date().toISOString(), clockChangeMs: wallChange });
        } catch (error) { done(error); }
      });
      socket.send(request, error => { if (error) done(error); });
    });
  });
}

export function summarize(values) {
  if (!values.length) return { count: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const std = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
  const sorted = values.map(Math.abs).sort((a, b) => a - b);
  return {
    count: values.length, mean, std,
    rmse: Math.sqrt(values.reduce((sum, value) => sum + value ** 2, 0) / values.length),
    p95Abs: sorted[Math.ceil(sorted.length * .95) - 1],
    p99Abs: sorted[Math.ceil(sorted.length * .99) - 1],
    maxAbs: sorted.at(-1)
  };
}
