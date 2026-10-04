(function () {
'use strict';
var $ = function (i) { return document.getElementById(i) }, WA = '40768429345';
var st = { mk: '', mo: '', ge: '', yr: '', en: '', vin: '', vtext: '', d: null, tab: 'sw', gens: [], svc: [] };
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] }) }
function range(a) { return a[0] === a[1] ? a[0] : a[0] + '–' + a[1] }
function eur(v) { return v == null ? 'Solicită ofertă' : 'De la ' + Math.round(v).toLocaleString('ro-RO') + ' €' }

/* ---------- API: timeout + retry la erori de rețea ---------- */
async function api(path, opt) {
  for (var i = 0; i < 2; i++) {
    var c = new AbortController(), t = setTimeout(function () { c.abort() }, 12000);
    try {
      var r = await fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opt, { signal: c.signal })); clearTimeout(t);
      var j = await r.json().catch(function () { return {} });
      if (!r.ok) { var e = new Error(j.error || 'Eroare'); e.http = r.status; throw e }
      return j;
    } catch (e) { clearTimeout(t); if (e.http || i === 1) throw e }
  }
}
api('/api/config').then(function (c) { WA = c.wa || WA }).catch(function () {});

/* ---------- selecturi manuale (populate din API) ---------- */
var sMk = $('sMk'), sMo = $('sMo'), sGe = $('sGe'), sYr = $('sYr'), sEn = $('sEn'), sEcu = $('sEcu');
function fill(sel, ph, items, val, txt) {
  sel.innerHTML = '<option value="">' + ph + '</option>' + items.map(function (x) { return '<option value="' + esc(val(x)) + '">' + esc(txt(x)) + '</option>' }).join('');
  sel.disabled = !items.length;
}
function clear(from) {
  var all = [[sMo, 'Model'], [sGe, 'Generație'], [sYr, 'An'], [sEn, 'Motorizare']];
  all.slice(from).forEach(function (a) { fill(a[0], a[1], [], String, String) });
  var k = ['mk', 'mo', 'ge', 'yr', 'en']; k.slice(from + 1).forEach(function (x) { st[x] = '' });
  st.d = null; sEcu.style.display = 'none'; $('dt').textContent = ''; render();
}
async function loadMakes() {
  try {
    var m = await api('/api/makes');
    fill(sMk, m.length ? 'Marcă' : 'Baza de date este momentan goală', m, function (x) { return x.id }, function (x) { return x.name });
    clear(0);
  } catch (e) { fill(sMk, 'Configuratorul manual este indisponibil momentan', [], String, String) }
}
async function onMk() { st.mk = sMk.value; clear(0); if (!st.mk) return; var m = await api('/api/models?make=' + st.mk); fill(sMo, 'Model', m, function (x) { return x.id }, function (x) { return x.name }) }
async function onMo() { st.mo = sMo.value; clear(1); if (!st.mo) return; st.gens = await api('/api/generations?model=' + st.mo); fill(sGe, 'Generație', st.gens, function (x) { return x.id }, function (x) { return x.name + ' (' + x.year_from + '–' + x.year_to + ')' }) }
async function onGe() {
  st.ge = sGe.value; clear(2); if (!st.ge) return;
  var g = st.gens.filter(function (x) { return String(x.id) === st.ge })[0], ys = []; for (var y = g.year_to; y >= g.year_from; y--) ys.push(y);
  fill(sYr, 'An', ys, String, String);
}
async function onYr() {
  st.yr = sYr.value; clear(3); if (!st.yr) return;
  var e = await api('/api/engines?generation=' + st.ge + '&year=' + st.yr);
  fill(sEn, 'Motorizare', e, function (x) { return x.id }, function (x) { return [x.name, x.fuel, x.stock_hp ? Math.round(x.stock_hp) + ' CP' : '', x.engine_code].filter(Boolean).join(' · ') });
}
async function onEn() {
  st.en = sEn.value; st.d = null; sEcu.style.display = 'none'; $('dt').textContent = ''; if (!st.en) return render();
  try { st.d = await api('/api/engine/' + st.en); } catch (e) { $('dt').textContent = 'Nu am putut încărca motorizarea. Încearcă din nou.'; return }
  var e = st.d.engine; $('dt').textContent = ['Combustibil: ' + (e.fuel || '—'), 'Putere: ' + (e.stock_hp ? Math.round(e.stock_hp) + ' CP' : '—'), 'Cod motor: ' + (e.engine_code || 'Informația nu este disponibilă'), 'ECU: ' + (st.d.ecus.length ? '' : 'Informația nu este disponibilă')].join(' · ');
  if (st.d.ecus.length) { fill(sEcu, 'ECU (alege)', st.d.ecus, function (x) { return (x.manufacturer + ' ' + x.ecu_model).trim() }, function (x) { return (x.manufacturer + ' ' + x.ecu_model).trim() }); sEcu.style.display = 'block'; if (st.d.ecus.length === 1) sEcu.selectedIndex = 1 }
  render();
}
sMk.onchange = function () { onMk().catch(netErr) }; sMo.onchange = function () { onMo().catch(netErr) }; sGe.onchange = function () { onGe().catch(netErr) }; sYr.onchange = function () { onYr().catch(netErr) }; sEn.onchange = onEn;
function netErr() { $('dt').textContent = 'Conexiunea a eșuat. Încearcă din nou.' }
/* schimbare manuală = VIN-ul nu mai descrie configurația */
[sMk, sMo, sGe, sYr, sEn].forEach(function (s) { s.addEventListener('change', function (ev) { if (ev.isTrusted) { st.vin = ''; st.vtext = '' } }) });

