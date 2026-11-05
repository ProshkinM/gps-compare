const $ = id => document.getElementById(id);
const labels = { ukus: 'УКУС · опорный', mnav: 'МНАВ', internet: 'Интернет' };
const keys = Object.keys(labels);
let token, latest = null, configuredRun;
const fmt = value => Number.isFinite(value) ? value.toLocaleString('ru-RU', { minimumFractionDigits:3, maximumFractionDigits:3 }) : '—';
const time = value => new Date(value).toLocaleTimeString('ru-RU', {hour12:false});
function node(tag, text, className) { const n=document.createElement(tag); if(text!==undefined)n.textContent=text; if(className)n.className=className; return n; }
function setField(key,value){const field=$('config').elements[key];if(!field)return;if(field.type==='checkbox')field.checked=value===true||value==='on';else field.value=value;}
try { const saved=JSON.parse(localStorage.getItem('ntp-config')); for(const [key,value] of Object.entries(saved||{}))setField(key,value); } catch {}
async function api(route, data) {
  const response=await fetch(route, data===undefined ? {} : {method:'POST',headers:{'Content-Type':'application/json','X-Session-Token':token},body:JSON.stringify(data)});
  const result=await response.json(); if(!response.ok)throw new Error(result.error||response.statusText); return result;
}
function showError(message) { $('error').textContent=message; $('error').hidden=!message; }
$('config').addEventListener('submit',async event=>{
  event.preventDefault(); showError(''); $('start').disabled=true;
  const config=Object.fromEntries(new FormData($('config')));
  config.navEnabled=$('config').elements.navEnabled.checked;
  try { localStorage.setItem('ntp-config',JSON.stringify(config)); render((await api('/api/start',config)).run); }
  catch(error){showError(error.message); $('start').disabled=false;}
});
$('stop').addEventListener('click',async()=>{try{render((await api('/api/stop',{})).run);}catch(error){showError(error.message);}});
function render(run) {
  latest=run;
  const active=!!run?.active;
  if(run && configuredRun!==run.id){for(const [key,value] of Object.entries(run.config))setField(key,value);configuredRun=run.id;}
  const busy=!!run?.pending||!!run?.navigation?.busy;
  for(const field of $('config').querySelectorAll('input, select, textarea'))field.disabled=active||busy;
  $('start').disabled=active||busy||!token;
  $('start').textContent=run?'Новый тест':'Начать измерение';
  $('stop').disabled=!active;
  $('download').classList.toggle('disabled',!run);
  document.querySelectorAll('.report-link').forEach(link=>link.classList.toggle('disabled',!run));
  $('nav-csv').classList.toggle('disabled',!run?.navigation);$('nmea-log').classList.toggle('disabled',!run?.navigation);
  $('sat-csv').classList.toggle('disabled',!run?.navigation);
  $('status').textContent=active?'● Измерение идёт':run?'Тест остановлен':'Готов к работе';
  $('status').classList.toggle('active',active);
  $('progress').textContent=run?`${run.count} циклов · ${run.message}${active?' · окончание '+new Date(run.endsAt).toLocaleString('ru-RU'):''}`:'Порт NTP: UDP/123 · IPv4';
  $('cards').replaceChildren(); $('stats').replaceChildren();
  for(const key of keys){
    const stat=run?.stats[key], last=stat?.last;
    const card=node('article',undefined,'card '+key);
    card.append(node('div',labels[key],'label'));
    const value=node('div',fmt(key==='ukus'?(last?.ok?last.offsetMs:null):last?.deltaMs),'value');
    value.append(node('span',' мс')); card.append(value);
    card.append(node('div',key==='ukus'?'Offset УКУС относительно ПК':'Δ относительно УКУС','detail'));
    const detail=node('div',last?(last.ok?`delay ${fmt(last.delayMs)} мс · stratum ${last.stratum} · LI ${last.leap} · ${last.ip}`:last.error):'Ожидание первого ответа','detail'+(last&&!last.ok?' bad':''));card.append(detail);
    if(last?.ok && key!=='ukus' && last.deltaMs===null)card.append(node('div','Нет достоверной пары с УКУС','detail bad'));
    if(last?.ok && key!=='ukus' && last.deltaMs!==null)card.append(node('div',`Оценка влияния задержек: ±${fmt(last.pairBoundMs)} мс*`,'detail'));
    $('cards').append(card);
    const row=node('tr'),d=stat?.delta;
    const values=[labels[key],stat?`${stat.valid} / ${stat.failed}`:'—',d?.count??0,...['mean','std','rmse','p95Abs','p99Abs','maxAbs'].map(k=>key==='ukus'?'—':fmt(d?.[k])),fmt(stat?.delay?.mean),fmt(stat?.driftPpm),key==='ukus'?'—':fmt(stat?.lowDelayDelta?.mean)];
    values.forEach(v=>row.append(node('td',v)));$('stats').append(row);
  }
  $('recent').replaceChildren();
  if(!run?.samples.length){const tr=node('tr');const td=node('td','Измерений пока нет');td.colSpan=4;tr.append(td);$('recent').append(tr);}
  for(const sample of (run?.samples||[]).slice(-12).reverse()){
    const row=node('tr');row.append(node('td',time(sample.utc)));
    sample.results.forEach(r=>row.append(node('td',r.ok?`${fmt(r.key==='ukus'?r.offsetMs:r.deltaMs)} / ${fmt(r.delayMs)}`:r.error,r.ok?'':'bad')));$('recent').append(row);
  }
  renderOverview(run);renderNavigation(run?.navigation);renderSatellites(run?.navigation);draw();
}
function renderOverview(run){
  const nav=run?.navigation,d=nav?.last?.difference,r=run?.stats?.mnav?.last,delta=Number.isFinite(r?.deltaMs)?r.deltaMs:null;
  $('comparison').replaceChildren();
  const items=[['Расхождение координат по горизонтали',d?`${fmt(d.horizontalM)} м`:'—',d?`Север ${fmt(d.northM)} м · восток ${fmt(d.eastM)} м. Последняя пара ${time(nav.last.utc)}.`:'Нужны свежие координаты УКУС и МНАВ.'],['Расхождение времени по NTP',Number.isFinite(delta)?`${fmt(delta)} мс`:'—',Number.isFinite(delta)?`${delta>=0?'МНАВ опережает УКУС':'МНАВ отстаёт от УКУС'}. Ответ ${time(r.receivedAt)}. Включает влияние сети и ОС.`:'Нужны достоверные ответы обоих NTP-серверов.'],['Среднее расстояние / устойчивое смещение',nav?.paired?`${fmt(nav.stats.horizontalM.mean)} / ${fmt(nav.horizontalBiasM)} м`:'—',nav?.paired?`P95 расстояния ${fmt(nav.stats.horizontalM.p95Abs)} м · ${nav.paired} пар. Устойчивое смещение = длина среднего вектора.`:'Статистика накопится во время измерения.']];
  const fix=nav?.nmea.fix;
  if(nav?.active&&nav.nmea.connected&&fix?.valid&&Number.isFinite(fix.speedMps)&&Date.now()-(fix.speedReceivedMs??fix.receivedMs)<=3000)items.push(['Текущая скорость МНАВ',`${fmt(fix.speedMps*3.6)} км/ч`,`Источник: NMEA ${fix.speedSource??'RMC'}. Скорость УКУС в дампе не идентифицирована.`]);
  for(const [title,value,detail] of items){const card=node('article',undefined,'overview-card');card.append(node('h2',title),node('strong',value,title.startsWith('Среднее')?'small':undefined),node('p',detail));$('comparison').append(card);}
}
function renderNavigation(nav){
  $('nav-values').replaceChildren();$('nav-stats').replaceChildren();
  $('nav-status').textContent=nav?`ТО: ${nav.error||'чтение'} · TCP МНАВ: ${nav.nmea.connected?'подключён':(nav.nmea.error||'ожидание / остановлен')} · циклов ${nav.count}, условных пар ${nav.paired}, исключено ${nav.failed} · NMEA принято ${nav.nmea.good}, ошибок ${nav.nmea.bad}`:'Навигация выключена или тест ещё не запущен.';
  const r=nav?.lastUkus,g=nav?.nmea.fix??nav?.last?.mnav,d=nav?.last?.difference;
  for(const [title,value,detail] of [
    ['УКУС · координаты',r?`${r.latitude.toFixed(8)}°, ${r.longitude.toFixed(8)}°`:'—',r?`Высота raw ${fmt(r.heightRaw)} м · флаги ${r.flagsHex} (не расшифрованы)`:'UDP/10554 · бинарный блок ТО'],
    ['МНАВ · координаты',g?`${Number.isFinite(g.latitude)?g.latitude.toFixed(8):'—'}°, ${Number.isFinite(g.longitude)?g.longitude.toFixed(8):'—'}°`:'—',g?`GGA quality ${g.quality??'—'} · RMC ${g.status??'—'} · спутников ${g.sats??'—'} · HDOP ${fmt(g.hdop)}`:'NMEA TCP/6006'],
    ['Горизонтальное расхождение',d?`${fmt(d.horizontalM)} м`:'—',d?`Север ${fmt(d.northM)} м · восток ${fmt(d.eastM)} м · высота ${fmt(d.verticalM)} м`:'Нужна свежая пара с решением МНАВ']
  ]){const card=node('div',undefined,'nav-value');card.append(node('span',title),node('strong',value),node('span',detail));$('nav-values').append(card);}
  $('nav-message').textContent=nav?.storageError||nav?.last?.reason||'Статус достоверности УКУС не подтверждён. Сопоставление по поступлению данных, только для статики. Скорость УКУС не расшифрована. Система высот по умолчанию неизвестна.';
  for(const [key,title] of [['northM','Север'],['eastM','Восток'],['horizontalM','Горизонтальное расстояние'],['verticalM','Высота']]){
    const s=nav?.stats[key],tr=node('tr');[title,s?.count??0,...['mean','std','rmse','p95Abs','maxAbs'].map(k=>fmt(s?.[k]))].forEach(v=>tr.append(node('td',v)));$('nav-stats').append(tr);
  }
  drawPositions(nav);
}
function renderSatellites(nav){
  const u=nav?.satellites?.ukus,m=nav?.satellites?.mnav;
  const bySystem=s=>Object.entries(s||{}).map(([key,n])=>`${key}: ${n}`).join(' · ');
  $('ukus-sat-summary').textContent=u?`${u.assigned} назначенных каналов / 32 · ${bySystem(u.bySystem)} · обновлено ${time(u.receivedAt)}`:'Ожидание чтения обоих блоков ТО.';
  $('mnav-sat-summary').textContent=m?.records.length?`${m.unique} уникальных ID · ${m.signals} записей сигналов · ${bySystem(m.bySystem)} · обновлено ${time(m.receivedAt)}`:`GSV пока нет. По GGA используется: ${nav?.nmea.fix?.sats??nav?.last?.mnav?.sats??'—'}.`;
  const signal=(row,value)=>{const td=node('td');if(Number.isFinite(value)){const meter=node('meter');meter.min=0;meter.max=60;meter.value=value;td.append(meter,document.createTextNode(String(value)));}else td.textContent='—';row.append(td);};
  $('ukus-satellites').replaceChildren();$('mnav-satellites').replaceChildren();
  for(const s of u?.channels||[]){const tr=node('tr');[s.channel,s.system,s.id??'—'].forEach(v=>tr.append(node('td',v)));signal(tr,s.cno);tr.append(node('td','—'));$('ukus-satellites').append(tr);}
  for(const s of m?.records||[]){const tr=node('tr');[s.system,s.id,s.signalId??'—'].forEach(v=>tr.append(node('td',v)));signal(tr,s.cno);tr.append(node('td',`${s.elevation??'—'} / ${s.azimuth??'—'}`),node('td',s.used===null?'—':s.used?'Да':'Нет'));$('mnav-satellites').append(tr);}
  for(const [id,count,message] of [['ukus-satellites',u?.channels.length,'Нет ответа УКУС'],['mnav-satellites',m?.records.length,'Нет полного набора GSV. Проверьте выдачу GSV в GPS-приёмнике.']])if(!count){const tr=node('tr'),td=node('td',message);td.colSpan=6;tr.append(td);$(id).append(tr);}
}
function drawPositions(nav){
  const canvas=$('position-chart'),ratio=devicePixelRatio||1,w=canvas.clientWidth,h=260;canvas.width=w*ratio;canvas.height=h*ratio;const ctx=canvas.getContext('2d');ctx.scale(ratio,ratio);ctx.font='12px Segoe UI';ctx.fillStyle='#718397';
  const points=(nav?.samples||[]).filter(s=>s.difference).map(s=>s.difference);
  if(!points.length){ctx.textAlign='center';ctx.fillText('Нет навигационных пар. Оси: восток / север, м.',w/2,h/2);return;}
  const extent=Math.max(1,...points.flatMap(p=>[Math.abs(p.eastM),Math.abs(p.northM)]))*1.1,scale=Math.min(w-100,h-60)/(extent*2),cx=w/2,cy=h/2;
  ctx.strokeStyle='#cbd7e1';ctx.beginPath();ctx.moveTo(30,cy);ctx.lineTo(w-20,cy);ctx.moveTo(cx,20);ctx.lineTo(cx,h-25);ctx.stroke();ctx.fillText(`Восток → · предел ±${fmt(extent)} м`,30,h-5);ctx.fillText('Север ↑',cx+5,15);
  points.forEach((p,i)=>{ctx.fillStyle=`rgba(8,127,121,${.2+.8*i/points.length})`;ctx.beginPath();ctx.arc(cx+p.eastM*scale,cy-p.northM*scale,2.8,0,Math.PI*2);ctx.fill();});
}
function draw(){
  const canvas=$('chart'),ratio=devicePixelRatio||1,w=canvas.clientWidth,h=290;canvas.width=w*ratio;canvas.height=h*ratio;
  const ctx=canvas.getContext('2d');ctx.scale(ratio,ratio);ctx.clearRect(0,0,w,h);
  const samples=latest?.samples||[], points=samples.flatMap(s=>s.results.filter(r=>r.key!=='ukus'&&r.deltaMs!==null&&Number.isFinite(r.deltaMs)).map(r=>r.deltaMs));
  $('chart-note').textContent=`${samples.length?`Показано ${samples.length} из ${latest.count} циклов. `:''}* Оценка ±(delay источника + delay УКУС)/2 — ориентир влияния задержек; не учитывает все ошибки временных меток и не является точностью относительно UTC.`;
  if(!points.length){ctx.fillStyle='#8493a3';ctx.font='14px Segoe UI';ctx.textAlign='center';ctx.fillText('Нет достоверных пар измерений',w/2,h/2);return;}
  const left=85,right=18,top=14,bottom=35,pw=w-left-right,ph=h-top-bottom;
  let lo=Math.min(0,...points),hi=Math.max(0,...points);const pad=Math.max((hi-lo)*.12,.05);lo-=pad;hi+=pad;
  const first=Date.parse(samples[0].utc),last=Date.parse(samples.at(-1).utc),span=Math.max(last-first,1);
  const x=s=>left+(samples.length===1?.5:(Date.parse(s.utc)-first)/span)*pw,y=v=>top+(hi-v)/(hi-lo)*ph;
  ctx.font='11px Segoe UI';
  for(let i=0;i<=4;i++){const v=lo+(hi-lo)*i/4,yy=y(v);ctx.strokeStyle='#e5ebf1';ctx.beginPath();ctx.moveTo(left,yy);ctx.lineTo(w-right,yy);ctx.stroke();ctx.fillStyle='#6f8192';ctx.textAlign='right';ctx.fillText(fmt(v),left-10,yy+4);}
  ctx.strokeStyle='#9baebd';ctx.setLineDash([4,4]);ctx.beginPath();ctx.moveTo(left,y(0));ctx.lineTo(w-right,y(0));ctx.stroke();ctx.setLineDash([]);
  for(const [key,color] of [['mnav','#078e89'],['internet','#c98625']]){
    ctx.strokeStyle=color;ctx.fillStyle=color;ctx.lineWidth=2;ctx.beginPath();let connected=false;
    for(const sample of samples){const r=sample.results.find(r=>r.key===key);if(!Number.isFinite(r?.deltaMs)){connected=false;continue;}if(connected)ctx.lineTo(x(sample),y(r.deltaMs));else ctx.moveTo(x(sample),y(r.deltaMs));connected=true;}ctx.stroke();
    for(const sample of samples){const r=sample.results.find(r=>r.key===key);if(Number.isFinite(r?.deltaMs)){ctx.beginPath();ctx.arc(x(sample),y(r.deltaMs),2,0,Math.PI*2);ctx.fill();}}
  }
  ctx.fillStyle='#6f8192';ctx.textAlign='left';ctx.fillText(time(samples[0].utc),left,h-9);ctx.textAlign='right';ctx.fillText(time(samples.at(-1).utc),w-right,h-9);
}
window.addEventListener('resize',()=>{draw();drawPositions(latest?.navigation);});
async function poll(){try{const state=await api('/api/state');token=state.token;render(state.run);if($('error').textContent.startsWith('Нет связи'))showError('');}catch(error){showError('Нет связи с приложением: '+error.message);}finally{setTimeout(poll,2000);}}
render(null);void poll();
