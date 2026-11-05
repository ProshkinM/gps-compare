import { summarize } from './ntp.mjs';
export function drift(samples,key){
  const points=samples.flatMap(s=>{const r=s.results.find(r=>r.key===key);return Number.isFinite(r?.deltaMs)?[[Date.parse(s.utc),r.deltaMs]]:[];});
  if(points.length<3)return null;
  const origin=points[0][0],p=points.map(([t,v])=>[(t-origin)/1000,v]),mx=p.reduce((a,v)=>a+v[0],0)/p.length,my=p.reduce((a,v)=>a+v[1],0)/p.length;
  const denominator=p.reduce((a,v)=>a+(v[0]-mx)**2,0);if(!denominator)return null;
  return p.reduce((a,v)=>a+(v[0]-mx)*(v[1]-my),0)/denominator*1000;
}
export function timeStats(run){
  return Object.fromEntries(['ukus','mnav','internet'].map(key=>{
    const rows=run.samples.map(s=>s.results.find(r=>r.key===key)),good=rows.filter(r=>r.ok),pairs=good.filter(r=>Number.isFinite(r.deltaMs));
    const sorted=pairs.slice().sort((a,b)=>(a.delayMs+a.referenceDelayMs)-(b.delayMs+b.referenceDelayMs));
    const filtered=sorted.slice(0,Math.ceil(sorted.length*.2));
    return [key,{total:rows.length,valid:good.length,failed:rows.length-good.length,delta:summarize(pairs.map(r=>r.deltaMs)),offset:summarize(good.map(r=>r.offsetMs)),delay:summarize(good.map(r=>r.delayMs)),lowDelayDelta:summarize(filtered.map(r=>r.deltaMs)),driftPpm:key==='ukus'?null:drift(run.samples,key),last:rows.at(-1)??null}];
  }));
}
export function makeReport(run){
  const nav=run.navigation?.snapshot()??null;
  // Exclude large raw packet histories from JSON summary; they remain in journals/CSV.
  if(nav)delete nav.samples;
  return {format:'mnav-comparison-report-v3',generatedAt:new Date().toISOString(),id:run.id,title:run.config.testTitle||'Сравнительное испытание УКУС и МНАВ',active:run.active,pending:!!run.pending||!!run.navigation?.busy,startedAt:run.startedAt,stoppedAt:run.stoppedAt??null,lastMeasurementAt:run.samples.at(-1)?.utc??null,message:run.message,config:run.config,ntp:timeStats(run),navigation:nav,limitations:[
    'Измеряется расхождение с УКУС, а не абсолютная погрешность UTC или 1PPS. Программные временные метки содержат влияние ОС и сети.',
    'Среднее и дрейф могут включать постоянную и изменяющуюся асимметрию сети. Отбор 20% пар по наименьшей сумме delay не устраняет постоянную асимметрию.',
    'Экспериментальный протокол ТО проверен по двум дампам: 19 ответов каждого блока CSM24 04.08 / NV08C 07.03. Флаги достоверности координат УКУС и система его высот не подтверждены.',
    'Навигационные пары формируются по близости поступления данных на ПК, а не по подтверждённой общей эпохе GNSS. Сравнение предназначено для неподвижных антенн.',
    'Скорость показывается в км/ч только при наличии достоверного поля RMC или VTG МНАВ. Скорость УКУС и относительная погрешность скорости не определены.',
    'Каналы УКУС 1–31 декодированы экспериментально; канал 32 и участие спутников УКУС в решении не расшифрованы. Таблица МНАВ требует GSV, признаки участия — GSA; отдельные сигналы не считаются отдельными спутниками.',
    'Время из NMEA и кандидаты времени в блоке ТО не используются для измерения точности часов или PPS.',
    'Отсутствие данных не означает нулевое расхождение. Приложение не выдаёт заключение о метрологическом соответствии.'
  ]};
}
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=v=>Number.isFinite(v)?v.toLocaleString('ru-RU',{maximumFractionDigits:6}):'нет данных';
const label={ukus:'УКУС',mnav:'МНАВ',internet:'Интернет'};
function navigationReport(n,samples=[]){
  if(!n)return '<p>Навигационный канал не был включён.</p>';
  const d=n.last?.difference,g=n.nmea.fix??n.last?.mnav;
  const tableRows=Object.entries(n.stats).map(([key,s])=>`<tr><td>${escape({northM:'Север',eastM:'Восток',horizontalM:'Горизонтальное расстояние',verticalM:'Высота'}[key])}</td><td>${s.count}</td><td>${fmt(s.mean)}</td><td>${fmt(s.std)}</td><td>${fmt(s.rmse)}</td><td>${fmt(s.p95Abs)}</td><td>${fmt(s.maxAbs)}</td></tr>`).join('');
  const us=n.satellites?.ukus,ms=n.satellites?.mnav;
  const satTable=(title,records)=>`<h3>${title}</h3><table><tr><th>Система</th><th>ID</th><th>Канал / сигнал</th><th>C/N₀*</th><th>В решении</th></tr>${records.length?records.map(s=>`<tr><td>${escape(s.system)}</td><td>${escape(s.id??'—')}</td><td>${escape(s.channel??s.signalId??'—')}</td><td>${fmt(s.cno)}</td><td>${s.used===true?'Да':s.used===false?'Нет':'Не установлено'}</td></tr>`).join(''):'<tr><td colspan="5">Нет данных</td></tr>'}</table>`;
  const points=samples.filter(s=>s.difference).map(s=>s.difference),step=Math.max(1,Math.ceil(points.length/1000));
  const extent=points.reduce((max,p)=>Math.max(max,Math.abs(p.northM),Math.abs(p.eastM)),1)*1.1;
  const dots=points.filter((_,i)=>i%step===0).map(p=>`<circle cx="${450+p.eastM/extent*130}" cy="${160-p.northM/extent*130}" r="2" fill="#087f79"/>`).join('');
  const scatter=points.length?`<svg viewBox="0 0 900 330" role="img" aria-label="Разность координат"><rect width="900" height="330" fill="#f6f8fb"/><path d="M30 160H870 M450 20V300" stroke="#bacbd5"/>${dots}<text x="30" y="320" font-size="12">Восток → · север ↑ · масштаб ±${fmt(extent)} м по обеим осям · до 1000 точек</text></svg>`:'';
  return `<p class="note">Достоверность координат УКУС не расшифрована. Условные пары: ${n.paired}; исключённые циклы: ${n.failed}. Сопоставление по поступлению, без подтверждённой общей эпохи. ${escape(n.error||n.storageError||'')}</p><p>Последняя разность координат: ${fmt(d?.horizontalM)} м по горизонтали; север ${fmt(d?.northM)} м, восток ${fmt(d?.eastM)} м. Среднее расстояние ${fmt(n.stats.horizontalM.mean)} м. Длина среднего вектора ${fmt(n.horizontalBiasM)} м.<br>Версии УКУС: ${escape(n.info?.firmware||'нет ответа')}; ${escape(n.info?.receiver||'нет ответа')}.</p>${g?.valid&&Number.isFinite(g.speedMps)?`<p>Последняя переданная скорость МНАВ: ${fmt(g.speedMps*3.6)} км/ч (NMEA ${escape(g.speedSource??'RMC')}).</p>`:''}<table><tr><th>Компонента</th><th>N</th><th>Среднее, м</th><th>СКО, м</th><th>RMSE, м</th><th>P95 |·|, м</th><th>Max |·|, м</th></tr>${tableRows}</table>${scatter}<h2>Спутники: последний полученный срез</h2><p>УКУС: ${us?.assigned??0} назначенных каналов из 31 расшифрованного. МНАВ: ${ms?.unique??0} уникальных ID, ${ms?.signals??0} записей сигналов. GGA: используется ${g?.sats??'не указано'} спутников. Это разные показатели, напрямую их число не сравнивается.</p>${satTable('УКУС — экспериментальное декодирование',us?.channels.filter(s=>s.type!==0&&s.type!==null)??[])}${satTable('МНАВ — NMEA GSV/GSA',ms?.records??[])}<p>* Уровень УКУС интерпретирован по дампам; использование в решении неизвестно. Нумерация ID сохранена исходной. Полная история — в satellites.csv и navigation.jsonl.</p>`;
}
function plot(samples,key){
  const p=samples.map((s,i)=>({i,value:s.results.find(r=>r.key===key)?.deltaMs})).filter(p=>Number.isFinite(p.value));
  if(!p.length)return '<p>Нет достоверных пар NTP для графика.</p>';
  const step=Math.max(1,Math.ceil(p.length/1500)),draw=p.filter((_,i)=>i%step===0||i===p.length-1);
  const low=Math.min(...p.map(p=>p.value),0),high=Math.max(...p.map(p=>p.value),0),span=Math.max(high-low,.001);
  const points=draw.map(p=>`${60+p.i/Math.max(samples.length-1,1)*780},${170-(p.value-low)/span*140}`).join(' ');
  return `<svg viewBox="0 0 900 210" role="img" aria-label="График NTP ${label[key]}"><rect width="900" height="210" fill="#f6f8fb"/><text x="10" y="20" font-size="12">${escape(label[key])} Δ, мс; ${escape(fmt(low))} … ${escape(fmt(high))}</text><polyline points="${points}" fill="none" stroke="#087f79" stroke-width="1.5"/><text x="60" y="200" font-size="11">Циклы 1 … ${samples.length}. Пропуски исключены; линия соединяет доступные точки.</text></svg>`;
}
export function reportHtml(run){
  const r=makeReport(run),c=r.config,n=r.navigation;
  const rows=Object.entries(r.ntp).map(([key,s])=>`<tr><td>${label[key]}</td><td>${s.valid}/${s.failed}</td><td>${s.delta.count}</td>${['mean','std','rmse','p95Abs','p99Abs','maxAbs'].map(k=>`<td>${key==='ukus'?'—':fmt(s.delta[k])}</td>`).join('')}<td>${fmt(s.driftPpm)}</td></tr>`).join('');
  const navRows=n?Object.entries(n.stats).map(([key,s])=>`<tr><td>${escape({northM:'Север',eastM:'Восток',horizontalM:'Горизонтальное расстояние',verticalM:'Высота'}[key])}</td><td>${s.count}</td><td>${fmt(s.mean)}</td><td>${fmt(s.std)}</td><td>${fmt(s.rmse)}</td><td>${fmt(s.p95Abs)}</td><td>${fmt(s.maxAbs)}</td></tr>`).join(''):'';
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><title>${escape(r.title)}</title><style>body{font:14px Arial,sans-serif;color:#203346;margin:35px auto;max-width:1100px;padding:20px}h1{font-size:28px}h2{margin-top:30px;font-size:20px}p,li{line-height:1.6}table{border-collapse:collapse;width:100%;font-size:11px}td,th{padding:9px;border:1px solid #ccd7e0;text-align:left}th{background:#edf3f6}.note{background:#fff3d9;padding:16px}svg{width:100%;height:auto}pre{white-space:pre-wrap} @media print{body{margin:0;padding:0;max-width:none}h2{break-after:avoid}tr,svg{break-inside:avoid}@page{size:A4 landscape;margin:14mm}}</style><h1>${escape(r.title)}</h1><p class="note">${r.active||r.pending?'ПРОМЕЖУТОЧНЫЙ ОТЧЁТ: измерение или текущие запросы ещё не завершены.':'Отчёт по завершённому запуску.'} Результаты — относительные, без заключения о метрологическом соответствии.</p><p>Идентификатор: ${escape(r.id)}<br>Начало UTC: ${escape(r.startedAt)}<br>Остановка UTC: ${escape(r.stoppedAt||'—')}<br>Сформирован UTC: ${escape(r.generatedAt)}<br>Состояние: ${escape(r.message)}</p><h2>Условия и устройства</h2><p>УКУС: ${escape(c.ukus)}; № ${escape(c.ukusSerial||'не указан')}<br>МНАВ: ${escape(c.mnav)}; № ${escape(c.mnavSerial||'не указан')}<br>Интернет: ${escape(c.internet)}<br>Интервал NTP ≥ ${c.interval} с, тайм-аут ${c.timeout} мс. NMEA TCP/${c.nmeaPort}; ТО UDP/10554, период ≥ ${c.navInterval} с.<br>Система высоты УКУС, выбранная оператором: ${escape(c.ukusHeightType)}<br>Вычитаемое положение антенны МНАВ относительно УКУС: север ${c.northCorrectionM} м, восток ${c.eastCorrectionM} м, высота ${c.heightCorrectionM} м.</p><p>${escape(c.testNotes||'Условия установки антенн и сеть не описаны оператором.').replaceAll('\n','<br>')}</p><h2>Время NTP</h2><p>Положительная Δ означает опережение УКУС. Все значения Δ — в мс. СКО рассчитано с делением на N; процентили — для |Δ|. Дрейф: линейная регрессия Δ по времени, ppm, включая влияние сети.</p><table><tr><th>Источник</th><th>Ответы/ошибки</th><th>Пары</th><th>Среднее Δ</th><th>СКО Δ</th><th>RMSE Δ</th><th>P95 |Δ|</th><th>P99 |Δ|</th><th>Max |Δ|</th><th>Дрейф ppm</th></tr>${rows}</table><h2>20% пар с наименьшей суммой задержек</h2><table><tr><th>Источник</th><th>Число пар</th><th>Среднее Δ, мс</th><th>СКО, мс</th></tr>${['mnav','internet'].map(key=>{const s=r.ntp[key].lowDelayDelta;return `<tr><td>${label[key]}</td><td>${s.count}</td><td>${fmt(s.mean)}</td><td>${fmt(s.std)}</td></tr>`;}).join('')}</table>${plot(run.samples,'mnav')}${plot(run.samples,'internet')}<h2>Навигация: диагностическое сравнение в статике</h2>${navigationReport(n,run.navigation?.samples??[])}<h2>Ограничения метода</h2><ul>${r.limitations.map(text=>`<li>${escape(text)}</li>`).join('')}</ul><h2>Файлы измерений</h2><p>Полные исходные результаты сохраняются рядом с программой в data: ${escape(r.id)}.csv, .navigation.csv, .navigation.jsonl, .satellites.csv, .nmea.log, .report.json, .report.html (навигационные файлы — при включённом канале). Этот HTML самодостаточен: его можно сохранить и распечатать в PDF из браузера (Ctrl+P).</p></html>`;
}