/* ---------- rezultate: stock / Stage 1 / Stage 2 / grafic / preț ---------- */
function bars(title, rows) {
  var mx = Math.max.apply(null, rows.map(function (r) { return r.v })) || 1;
  return '<h4 style="margin:14px 0 4px;font:700 13px \'League Spartan\';letter-spacing:.14em;opacity:.7">' + title + '</h4>' + rows.map(function (r) { return '<div class="br' + (r.s ? ' s' : '') + '"><span>' + r.l + '</span><div class="tr"><i data-w="' + Math.round(r.v / mx * 100) + '"></i></div><b>' + r.t + '</b></div>' }).join('');
}
function stageCard(n, e, t) {
  if (!t.available) return '<div class="card"><h4>STAGE ' + n + '</h4><p>' + (n === 1 ? 'Nu există încă o calibrare pentru această configurație în baza noastră de tuning.' : 'Stage 2 – verificare personalizată necesară.') + '</p><a class="btn" data-q="Verificare personalizată Stage ' + n + '">CERE VERIFICARE PERSONALIZATĂ</a></div>';
  return '<div class="card"><h4>STAGE ' + n + '</h4><span class="lb' + (t.verified ? ' ok' : '') + '">' + esc(t.label) + '</span><div class="est"><span>Putere stock</span><b>' + Math.round(e.stock_hp) + ' CP</b><span>Putere estimată</span><b>' + range(t.hp.map(Math.round)) + ' CP</b><span>Creștere</span><b>+' + range(t.gain_hp) + ' CP</b>' +
    (e.stock_nm ? '<span>Cuplu stock</span><b>' + Math.round(e.stock_nm) + ' Nm</b>' : '') + (t.nm ? '<span>Cuplu estimat</span><b>' + range(t.nm.map(Math.round)) + ' Nm</b><span>Creștere</span><b>+' + range(t.gain_nm) + ' Nm</b>' : '') +
    (n === 2 ? '<span>Hardware necesar</span><b>' + esc(t.hardware || 'De confirmat') + '</b>' : '') + '</div><div class="meta"><span class="price">' + eur(t.price_eur) + '</span></div>' + (t.notes ? '<p class="note" style="margin:0">' + esc(t.notes) + '</p>' : '') + '<a class="btn p" data-q="Stage ' + n + '">SOLICITĂ OFERTĂ</a></div>';
}
function cfgStr() {
  if (!st.d) return st.vtext || '—'; var e = st.d.engine;
  return [e.make, e.model, st.yr || '', e.name, e.engine_code].filter(Boolean).join(' → ');
}
function render() {
  var o = $('out'); $('cs').textContent = cfgStr();
  if (!st.d) { if (!st.vtext) o.innerHTML = '<div class="warn">Identifică mașina după VIN sau alege-o manual ca să vezi stock, Stage 1, Stage 2 și prețurile.</div>'; return }
  var e = st.d.engine, t = st.d.tuning, pw = [{ l: 'STOCK', v: e.stock_hp, t: Math.round(e.stock_hp) + ' CP', s: 1 }], tq = e.stock_nm ? [{ l: 'STOCK', v: e.stock_nm, t: Math.round(e.stock_nm) + ' Nm', s: 1 }] : [];
  [1, 2].forEach(function (n) { if (t[n].available) { pw.push({ l: 'STAGE ' + n, v: t[n].hp[1], t: range(t[n].hp.map(Math.round)) + ' CP' }); if (t[n].nm && tq.length) tq.push({ l: 'STAGE ' + n, v: t[n].nm[1], t: range(t[n].nm.map(Math.round)) + ' Nm' }) } });
  var h = '';
  if (!t[1].available && !t[2].available) h += '<div class="warn" style="margin-bottom:12px">Vehicul identificat, dar această configurație nu există încă în baza noastră de tuning. Solicită o verificare personalizată.<br><br><a class="btn p" data-q="Verificare personalizată">CERE VERIFICARE PERSONALIZATĂ</a></div>';
  h += '<div class="res">' + stageCard(1, e, t[1]) + stageCard(2, e, t[2]) + '</div>';
  if (pw.length > 1) h += bars('PUTERE', pw) + (tq.length > 1 ? bars('CUPLU', tq) : '');
  h += '<h4 style="margin:18px 0 8px;font:700 13px \'League Spartan\';letter-spacing:.14em;opacity:.7">PREȚURI & ALTE SERVICII</h4><div class="tabs" id="tabs"></div><div class="res" id="svcs"></div>';
  o.innerHTML = h; svcTabs(); requestAnimationFrame(function () { setTimeout(function () { [].forEach.call(o.querySelectorAll('.tr i'), function (i) { i.style.width = i.dataset.w + '%' }) }, 60) });
}
var CAT = { sw: 'Software / ECU', dg: 'Antipoluare & diagnoză', el: 'Electrică & electronică' };
function svcTabs() {
  var T = $('tabs'), R = $('svcs'); if (!T) return;
  T.innerHTML = Object.keys(CAT).map(function (k) { return '<button class="tab' + (st.tab === k ? ' on' : '') + '" data-t="' + k + '">' + CAT[k] + '</button>' }).join('');
  R.innerHTML = (st.tab === 'dg' ? '<p class="note" style="grid-column:1/-1;margin:0">Intervențiile asupra sistemelor de emisii sunt efectuate numai în limitele legislației aplicabile și în funcție de destinația și configurația vehiculului.</p>' : '') +
    st.svc.filter(function (s) { return s.cat === st.tab }).map(function (s) { return '<div class="card"><h4>' + esc(s.name) + '</h4><p>' + esc(s.description) + '</p><div class="meta"><span class="price">' + eur(s.price_eur) + '</span><span>' + esc(s.time_est) + '</span></div><a class="btn p" data-q="' + esc(s.name) + '">CERE OFERTĂ</a></div>' }).join('');
}
api('/api/services').then(function (s) { st.svc = s; svcTabs() }).catch(function () {});
var CARDS = [['SOFTWARE ECU', 'Optimizare și calibrare software.', 'sw'], ['STAGE 1', 'Optimizare pentru utilizare daily/performance.', 'sw'], ['STAGE 2', 'Calibrare avansată pentru configurații compatibile.', 'sw'], ['DIAGNOZĂ', 'Identificarea problemelor software și electronice.', 'sw'], ['ELECTRICĂ AUTO', 'Diagnosticare și reparații electronice.', 'el'], ['SISTEME ANTIPOLUARE', 'Diagnoză și remedierea problemelor asociate sistemelor de emisii.', 'dg']];
$('cards').innerHTML = CARDS.map(function (c, i) { return '<div class="card sv in" data-g="2" data-tab="' + c[2] + '"><i>0' + (i + 1) + '</i><h3>' + c[0] + '</h3><p>' + c[1] + '</p></div>' }).join('');

