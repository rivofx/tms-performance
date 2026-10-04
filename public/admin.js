(function () {
'use strict';
var $ = function (i) { return document.getElementById(i) }, A = $('app'), csrf = '', tab = 'dash', STS = [];
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] }) }
async function api(m, p, b) {
  var r = await fetch(p, { method: m, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: b ? JSON.stringify(b) : undefined, credentials: 'same-origin' });
  var j = await r.json().catch(function () { return {} }); if (!r.ok) { var e = new Error(j.error || 'Eroare'); e.http = r.status; throw e } return j;
}
function login(msg) {
  A.innerHTML = '<h1>Admin <span class="ac">TMS Performance</span></h1><form id="lf" class="card col" style="max-width:380px"><input name="u" placeholder="Utilizator" autocomplete="username" required><input name="p" type="password" placeholder="Parolă" autocomplete="current-password" required><div class="note" style="color:#ff7a66;opacity:1">' + esc(msg || '') + '</div><button class="btn p">AUTENTIFICARE</button></form>';
  $('lf').onsubmit = async function (e) { e.preventDefault(); try { var j = await api('POST', '/api/admin/login', { username: this.u.value, password: this.p.value }); csrf = j.csrf; init() } catch (x) { login(x.message) } };
}
async function init() {
  try { var me = await api('GET', '/api/admin/me'); csrf = me.csrf; STS = (await fetch('/api/config').then(function (r) { return r.json() })).statuses; draw() } catch (e) { login() }
}
var TABS = [['dash', 'Dashboard'], ['req', 'Cereri'], ['veh', 'Vehicule & Tuning'], ['imp', 'Import'], ['svc', 'Servicii & prețuri'], ['sys', 'Sistem']];
async function draw(msg) {
  var h = '<h1>Admin</h1><div class="tabs">' + TABS.map(function (t) { return '<button class="tab' + (tab === t[0] ? ' on' : '') + '" data-tab="' + t[0] + '">' + t[1] + '</button>' }).join('') + '<button class="tab" id="lo">Ieșire</button></div>' + (msg ? '<div class="card">' + esc(msg) + '</div>' : '') + '<div id="body">Se încarcă...</div>';
  A.innerHTML = h; $('lo').onclick = async function () { await api('POST', '/api/admin/logout'); login() };
  [].forEach.call(A.querySelectorAll('[data-tab]'), function (b) { b.onclick = function () { tab = b.dataset.tab; draw() } });
  try { $('body').innerHTML = await VIEW[tab](); BIND[tab] && BIND[tab]() } catch (e) { if (e.http === 401) login('Sesiune expirată.'); else $('body').innerHTML = '<div class="card">Eroare: ' + esc(e.message) + '</div>' }
}
var FIELDS = ['make', 'model', 'generation', 'year_from', 'year_to', 'engine', 'engine_code', 'fuel', 'displacement', 'aspiration', 'stock_hp', 'stock_nm', 'ecu', 'stage1_min_hp', 'stage1_max_hp', 'stage1_min_nm', 'stage1_max_nm', 'stage1_price', 'stage2_min_hp', 'stage2_max_hp', 'stage2_min_nm', 'stage2_max_nm', 'stage2_price', 'stage2_hardware', 'verified', 'notes'];
var VIEW = {
  dash: async function () { var s = await api('GET', '/api/admin/stats'), c = s.counts;
    return '<div class="kp">' + [['requests', 'cereri'], ['engines', 'motorizări'], ['tuning', 'valori tuning'], ['vin_cache', 'VIN-uri în cache'], ['manufacturers', 'mărci'], ['models', 'modele']].map(function (k) { return '<div class="card"><b>' + c[k[0]] + '</b><br>' + k[1] + '</div>' }).join('') + '</div><h3 class="lbl">CERERI PE STATUS</h3>' + (s.byStatus.map(function (x) { return '<div>' + esc(x.status) + ': <b>' + x.c + '</b></div>' }).join('') || '<small>Nicio cerere.</small>') + '<h3 class="lbl" style="margin-top:18px">SERVICII CELE MAI SOLICITATE</h3>' + (s.topServices.map(function (x) { return '<div>' + esc(x.service) + ': <b>' + x.c + '</b></div>' }).join('') || '<small>—</small>') },
  req: async function () { var L = await api('GET', '/api/admin/requests');
    return L.map(function (r) { var v = r.vehicle, car = v.make ? [v.make, v.model, v.generation, v.engine, v.code, v.ecu].filter(Boolean).join(' · ') : v.text || '—';
      return '<div class="card rq"><b>#' + r.id + ' ' + esc(r.name) + '</b> · <a style="color:var(--a)" href="tel:' + esc(r.phone) + '">' + esc(r.phone) + '</a> · ' + esc(r.email || '') + ' · ' + esc(r.created.slice(0, 16).replace('T', ' ')) + '<br>' + esc(car) + ' · <b>' + esc(r.service) + '</b>' +
        (r.has_vin ? '<br>VIN: <span id="v' + r.id + '">' + esc(r.vin) + '</span> <a style="color:var(--a);cursor:pointer" data-vin="' + r.id + '">arată</a>' : '') + '<br><small>' + esc([r.city, r.km && r.km + ' km', r.mods, r.message, r.whatsapp && 'WA: ' + r.whatsapp].filter(Boolean).join(' | ')) + '</small>' +
        (r.files.length ? '<br>' + r.files.map(function (f) { return '<a style="color:var(--a)" href="/api/admin/files/' + esc(f.file) + '">' + esc(f.name) + '</a>' }).join(' · ') : '') +
        '<br><select data-rid="' + r.id + '">' + STS.map(function (s) { return '<option' + (s === r.status ? ' selected' : '') + '>' + esc(s) + '</option>' }).join('') + '</select></div>' }).join('') || '<div class="card">Nicio cerere încă.</div>' },
  veh: async function () {
    return '<div class="card"><h3 class="lbl">CAUTĂ MOTORIZARE (marcă, model, cod motor)</h3><div class="vr"><input id="eq" placeholder="ex: bmw, B47"><button class="btn" id="es">Caută</button></div><div id="el"></div></div>' +
      '<div class="card"><h3 class="lbl">ADAUGĂ / ACTUALIZEAZĂ O CONFIGURAȚIE (aceleași coloane ca la import)</h3><div class="row2" style="grid-template-columns:repeat(auto-fill,minmax(170px,1fr))">' + FIELDS.map(function (f) { return '<input data-f="' + f + '" placeholder="' + f + (['make', 'model', 'generation', 'year_from', 'year_to', 'engine', 'fuel', 'stock_hp'].indexOf(f) >= 0 ? ' *' : '') + '">' }).join('') + '</div><button class="btn p" id="ea" style="margin-top:10px">Salvează</button></div>' },
  imp: async function () { return '<div class="card"><h3 class="lbl">IMPORT CSV / JSON</h3><p class="note">Coloane: make, model, generation, year_from, year_to (sau year), engine, engine_code, fuel, stock_hp, stock_nm, ecu, stage1_min_hp, stage1_max_hp, stage1_min_nm, stage1_max_nm, stage1_price, stage2_* , stage2_hardware, verified, notes. Fișierul este validat înainte de import; dacă are erori, nu se importă nimic.</p><input type="file" id="if" accept=".csv,.json,text/csv,application/json"><div class="btns" style="margin:10px 0"><button class="btn" id="iv">1. Validează</button><button class="btn p" id="ii">2. Importă</button></div><pre id="ir" style="white-space:pre-wrap;font-size:14px"></pre></div>' +
    '<div class="card"><h3 class="lbl">SINCRONIZARE MODELE DIN NHTSA (gratuit)</h3><p class="note">Aduce mărcile și modelele din NHTSA vPIC (acoperă mai ales piața SUA). Nu aduce generații, motoare sau valori de tuning — acestea se importă separat.</p><input id="sm" placeholder="Mărci separate prin virgulă (max. 10), ex: BMW, Audi"><button class="btn" id="ss" style="margin-top:10px">Sincronizează</button><pre id="sr" style="white-space:pre-wrap;font-size:14px"></pre></div>' },
  svc: async function () { var L = await api('GET', '/api/admin/services');
    return '<div class="card"><p class="note">Prețuri în EUR. Gol = „Solicită ofertă". Prețurile Stage 1 / Stage 2 se setează per motorizare, la Vehicule & Tuning sau prin import.</p>' + L.map(function (s) { return '<div class="rq" style="display:flex;gap:10px;justify-content:space-between;flex-wrap:wrap;align-items:center;margin:6px 0"><span>' + esc(s.name) + ' <small>(' + s.cat + ')</small></span><span><input type="number" style="width:110px;padding:8px 14px" data-sp="' + s.key + '" value="' + (s.price_eur == null ? '' : s.price_eur) + '"> € <label><input type="checkbox" style="width:auto" data-sa="' + s.key + '"' + (s.active ? ' checked' : '') + '> activ</label> <button class="btn" data-ss="' + s.key + '" style="padding:8px 16px">Salvează</button></span></div>' }).join('') + '</div>' },
  sys: async function () { return '<div class="card"><p>Backup-ul bazei de date se face automat zilnic în <code>data/backups</code> (se păstrează 14). Poți porni unul acum:</p><button class="btn p" id="bk">Backup acum</button></div>' }
};
var BIND = {
  req: function () {
    [].forEach.call(A.querySelectorAll('[data-vin]'), function (a) { a.onclick = async function () { var j = await api('GET', '/api/admin/requests/' + a.dataset.vin + '/vin'); $('v' + a.dataset.vin).textContent = j.vin; a.remove() } });
    [].forEach.call(A.querySelectorAll('[data-rid]'), function (s) { s.onchange = function () { api('PATCH', '/api/admin/requests/' + s.dataset.rid, { status: s.value }).catch(function (e) { alert(e.message) }) } });
  },
  veh: function () {
    $('es').onclick = async function () {
      var L = await api('GET', '/api/admin/engines?q=' + encodeURIComponent($('eq').value));
      $('el').innerHTML = L.map(function (e) { var t = {}; e.tuning.forEach(function (x) { t[x.stage] = x });
        function row(n) { var x = t[n] || {}; return '<div class="row2" data-e="' + e.id + '" data-s="' + n + '" style="grid-template-columns:repeat(auto-fill,minmax(90px,1fr))"><b>Stage ' + n + '</b>' + ['min_hp', 'max_hp', 'min_nm', 'max_nm', 'price_eur'].map(function (k) { return '<input data-k="' + k + '" placeholder="' + k + '" value="' + (x[k] == null ? '' : x[k]) + '">' }).join('') + '<input data-k="hardware" placeholder="hardware" value="' + esc(x.hardware || '') + '"><label><input type="checkbox" style="width:auto" data-k="available"' + (x.available !== 0 ? ' checked' : '') + '> disponibil</label><label><input type="checkbox" style="width:auto" data-k="verified"' + (x.verified ? ' checked' : '') + '> verificat</label><button class="btn" data-save style="padding:8px 14px">Salvează</button></div>' }
        return '<div class="rq" style="margin:10px 0"><b>' + esc([e.make, e.model, e.gen, e.name, e.engine_code].join(' · ')) + '</b> <small>' + esc(e.fuel) + ' · ' + e.stock_hp + ' CP · ' + (e.stock_nm || '—') + ' Nm</small>' + row(1) + row(2) + '<button class="btn" data-del="' + e.id + '" style="padding:6px 14px">Șterge motorizarea</button></div>' }).join('') || '<small>Niciun rezultat.</small>';
      [].forEach.call($('el').querySelectorAll('[data-save]'), function (b) { b.onclick = async function () { var r = b.parentNode, o = { engine_id: +r.dataset.e, stage: +r.dataset.s }; [].forEach.call(r.querySelectorAll('[data-k]'), function (i) { o[i.dataset.k] = i.type === 'checkbox' ? i.checked : i.value }); try { await api('PUT', '/api/admin/tuning', o); b.textContent = 'Salvat ✓' } catch (e) { alert(e.message) } } });
      [].forEach.call($('el').querySelectorAll('[data-del]'), function (b) { b.onclick = async function () { if (confirm('Ștergi motorizarea și tuning-ul asociat?')) { await api('DELETE', '/api/admin/engines/' + b.dataset.del); $('es').click() } } });
    };
    $('ea').onclick = async function () { var o = {}; [].forEach.call(A.querySelectorAll('[data-f]'), function (i) { o[i.dataset.f] = i.value.trim() }); try { await api('POST', '/api/admin/vehicle', o); draw('Configurația a fost salvată.') } catch (e) { alert(e.message) } };
  },
  imp: function () {
    var txt = '', fmt = 'csv';
    $('if').onchange = function () { var f = this.files[0]; if (!f) return; fmt = /\.json$/i.test(f.name) ? 'json' : 'csv'; var r = new FileReader(); r.onload = function () { txt = r.result; $('ir').textContent = f.name + ' încărcat. Apasă „Validează".' }; r.readAsText(f) };
    async function go(dry) { if (!txt) return alert('Alege un fișier.'); try { var j = await api('POST', '/api/admin/import', { format: fmt, data: txt, dry: dry }); $('ir').textContent = j.ok ? (dry ? '✓ Fișier valid: ' + j.rows + ' rânduri. Poți importa.' : '✓ Importate: ' + j.imported + ' rânduri.') : '✗ ' + j.invalid + ' rânduri invalide din ' + j.rows + ':\n' + j.errors.map(function (e) { return 'Rând ' + e.row + ': ' + e.errors.join('; ') }).join('\n') } catch (e) { $('ir').textContent = '✗ ' + e.message } }
    $('iv').onclick = function () { go(true) }; $('ii').onclick = function () { go(false) };
    $('ss').onclick = async function () { try { var j = await api('POST', '/api/admin/sync/nhtsa', { makes: $('sm').value.split(',').map(function (x) { return x.trim() }).filter(Boolean) }); $('sr').textContent = j.results.map(function (r) { return r.make + ': ' + (r.error || r.models + ' modele') }).join('\n') + '\n' + j.note } catch (e) { $('sr').textContent = e.message } };
  },
  svc: function () {
    [].forEach.call(A.querySelectorAll('[data-ss]'), function (b) { b.onclick = async function () { var k = b.dataset.ss; try { await api('PATCH', '/api/admin/services/' + k, { price_eur: A.querySelector('[data-sp="' + k + '"]').value, active: A.querySelector('[data-sa="' + k + '"]').checked }); b.textContent = 'Salvat ✓' } catch (e) { alert(e.message) } } });
  },
  sys: function () { $('bk').onclick = async function () { try { var j = await api('POST', '/api/admin/backup'); draw('Backup creat: ' + j.file) } catch (e) { alert(e.message) } } }
};
init();
})();
