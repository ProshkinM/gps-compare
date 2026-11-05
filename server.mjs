import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { probe, summarize } from './ntp.mjs';
import { Navigation } from './navigation.mjs';
import { makeReport, reportHtml, timeStats } from './report.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.NTP_DATA_DIR ? path.resolve(process.env.NTP_DATA_DIR) : path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const token = randomUUID();
const ntpPort=Number(process.env.NTP_PORT||123);
const keys = ['ukus', 'mnav', 'internet'];
let run = null;
let timer = null;
let pending = false;
const headers = ['cycle','utc','source','host','ip','valid','error','offset_ms','delay_ms','processing_ms','delta_vs_ukus_ms','pair_bound_ms','stratum','leap','root_delay_ms','root_dispersion_ms','t1_unix_ms','t2_unix_ms','t3_unix_ms','t4_unix_ms','pair_gap_ms'];
const csvCell = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
function validate(body) {
  const config = {};
  for (const key of keys) {
    const host = String(body[key] ?? '').trim();
    if (!host || host.length > 253 || !/^[a-zA-Z0-9.-]+$/.test(host) || host.startsWith('-')) throw new Error('Укажите IPv4 или DNS-имя для каждого сервера, без http:// и номера порта');
    config[key] = host;
  }
  config.interval = Number(body.interval ?? 16);
  config.timeout = Number(body.timeout ?? 2500);
  config.duration = Number(body.duration ?? 24);
  config.ntpPort=ntpPort;
  config.navEnabled = body.navEnabled === true || body.navEnabled === 'on';
  config.nmeaPort = Number(body.nmeaPort ?? 6006);
  config.navInterval = Number(body.navInterval ?? 5);
  config.maxNmeaAgeMs = Number(body.maxNmeaAgeMs ?? 3000);
  config.ukusHeightType = String(body.ukusHeightType ?? 'unknown');
  for(const key of ['northCorrectionM','eastCorrectionM','heightCorrectionM']) {
    config[key]=Number(body[key]??0);
    if(!Number.isFinite(config[key])||Math.abs(config[key])>10000)throw new Error('Поправка положения антенн: не более 10000 м по модулю');
  }
  for(const key of ['testTitle','ukusSerial','mnavSerial','testNotes'])config[key]=String(body[key]??'').slice(0,key==='testNotes'?4000:200);
  if(!Number.isInteger(config.nmeaPort)||config.nmeaPort<1||config.nmeaPort>65535)throw new Error('Номер TCP-порта: 1–65535');
  if(!Number.isFinite(config.navInterval)||config.navInterval<2||config.navInterval>60)throw new Error('Период навигации: 2–60 с');
  if(!Number.isFinite(config.maxNmeaAgeMs)||config.maxNmeaAgeMs<500||config.maxNmeaAgeMs>10000)throw new Error('Возраст NMEA: 500–10000 мс');
  if(!['unknown','msl','ellipsoid'].includes(config.ukusHeightType))throw new Error('Неизвестная система высот');
  if (!Number.isFinite(config.interval) || config.interval < 16 || config.interval > 3600) throw new Error('Интервал: от 16 до 3600 секунд');
  if (!Number.isFinite(config.timeout) || config.timeout < 500 || config.timeout > 5000) throw new Error('Тайм-аут: от 500 до 5000 мс');
  if (!Number.isFinite(config.duration) || config.duration <= 0 || config.duration > 72) throw new Error('Длительность: больше 0, не более 72 часов');
  return config;
}
function stop(reason = 'Остановлено пользователем') {
  clearTimeout(timer);
  if (run) { run.active = false; run.message = reason; run.stoppedAt=new Date().toISOString(); run.navigation?.stop(); saveReports(run); }
}
function saveReports(current){
  try{
    const base=current.file.slice(0,-4);
    fs.writeFileSync(base+'.report.json',JSON.stringify(makeReport(current),null,2));
    fs.writeFileSync(base+'.report.html',reportHtml(current));
  }catch(error){current.message='Ошибка сохранения отчёта: '+error.message;}
}
async function cycle(current) {
  if (!current.active || run !== current) return;
  pending = true;
  current.pending = true;
  const wallStart = Date.now();
  const monoStart = performance.now();
  const results = await Promise.all(keys.map(async key => {
    try { return { key, host: current.config[key], ok: true, ...await probe(current.config[key], { port:ntpPort,timeoutMs: current.config.timeout }) }; }
    catch (error) { return { key, host: current.config[key], ok: false, error: error.message, receivedAt: new Date().toISOString() }; }
  }));
  // Also reject paired samples if the PC clock jumps between the individual sends.
  if (Math.abs(Date.now() - wallStart - (performance.now() - monoStart)) > 5) {
    results.forEach(result => { result.ok = false; result.error = 'Скачок часов ПК в цикле'; });
  }
  const reference = results[0];
  const sample = { index: current.samples.length + 1, utc: new Date().toISOString(), results };
  for (const result of results) {
    result.deltaMs = result.ok && reference.ok ? result.offsetMs - reference.offsetMs : null;
    result.pairGapMs = result.ok && reference.ok ? Math.abs(result.t1 - reference.t1) : null;
    result.referenceDelayMs = reference.ok ? reference.delayMs : null;
    // Diagnostic delay bound only; not a certified uncertainty or UTC accuracy.
    result.pairBoundMs = result.deltaMs !== null ? (result.delayMs + reference.delayMs) / 2 : null;
  }
  current.samples.push(sample);
  try {
    const lines = results.map(r => [sample.index,sample.utc,r.key,r.host,r.ip,r.ok,r.error,r.ok?r.offsetMs:null,r.ok?r.delayMs:null,r.ok?r.processingMs:null,r.deltaMs,r.pairBoundMs,r.stratum,r.leap,r.rootDelayMs,r.rootDispersionMs,r.t1,r.t2,r.t3,r.t4,r.pairGapMs].map(csvCell).join(',')).join('\r\n');
    fs.appendFileSync(current.file, lines + '\r\n', 'utf8');
  } catch (error) { stop(`Ошибка записи CSV: ${error.message}`); }
  pending = false;
  current.pending = false;
  if(!current.active)saveReports(current);
  if (results.some(r => r.error?.startsWith("Kiss-o'-Death"))) stop('Сервер прислал Kiss-o\'-Death. Опрос остановлен; проверьте сообщение и правила сервера.');
  if (!current.active) return;
  if (Date.now() >= current.endsAt || current.samples.length >= 20000) { stop('Измерение завершено'); return; }
  timer = setTimeout(() => cycle(current), current.config.interval * 1000);
}
function snapshot() {
  if (!run) return { run: null };
  const stats=timeStats(run);
  return { run: { id: run.id, config: run.config, active: run.active, startedAt: run.startedAt, endsAt: run.endsAt, message: run.message, count: run.samples.length, pending, stats, samples: run.samples.slice(-1000), navigation:run.navigation?.snapshot()??null, filename: path.basename(run.file) } };
}
const assets = new Map([['/', ['index.html','text/html; charset=utf-8']], ['/app.js', ['app.js','text/javascript; charset=utf-8']], ['/style.css', ['style.css','text/css; charset=utf-8']]]);
function reply(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'");
  const allowedHosts = [`127.0.0.1:${server.address().port}`, `localhost:${server.address().port}`];
  if (!allowedHosts.includes(req.headers.host)) { reply(res, 403, { error: 'Localhost only' }); return; }
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'GET' && assets.has(url.pathname)) {
      const [file, type] = assets.get(url.pathname);
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(fs.readFileSync(path.join(root, 'public', file))); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/state') { reply(res, 200, { ...snapshot(), token }); return; }
    if(req.method==='GET'&&['/api/report.html','/api/report.json','/api/navigation.csv','/api/nmea.log','/api/satellites.csv'].includes(url.pathname)){
      if(!run){reply(res,404,{error:'Нет измерений'});return;}
      const suffix=url.pathname.slice('/api/'.length);
      if(['navigation.csv','nmea.log','satellites.csv'].includes(suffix)){
        if(!run.navigation){reply(res,404,{error:'Навигационный канал не был включён'});return;}
        const file=suffix==='navigation.csv'?run.navigation.paths.csv:suffix==='satellites.csv'?run.navigation.paths.satellites:run.navigation.paths.raw;
        res.writeHead(200,{'Content-Type':suffix.endsWith('.csv')?'text/csv; charset=utf-8':'text/plain; charset=utf-8','Content-Disposition':`attachment; filename="${run.id}.${suffix}"`,'Cache-Control':'no-store'});fs.createReadStream(file).pipe(res);return;
      }
      saveReports(run);
      const html=suffix.endsWith('.html');
      res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
      const disposition=html&&url.searchParams.get('view')==='1'?'inline':'attachment';
      res.writeHead(200,{'Content-Type':html?'text/html; charset=utf-8':'application/json; charset=utf-8','Content-Disposition':`${disposition}; filename="${run.id}.${suffix}"`,'Cache-Control':'no-store'});
      res.end(html?reportHtml(run):JSON.stringify(makeReport(run),null,2));return;
    }
    if (req.method === 'GET' && url.pathname === '/api/csv') {
      if (!run) { reply(res, 404, { error: 'Нет измерений' }); return; }
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${path.basename(run.file)}"`, 'Cache-Control': 'no-store' });
      fs.createReadStream(run.file).pipe(res); return;
    }
    if (req.method === 'POST' && ['/api/start','/api/stop'].includes(url.pathname)) {
      if (req.headers['x-session-token'] !== token || (req.headers.origin && !allowedHosts.some(host => req.headers.origin === `http://${host}`))) { reply(res,403,{error:'Недопустимый запрос'}); return; }
      if (url.pathname === '/api/stop') { stop(); reply(res,200,snapshot()); return; }
      if (run?.active || pending || run?.navigation?.busy) { reply(res,409,{error:'Сначала остановите текущий тест и дождитесь завершения запроса'}); return; }
      let raw = '';
      for await (const part of req) { raw += part; if (raw.length > 16384) throw new Error('Слишком большой запрос'); }
      const config = validate(JSON.parse(raw));
      const id = new Date().toISOString().replace(/[:.]/g,'-') + '-' + randomUUID().slice(0,8);
      const file = path.join(dataDir, `${id}.csv`);
      fs.writeFileSync(file, '\ufeff' + headers.join(',') + '\r\n', 'utf8');
      fs.writeFileSync(path.join(dataDir, `${id}.json`), JSON.stringify({config, startedAt:new Date().toISOString(), method:'NTPv4 software timestamps; positive offset=server-PC; delta=server-UKUS; all numeric time values in ms'},null,2));
      run = { id, file, config, startedAt: new Date().toISOString(), endsAt: Date.now()+config.duration*3600000, samples: [], active: true, message: 'Идёт опрос' };
      if(config.navEnabled){
        run.navigation=new Navigation(config,file.slice(0,-4));
        const current=run;run.navigation.onUpdate=()=>{if(!current.active&&!current.pending)saveReports(current);};
        run.navigation.start();
      }
      void cycle(run);
      reply(res,200,snapshot()); return;
    }
    reply(res,404,{error:'Не найдено'});
  } catch(error) { reply(res,400,{error:error.message}); }
});
const port = Number(process.env.PORT || 8765);
server.on('error', error => { console.error(`Не удалось запустить: ${error.message}`); process.exitCode=1; });
server.listen(port, '127.0.0.1', () => console.log(`gps-compare: http://127.0.0.1:${server.address().port}\nCSV: ${dataDir}\nДля выхода: Ctrl+C`));
process.on('SIGINT', () => { stop('Сервер приложения остановлен'); server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { stop('Сервер приложения остановлен'); server.close(() => process.exit(0)); });