/* ---------- VIN ---------- */
var VRE = /^[A-HJ-NPR-Z0-9]{17}$/;
function cv(v) { return String(v || '').replace(/\s+/g, '').toUpperCase() }
function vs(t, k) { var e = $('vs'); e.textContent = t; e.style.color = k === 'err' ? '#ff7a66' : k === 'ok' ? '#6be39a' : '' }
['vin', 'hv'].forEach(function (i) { $(i).addEventListener('input', function () { this.value = cv(this.value).slice(0, 17) }) });
function acts() { return '<div class="btns" style="margin-top:14px"><a class="btn" data-vm>CONFIGUREAZĂ MANUAL</a><a class="btn p" data-q="Verificare personalizată (VIN)">CERE VERIFICARE PERSONALIZATĂ</a></div>' }
var STAT = { identified: ['VEHICUL IDENTIFICAT ✓', 'ok'], partial: ['IDENTIFICAT PARȚIAL', 'mid'], needs_check: ['NECESITĂ VERIFICARE', 'mid'] };
function chip(k, v) { return '<span class="cf ' + (v === 'CONFIRMED' ? 'ok' : v === 'NOT AVAILABLE' ? '' : 'mid') + '">' + k + ': ' + v + '</span>' }
function vk(a) { return a.filter(function (x) { return x[1] }).map(function (x) { return '<div><span>' + x[0] + '</span><b>' + esc(x[1]) + '</b></div>' }).join('') }
var vbusy = false;
async function decode(raw) {
  var vin = cv(raw); $('vr2').innerHTML = ''; if (vbusy) return;
  if (vin.length !== 17 || !VRE.test(vin)) return vs('VIN-ul introdus nu este valid.' + (vin.length !== 17 ? ' Trebuie să aibă exact 17 caractere (acum: ' + vin.length + ').' : ' Literele I, O și Q nu apar în VIN.'), 'err');
  vbusy = true; $('vb').disabled = $('hb').disabled = true; vs('VIN detectat → Se verifică vehiculul...'); $('vin').value = vin;
  try {
    var j = await api('/api/vin', { method: 'POST', body: JSON.stringify({ vin: vin }) });
    if (j.status === 'unavailable') { vs(j.message, 'err'); $('vr2').innerHTML = acts(); return }
    if (j.status === 'not_found') { vs(j.message, 'err'); $('vr2').innerHTML = acts(); return }
    st.vin = vin; showVin(j);
  } catch (e) { vs(e.http === 400 ? 'VIN-ul introdus nu este valid.' : e.http === 429 ? e.message : 'Serviciul de identificare automată este momentan indisponibil. Poți continua configurarea manual.', 'err'); $('vr2').innerHTML = acts() }
  finally { vbusy = false; $('vb').disabled = $('hb').disabled = false }
}
async function showVin(j) {
  var v = j.vehicle, s = STAT[j.status], c = j.confidence;
  vs('VIN detectat → ' + s[0], j.status === 'identified' ? 'ok' : '');
  st.vtext = [v.make, v.model, v.year, v.trim, v.displacement ? v.displacement + 'L' : '', v.fuel].filter(Boolean).join(' ');
  var miss = !v.engine_code || !v.hp || !v.nm;
  var h = '<div class="card" style="margin-top:14px"><span class="lb' + (s[1] === 'ok' ? ' ok' : '') + '">' + s[0] + '</span><div class="vt">' + esc([v.make, v.model, v.trim].filter(Boolean).join(' ')) + '</div><p style="font-size:19px;font-weight:300;opacity:.9">' +
    esc([v.year, [v.displacement ? v.displacement + 'L' : '', v.fuel].filter(Boolean).join(' '), v.hp ? Math.round(v.hp) + ' CP' : '', v.nm ? v.nm + ' Nm' : ''].filter(Boolean).join(' · ')) + '</p><p class="note" style="margin:6px 0">VIN: <code>' + esc(j.vin_masked) + '</code></p>' +
    '<div class="vk">' + vk([['Generație', v.generation], ['Cod motor', v.engine_code], ['Cilindree', v.displacement ? v.displacement + ' L' : ''], ['Combustibil', v.fuel], ['Transmisie', v.transmission], ['Tracțiune', v.drive], ['Caroserie', v.body], ['Fabrică', v.factory], ['Țară producție', v.country]]) + '</div>' +
    '<div>' + Object.keys(c).map(function (k) { return chip(k.replace('_', ' ').toUpperCase(), c[k]) }).join('') + '</div>' +
    '<p class="note">Sursă: ' + esc(Object.keys(j.sources || {}).map(function (k) { return j.sources[k] }).filter(function (x, i, a) { return a.indexOf(x) === i }).join(', ') || '—') + (j.cached ? ' · din cache' + (j.stale ? ' (date mai vechi — sursa nu a răspuns)' : '') : '') + ' · actualizat ' + esc((j.last_updated || '').slice(0, 10)) + '</p>' +
    (miss ? '<p class="note" style="opacity:.9">Informația nu este disponibilă prin VIN pentru unele câmpuri. Poate fi introdusă manual pentru o verificare mai exactă.</p>' : '') +
    (j.message ? '<p style="margin:10px 0;font-size:18px">' + esc(j.message) + '</p>' : '') + (j.status === 'needs_check' ? '<div class="btns"><a class="btn p" data-q="Verificare personalizată (VIN)">CERE VERIFICARE PERSONALIZATĂ</a></div>' : '') + '</div>';
  $('vr2').innerHTML = h;
  if (j.match && j.match.manufacturer_id) await applyMatch(j.match);
  render();
}
async function applyMatch(m) {
  try {
    sMk.value = m.manufacturer_id; await onMk(); if (!m.model_id) return; sMo.value = m.model_id; await onMo(); if (!m.generation_id) return;
    sGe.value = m.generation_id; await onGe(); if (!m.year) return; sYr.value = m.year; await onYr(); if (!m.engine_id) return;
    sEn.value = m.engine_id; await onEn();
  } catch (e) { netErr() }
}
$('vb').onclick = function () { decode($('vin').value) };
$('vin').addEventListener('keydown', function (e) { if (e.key === 'Enter') decode(this.value) });
$('hv').addEventListener('keydown', function (e) { if (e.key === 'Enter') runHero() });
function runHero() { $('vin').value = cv($('hv').value).slice(0, 17); go(2); setTimeout(function () { decode($('vin').value) }, 800) }
$('hb').onclick = runHero; $('hm').onclick = function () { go(2); setTimeout(function () { sMk.scrollIntoView({ behavior: 'smooth', block: 'center' }) }, 800) };
loadMakes();

/* ---------- cerere ofertă + WhatsApp ---------- */
var qs = '';
function waText(svc) { var e = st.d && st.d.engine, car = e ? [e.make, e.model, st.yr, e.name].filter(Boolean).join(' ') : st.vtext; return 'Salut! Doresc o ofertă' + (car ? ' pentru ' + car + (st.vin ? ', identificat prin VIN' : '') : '') + '.' + (svc ? ' Mă interesează ' + svc + '.' : '') }
function waUrl(svc) { return 'https://wa.me/' + WA + '?text=' + encodeURIComponent(waText(svc)) }
function openQ(s) { qs = s; $('qs').textContent = (cfgStr() !== '—' ? cfgStr() + ' · ' : '') + s; $('qe').textContent = ''; $('qm').classList.add('show') }
$('cq').onclick = function () { openQ('Ofertă personalizată') };
function readB64(f) { return new Promise(function (ok, no) { var r = new FileReader(); r.onload = function () { ok({ name: f.name, data: String(r.result).split(',')[1] }) }; r.onerror = no; r.readAsDataURL(f) }) }
$('qf').addEventListener('submit', async function (ev) {
  ev.preventDefault(); var f = this, el = f.elements, qe = $('qe'), b = $('qb'); qe.textContent = '';
  if (!f.checkValidity()) return f.reportValidity();
  var fl = [].slice.call(el.files.files); if (fl.length > 3) return qe.textContent = 'Maxim 3 fișiere.'; if (fl.some(function (x) { return x.size > 4 * 1024 * 1024 })) return qe.textContent = 'Fiecare fișier poate avea maxim 4 MB.';
  b.disabled = true; b.textContent = 'Se trimite...';
  try {
    var files = await Promise.all(fl.map(readB64));
    await api('/api/quotes', { method: 'POST', body: JSON.stringify({ name: el.name.value, phone: el.phone.value, whatsapp: el.whatsapp.value, email: el.email.value, km: el.km.value, city: el.city.value, mods: el.mods.value, message: el.message.value, service: qs, engine_id: st.en || null, ecu: sEcu.value, vin: st.vin, vehicle_text: st.vtext || '', files: files }) });
    f.reset(); $('qm').classList.remove('show'); showPop(); window.open(waUrl(qs), '_blank');
  } catch (e) { qe.textContent = e.http ? e.message : 'Nu am putut trimite cererea. Verifică conexiunea sau scrie-ne pe WhatsApp.' }
  finally { b.disabled = false; b.textContent = 'TRIMITE CEREREA' }
});
document.addEventListener('click', function (ev) {
  var t = ev.target.closest('[data-q],[data-wa],[data-x],[data-t],[data-g],[data-vm]'); if (!t) return;
  if (t.dataset.x !== undefined) t.closest('.mod').classList.remove('show');
  else if (t.dataset.vm !== undefined) sMk.scrollIntoView({ behavior: 'smooth', block: 'center' });
  else if (t.dataset.q) openQ(t.dataset.q);
  else if (t.dataset.wa !== undefined) window.open(waUrl(''), '_blank');
  else if (t.dataset.t) { st.tab = t.dataset.t; svcTabs() }
  else if (t.dataset.g) { if (t.dataset.tab) st.tab = t.dataset.tab; go(+t.dataset.g) }
});
var pop = $('pop'), popT; function hidePop() { clearTimeout(popT); pop.classList.remove('show') }
function showPop() { clearTimeout(popT); pop.classList.remove('show'); void pop.offsetWidth; pop.classList.add('show'); popT = setTimeout(hidePop, 5000) }
pop.addEventListener('click', hidePop); $('yr').textContent = new Date().getFullYear();

/* ---------- animații (din index (3).html) ---------- */
var slides = [].slice.call(document.querySelectorAll('.slide')), n = slides.length, cur = 0, busy = false, pb = $('pb');
function ins(sl) { return [].slice.call(sl.querySelectorAll('.in')) }
function loops(sl) {
  sl.querySelectorAll('.float').forEach(function (e) { gsap.to(e, { y: -16, duration: 2.8, ease: 'sine.inOut', yoyo: true, repeat: -1 }) });
  sl.querySelectorAll('.float2').forEach(function (e) { gsap.to(e, { y: 12, rotate: 2, duration: 3.4, ease: 'sine.inOut', yoyo: true, repeat: -1 }) });
  sl.querySelectorAll('.drift').forEach(function (e) { gsap.to(e, { x: 40, duration: 7, ease: 'sine.inOut', yoyo: true, repeat: -1 }) });
  sl.querySelectorAll('.spin').forEach(function (e) { gsap.to(e, { rotate: 360, duration: 90, ease: 'none', repeat: -1 }) });
}
function enter(sl, first, dir) {
  dir = dir || 1; var tl = gsap.timeline(), H = innerHeight; sl.classList.add('active'); var sw = sl.querySelector('.sw'); if (sw) sw.scrollTop = 0;
  if (!first) tl.fromTo(sl, { clipPath: dir > 0 ? 'inset(100% 0 0 0)' : 'inset(0 0 100% 0)' }, { clipPath: 'inset(0% 0% 0% 0%)', duration: .55, ease: 'power3.inOut' }, 0);
  tl.fromTo(sl.querySelector('.bg'), { scale: 1.12 }, { scale: 1, duration: .75, ease: 'power3.out' }, 0);
  ins(sl).forEach(function (e, i) { tl.fromTo(e, { y: H * dir }, { y: 0, duration: .55, ease: 'sine.inOut' }, (first ? 0 : .14) + i * .03) });
  loops(sl); return tl;
}
function leave(sl, dir) { dir = dir || 1; var tl = gsap.timeline(), H = innerHeight; ins(sl).forEach(function (e) { tl.to(e, { y: -H * dir, duration: .45, ease: 'sine.inOut' }, 0) }); return tl }
function reset(sl) { gsap.killTweensOf(sl.querySelectorAll('*')); sl.classList.remove('active'); sl.style.clipPath = ''; gsap.set(sl.querySelectorAll('.bg,.in,.mx,.spin,.float,.float2,.drift'), { clearProps: 'transform,opacity' }) }
function mark() { gsap.to(pb, { height: ((cur + 1) / n * 100) + '%', duration: .45, ease: 'power2.out' }) }
function go(to, dir) {
  if (to < 0 || to >= n || busy || to === cur) return; busy = true; dir = dir || (to > cur ? 1 : -1);
  var out = slides[cur], inn = slides[to]; out.style.zIndex = 1; inn.style.zIndex = 2; leave(out, dir); var t = enter(inn, false, dir); cur = to; mark();
  t.eventCallback('onComplete', function () { reset(out); setTimeout(function () { busy = false }, 150) });
}
function step(d) { go(cur + d, d) }
addEventListener('mousemove', function (e) { var nx = e.clientX / innerWidth - .5, ny = e.clientY / innerHeight - .5; slides[cur].querySelectorAll('.mx').forEach(function (m) { var d = parseFloat(m.dataset.d) || 1; gsap.to(m, { x: -nx * d * 18, y: -ny * d * 18, duration: 3, ease: 'power3.out', overwrite: 'auto' }) }) });
$('next').onclick = function () { step(1) }; $('prev').onclick = function () { step(-1) };
function inner(d) { var w = slides[cur].querySelector('.sw'); if (!w) return false; var max = w.scrollHeight - w.clientHeight; if (max < 4) return false; return d > 0 ? w.scrollTop < max - 2 : w.scrollTop > 2 }
function modal() { return document.querySelector('.mod.show') }
addEventListener('wheel', function (e) { if (busy || modal() || Math.abs(e.deltaY) < 8) return; var d = e.deltaY > 0 ? 1 : -1; if (inner(d)) return; step(d) }, { passive: true });
addEventListener('keydown', function (e) { if (modal() || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return; if (/Arrow(Down|Right)|PageDown/.test(e.key)) step(1); if (/Arrow(Up|Left)|PageUp/.test(e.key)) step(-1) });
var ty = 0; addEventListener('touchstart', function (e) { ty = e.touches[0].clientY }, { passive: true });
addEventListener('touchend', function (e) { if (modal()) return; var d = ty - e.changedTouches[0].clientY; if (Math.abs(d) > 60 && !inner(d > 0 ? 1 : -1)) step(d > 0 ? 1 : -1) }, { passive: true });
slides.forEach(function (s, i) { s.style.zIndex = i ? 1 : 2 });
enter(slides[0], true); mark();
})();
