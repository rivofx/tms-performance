'use strict';
/* TMS Performance — VIN + Tuning configurator. Node >= 22.5, fără dependențe externe. */
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const E = process.env, PROD = E.NODE_ENV === 'production';
const PORT = Number(E.PORT || 10000);
const ROOT = __dirname, PUB = path.join(ROOT, 'public'), DATA = path.resolve(E.DATA_DIR || path.join(ROOT, 'data'));
const UP = path.join(DATA, 'uploads'), BK = path.join(DATA, 'backups');
fs.mkdirSync(UP, { recursive: true }); fs.mkdirSync(BK, { recursive: true });
if (PROD && !E.SESSION_SECRET) throw new Error('SESSION_SECRET este obligatoriu în producție');
const SECRET = E.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const NHTSA = E.NHTSA_BASE || 'https://vpic.nhtsa.dot.gov/api';
const STATUSES = ['Nouă', 'În verificare', 'Contactat', 'Ofertă trimisă', 'Acceptată', 'Finalizată', 'Respinsă'];

/* ---------- log (niciodată VIN-uri / date personale) ---------- */
function log(level, msg, o) { const l = JSON.stringify({ t: new Date().toISOString(), level, msg, ...o }); try { fs.appendFileSync(path.join(DATA, 'app.log'), l + '\n') } catch {} if (!E.QUIET) console.log(l) }

/* ---------- DB ---------- */
const db = new DatabaseSync(path.join(DATA, E.DB_FILE || 'app.db'));
db.exec(`PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS manufacturers(id INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE COLLATE NOCASE,country TEXT DEFAULT '',source TEXT DEFAULT 'manual',source_id TEXT DEFAULT '',last_updated TEXT);
CREATE TABLE IF NOT EXISTS models(id INTEGER PRIMARY KEY,manufacturer_id INTEGER NOT NULL REFERENCES manufacturers(id) ON DELETE CASCADE,name TEXT NOT NULL COLLATE NOCASE,source TEXT DEFAULT 'manual',source_id TEXT DEFAULT '',UNIQUE(manufacturer_id,name));
CREATE TABLE IF NOT EXISTS generations(id INTEGER PRIMARY KEY,model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,name TEXT NOT NULL COLLATE NOCASE,year_from INTEGER,year_to INTEGER,UNIQUE(model_id,name));
CREATE TABLE IF NOT EXISTS engines(id INTEGER PRIMARY KEY,generation_id INTEGER NOT NULL REFERENCES generations(id) ON DELETE CASCADE,name TEXT NOT NULL COLLATE NOCASE,engine_code TEXT NOT NULL DEFAULT '' COLLATE NOCASE,displacement REAL,fuel TEXT DEFAULT '',aspiration TEXT DEFAULT '',stock_hp REAL,stock_kw REAL,stock_nm REAL,source TEXT DEFAULT 'manual',source_id TEXT DEFAULT '',confidence TEXT DEFAULT 'MANUAL',last_updated TEXT,UNIQUE(generation_id,name,engine_code));
CREATE TABLE IF NOT EXISTS vehicle_ecus(id INTEGER PRIMARY KEY,engine_id INTEGER NOT NULL REFERENCES engines(id) ON DELETE CASCADE,manufacturer TEXT NOT NULL DEFAULT '',ecu_model TEXT NOT NULL,UNIQUE(engine_id,manufacturer,ecu_model));
CREATE TABLE IF NOT EXISTS tuning(id INTEGER PRIMARY KEY,engine_id INTEGER NOT NULL REFERENCES engines(id) ON DELETE CASCADE,stage INTEGER NOT NULL,ecu TEXT NOT NULL DEFAULT '',min_hp REAL,max_hp REAL,min_nm REAL,max_nm REAL,price_eur REAL,hardware TEXT DEFAULT '',available INTEGER DEFAULT 1,verified INTEGER DEFAULT 0,notes TEXT DEFAULT '',source TEXT DEFAULT 'manual',last_updated TEXT,UNIQUE(engine_id,stage,ecu));
CREATE TABLE IF NOT EXISTS services(key TEXT PRIMARY KEY,cat TEXT NOT NULL,name TEXT NOT NULL,description TEXT DEFAULT '',price_eur REAL,time_est TEXT DEFAULT '',active INTEGER DEFAULT 1,sort INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS vin_cache(vin TEXT PRIMARY KEY,vehicle TEXT NOT NULL,sources TEXT NOT NULL,fetched_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS requests(id INTEGER PRIMARY KEY,created TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'Nouă',name TEXT,phone TEXT,whatsapp TEXT,email TEXT,km TEXT,city TEXT,mods TEXT,message TEXT,service TEXT,vin TEXT,engine_id INTEGER,vehicle TEXT,files TEXT);
CREATE TABLE IF NOT EXISTS admins(id INTEGER PRIMARY KEY,username TEXT UNIQUE NOT NULL,salt TEXT NOT NULL,hash TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_models ON models(manufacturer_id);CREATE INDEX IF NOT EXISTS ix_gen ON generations(model_id);CREATE INDEX IF NOT EXISTS ix_eng ON engines(generation_id);CREATE INDEX IF NOT EXISTS ix_engcode ON engines(engine_code);`);
const all = (s, ...p) => db.prepare(s).all(...p), one = (s, ...p) => db.prepare(s).get(...p), run = (s, ...p) => db.prepare(s).run(...p);
function tx(fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r } catch (e) { db.exec('ROLLBACK'); throw e } }
const now = () => new Date().toISOString();

/* servicii (doar denumiri/descrieri; prețurile le setează adminul, implicit „Solicită ofertă") */
if (!one('SELECT 1 x FROM services')) {
  const S = [['custom', 'sw', 'Stage 3 / Custom Calibration', 'Calibrare personalizată pe baza hardware-ului montat.'], ['ecu_diag', 'sw', 'Diagnoză ECU', 'Citire și analiză parametri ECU.'], ['sw_opt', 'sw', 'Optimizare software', 'Optimizare pentru consum și răspuns.'], ['sw_fix', 'sw', 'Remediere software', 'Corectarea erorilor software.'], ['ecu_ad', 'sw', 'Adaptări și codări ECU', 'Adaptări după înlocuirea componentelor.'],
    ['dpf', 'dg', 'Diagnoză DPF', 'Analiză stare filtru și parametri.'], ['egr', 'dg', 'Diagnoză EGR', 'Verificare supapă, răcitor și comandă.'], ['scr', 'dg', 'Diagnoză AdBlue / SCR', 'Pompă, injector, senzori, dozare.'], ['nox', 'dg', 'Diagnoză senzori NOx', 'Test senzori și cablaj.'], ['regen', 'dg', 'Probleme regenerare', 'Identificarea cauzei regenerărilor eșuate.'], ['err', 'dg', 'Identificare cauză eroare', 'Analiza erorilor asociate sistemelor de emisii.'], ['post', 'dg', 'Remediere software după reparații', 'Adaptări și codări după intervenții.'],
    ['el_diag', 'el', 'Diagnoză electrică', 'Identificare defecte electrice.'], ['can', 'el', 'Diagnoză CAN-BUS', 'Comunicație între module.'], ['bcm', 'el', 'BCM / BSI / FRM / module', 'Diagnoză, programare și codare module.'], ['sens', 'el', 'Senzori', 'Diagnoză senzori și cablaj.'], ['code', 'el', 'Codări, programări, adaptări', 'Configurări după reparații sau înlocuiri.'], ['retro', 'el', 'Retrofit', 'Retrofit-uri electronice.']];
  S.forEach((s, i) => run('INSERT INTO services(key,cat,name,description,sort) VALUES(?,?,?,?,?)', ...s, i));
}

/* ---------- helpers ---------- */
class HttpError extends Error { constructor(c, m) { super(m); this.code = c } }
const bad = (m, c = 400) => { throw new HttpError(c, m) };
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const nk = s => norm(s).replace(/series|seria|serie|class|clasa/g, '');
const fuelKey = f => /diesel|dizel|motorina/i.test(f) ? 'diesel' : /gas|petrol|benz/i.test(f) ? 'petrol' : /electr/i.test(f) ? 'electric' : /hybrid|hibrid/i.test(f) ? 'hybrid' : norm(f);
const maskVin = v => v ? v.slice(0, 3) + '*'.repeat(11) + v.slice(-3) : '';
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;
const cleanVin = v => String(v || '').replace(/\s+/g, '').toUpperCase();
const n = v => v === '' || v == null ? null : (isFinite(+v) ? +v : null);
const str = (v, max = 200) => String(v == null ? '' : v).trim().slice(0, max);

const hits = new Map();
function allow(key, max, ms) { const t = Date.now(), a = (hits.get(key) || []).filter(x => t - x < ms); if (a.length >= max) { hits.set(key, a); return false } a.push(t); hits.set(key, a); return true }
setInterval(() => { const t = Date.now(); for (const [k, a] of hits) if (!a.some(x => t - x < 120000)) hits.delete(k) }, 60000).unref();

/* ---------- sesiuni admin (cookie semnat, HttpOnly, SameSite=Strict) ---------- */
const b64 = b => Buffer.from(b).toString('base64url'), hmac = s => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
const mkSess = u => { const p = b64(JSON.stringify({ u, exp: Date.now() + 8 * 3600e3, csrf: crypto.randomBytes(16).toString('hex') })); return { token: p + '.' + hmac(p), csrf: JSON.parse(Buffer.from(p, 'base64url')).csrf } };
function getSess(req) {
  const m = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie || ''); if (!m) return null; const [p, s] = m[1].split('.');
  if (!p || !s || s.length !== hmac(p).length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(hmac(p)))) return null;
  try { const o = JSON.parse(Buffer.from(p, 'base64url')); return o.exp > Date.now() ? o : null } catch { return null }
}
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
function addAdmin(u, pw) { const salt = crypto.randomBytes(16).toString('hex'); run('INSERT OR REPLACE INTO admins(username,salt,hash) VALUES(?,?,?)', u, salt, hashPw(pw, salt)) }
if (!one('SELECT 1 x FROM admins')) {
  if (E.ADMIN_USER && (E.ADMIN_PASSWORD || '').length >= 10) { addAdmin(E.ADMIN_USER, E.ADMIN_PASSWORD); log('info', 'admin creat') }
  else log('warn', 'Nu există niciun admin. Setează ADMIN_USER și ADMIN_PASSWORD (min. 10 caractere) și repornește.');
}

/* ---------- VIN providers ---------- */
async function fetchJson(url, opt = {}, ms = 6000) { const c = new AbortController(), t = setTimeout(() => c.abort(), ms); try { const r = await fetch(url, { ...opt, signal: c.signal }); if (!r.ok) throw new Error('http ' + r.status); return await r.json() } finally { clearTimeout(t) } }
async function retry(fn, tries = 2) { let err; for (let i = 0; i <= tries; i++) { try { return await fn() } catch (e) { err = e; if (i < tries) await new Promise(r => setTimeout(r, 300 * (i + 1))) } } throw err }
const gv = (o, k) => { const v = o && o[k]; const s = v == null ? '' : String(v).trim(); return /^(not applicable|null|undefined)$/i.test(s) ? '' : s };
const pos = v => { const x = parseFloat(v); return isFinite(x) && x > 0 ? x : null };
const PROVIDERS = {
  async nhtsa(vin) {
    const d = ((await fetchJson(`${NHTSA}/vehicles/DecodeVinValues/${vin}?format=json`)).Results || [])[0] || {};
    if (!gv(d, 'Make') || !gv(d, 'Model')) return null;
    const hp = pos(gv(d, 'EngineHP')), kw = pos(gv(d, 'EngineKW'));
    return { make: gv(d, 'Make'), model: gv(d, 'Model'), trim: gv(d, 'Trim') || gv(d, 'Series'), year: pos(gv(d, 'ModelYear')), displacement: pos(gv(d, 'DisplacementL')), fuel: gv(d, 'FuelTypePrimary'), hp: hp || (kw ? Math.round(kw * 1.341) : null), engine_code: gv(d, 'EngineModel'), transmission: gv(d, 'TransmissionStyle'), drive: gv(d, 'DriveType'), body: gv(d, 'BodyClass'), country: gv(d, 'PlantCountry'), factory: gv(d, 'PlantCompanyName') };
  },
  /* ATENȚIE: adaptor Auto.dev scris după documentație din memorie, NETESTAT cu cheie reală.
     Verifică formatul răspunsului în documentația Auto.dev și ajustează maparea dacă e nevoie. */
  async autodev(vin) {
    if (!E.AUTODEV_API_KEY) return null;
    const j = await fetchJson(`${E.AUTODEV_BASE || 'https://api.auto.dev'}/vin/${vin}`, { headers: { Authorization: 'Bearer ' + E.AUTODEV_API_KEY } });
    const v = j.vehicle || j, nm = x => (x && typeof x === 'object' ? x.name : x) || '';
    if (!nm(v.make) || !nm(v.model)) return null;
    const eng = v.engine || {};
    return { make: str(nm(v.make)), model: str(nm(v.model)), trim: str(v.trim || nm(v.style)), year: pos(v.year || (v.years && v.years[0] && v.years[0].year)), displacement: pos(eng.size || eng.displacement), fuel: str(eng.fuelType || eng.fuel_type || v.fuelType), hp: pos(eng.horsepower), engine_code: str(eng.code), transmission: str(nm(v.transmission)), drive: str(v.drivenWheels || v.drive), body: str(v.type || v.bodyType) };
  },
};
const EMPTY = x => x == null || x === '';
async function lookupProviders(vin) {
  const out = {}, src = {}, errs = [], used = [];
  for (const name of (E.VIN_PROVIDERS || 'nhtsa,autodev').split(',').map(s => s.trim()).filter(Boolean)) {
    const p = PROVIDERS[name]; if (!p) continue;
    try {
      const r = await retry(() => p(vin)); used.push(name);
      if (r) for (const k in r) if (EMPTY(out[k]) && !EMPTY(r[k])) { out[k] = r[k]; src[k] = name }
      if (out.make && out.model && out.year && out.fuel && out.hp) break; // complet: nu consumăm alte apeluri
    } catch (e) { errs.push(name); log('warn', 'provider eșuat', { provider: name, err: e.message }) }
  }
  return { vehicle: out, sources: src, errs, used };
}

/* ---------- potrivire în baza internă ---------- */
function matchDb(v) {
  const m = {}; if (!v.make) return m;
  const mfs = all('SELECT id,name FROM manufacturers'), k = norm(v.make);
  const mf = mfs.find(x => norm(x.name) === k) || mfs.find(x => k.startsWith(norm(x.name)) || (k.length > 2 && norm(x.name).startsWith(k))); if (!mf) return m;
  m.manufacturer_id = mf.id;
  const mk = nk(v.model), mo = mk && all('SELECT id,name FROM models WHERE manufacturer_id=?', mf.id).find(x => nk(x.name) === mk || nk(x.name) && mk.startsWith(nk(x.name))); if (!mo) return m;
  m.model_id = mo.id;
  const gens = all('SELECT * FROM generations WHERE model_id=?', mo.id), y = +v.year, gy = y ? gens.filter(g => y >= g.year_from && y <= g.year_to) : [];
  if (gy.length === 1) m.generation_id = gy[0].id; else if (gy.length > 1) { m.generation_candidates = gy.map(g => g.id); } else return m;
  if (y) m.year = y; if (!m.generation_id) return m;
  const es = all('SELECT * FROM engines WHERE generation_id=?', m.generation_id), code = norm(v.engine_code);
  let pick = code ? es.filter(e => norm(e.engine_code) === code) : [];
  if (pick.length !== 1 && v.hp && v.fuel) pick = es.filter(e => fuelKey(e.fuel) === fuelKey(v.fuel) && Math.abs((e.stock_hp || 0) - v.hp) <= 2 && (!v.displacement || !e.displacement || Math.abs(e.displacement - v.displacement) <= 0.1));
  if (pick.length === 1) m.engine_id = pick[0].id;
  return m;
}
function confidence(v, m, ecus) {
  const C = (x, y = 'CONFIRMED') => x ? y : 'NOT AVAILABLE';
  return { vin: 'CONFIRMED', make: C(v.make), model: C(v.model), year: C(v.year), engine: v.hp && v.fuel ? 'CONFIRMED' : m.engine_id ? 'NEEDS VERIFICATION' : 'NOT AVAILABLE', engine_code: C(v.engine_code), ecu: ecus ? 'NEEDS VERIFICATION' : 'NOT AVAILABLE' };
}
async function decodeVIN(raw) {
  const vin = cleanVin(raw); if (!VIN_RE.test(vin)) bad('VIN-ul introdus nu este valid.');
  const days = +E.VIN_CACHE_DAYS || 90, c = one('SELECT * FROM vin_cache WHERE vin=?', vin);
  let vehicle, sources, cached = false, stale = false, fetched = Date.now(), unavailable = false;
  if (c && Date.now() - c.fetched_at < days * 864e5) { vehicle = JSON.parse(c.vehicle); sources = JSON.parse(c.sources); cached = true; fetched = c.fetched_at }
  else {
    const r = await lookupProviders(vin);
    if (r.vehicle.make && r.vehicle.model) { vehicle = r.vehicle; sources = r.sources; run('INSERT OR REPLACE INTO vin_cache(vin,vehicle,sources,fetched_at) VALUES(?,?,?,?)', vin, JSON.stringify(vehicle), JSON.stringify(sources), Date.now()) }
    else if (c) { vehicle = JSON.parse(c.vehicle); sources = JSON.parse(c.sources); cached = stale = true; fetched = c.fetched_at }  // fallback pe cache vechi
    else unavailable = r.errs.length > 0 && !r.used.length;
  }
  const base = { vin_masked: maskVin(vin), cached, stale };
  if (!vehicle) return { ...base, status: unavailable ? 'unavailable' : 'not_found', message: unavailable ? 'Identificarea automată este temporar indisponibilă. Poți continua manual.' : 'Nu am putut identifica acest VIN. Verifică datele sau configurează mașina manual.' };
  const match = matchDb(vehicle), eng = match.engine_id && one('SELECT COUNT(*) c FROM vehicle_ecus WHERE engine_id=?', match.engine_id).c;
  const status = match.engine_id ? 'identified' : match.model_id ? 'partial' : 'needs_check';
  return { ...base, status, vehicle, match, confidence: confidence(vehicle, match, eng), sources, last_updated: new Date(fetched).toISOString(),
    message: status === 'identified' ? '' : status === 'partial' ? 'Vehicul identificat parțial. Informația nu este disponibilă prin VIN. Poate fi introdusă manual pentru o verificare mai exactă.' : 'Vehicul identificat, dar această configurație nu există încă în baza noastră de tuning. Solicită o verificare personalizată.' };
}

/* ---------- date vehicul + tuning ---------- */
function engineInfo(id) {
  const e = one(`SELECT e.*,g.name gen,g.year_from,g.year_to,g.id gid,mo.name model,mo.id mid,mf.name make,mf.id mfid FROM engines e JOIN generations g ON g.id=e.generation_id JOIN models mo ON mo.id=g.model_id JOIN manufacturers mf ON mf.id=mo.manufacturer_id WHERE e.id=?`, id);
  if (!e) return null;
  const ecus = all('SELECT manufacturer,ecu_model FROM vehicle_ecus WHERE engine_id=?', id), tuning = {};
  for (const s of [1, 2]) {
    const t = one('SELECT * FROM tuning WHERE engine_id=? AND stage=? ORDER BY ecu LIMIT 1', id, s);
    if (!t || !t.available || t.min_hp == null || t.max_hp == null || !e.stock_hp) { tuning[s] = { available: false }; continue }
    tuning[s] = { available: true, gain_hp: [t.min_hp, t.max_hp], hp: [e.stock_hp + t.min_hp, e.stock_hp + t.max_hp], gain_nm: t.min_nm != null && t.max_nm != null ? [t.min_nm, t.max_nm] : null, nm: t.min_nm != null && t.max_nm != null && e.stock_nm ? [e.stock_nm + t.min_nm, e.stock_nm + t.max_nm] : null, price_eur: t.price_eur, hardware: t.hardware, verified: !!t.verified, label: t.verified ? 'TUNING DATABASE' : 'ESTIMARE ORIENTATIVĂ', notes: t.notes, ecu: t.ecu };
  }
  return { engine: e, ecus, tuning };
}

/* ---------- import CSV / JSON ---------- */
function parseCSV(t) {
  t = t.replace(/^\uFEFF/, ''); const f0 = t.split(/\r?\n/)[0] || '', d = (f0.match(/;/g) || []).length > (f0.match(/,/g) || []).length ? ';' : ',';
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < t.length; i++) { const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++ } else q = false } else f += c }
    else if (c === '"') q = true; else if (c === d) { row.push(f); f = '' }
    else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i++; row.push(f); f = ''; if (row.some(x => x.trim())) rows.push(row); row = [] } else f += c }
  row.push(f); if (row.some(x => x.trim())) rows.push(row);
  if (!rows.length) return []; const h = rows[0].map(x => x.trim().toLowerCase());
  return rows.slice(1).map(r => Object.fromEntries(h.map((k, i) => [k, (r[i] || '').trim()])));
}
const NUMF = ['year', 'year_from', 'year_to', 'displacement', 'stock_hp', 'stock_kw', 'stock_nm', ...[1, 2].flatMap(s => ['min_hp', 'max_hp', 'min_nm', 'max_nm', 'price'].map(k => `stage${s}_${k}`))];
function vRow(r) {
  const e = [], has = v => v !== '' && v != null;
  for (const k of ['make', 'model', 'generation', 'engine', 'fuel']) if (!has(r[k]) || String(r[k]).length > 100) e.push(`${k} lipsă sau prea lung`);
  for (const k of NUMF) if (has(r[k]) && !isFinite(+r[k])) e.push(`${k} nu este număr`);
  if (!(+r.stock_hp > 0 || +r.stock_kw > 0)) e.push('stock_hp (sau stock_kw) obligatoriu');
  const yf = +(r.year_from || r.year), yt = +(r.year_to || r.year); if (!(yf >= 1950 && yt <= 2100 && yf <= yt)) e.push('an invalid (year sau year_from + year_to)');
  for (const s of [1, 2]) { const a = r[`stage${s}_min_hp`], b = r[`stage${s}_max_hp`]; if (has(a) !== has(b)) e.push(`stage${s}: min_hp și max_hp se completează împreună`); else if (has(a) && +a > +b) e.push(`stage${s}: min_hp > max_hp`);
    const c = r[`stage${s}_min_nm`], d = r[`stage${s}_max_nm`]; if (has(c) && has(d) && +c > +d) e.push(`stage${s}: min_nm > max_nm`) }
  return e;
}
function upsertRow(r, source = 'import') {
  const t = now(), hp = n(r.stock_hp) || Math.round(n(r.stock_kw) * 1.341), kw = n(r.stock_kw) || Math.round(hp / 1.341 * 10) / 10;
  const mf = one(`INSERT INTO manufacturers(name,country,source,last_updated) VALUES(?,?,?,?) ON CONFLICT(name) DO UPDATE SET country=COALESCE(NULLIF(excluded.country,''),country),last_updated=excluded.last_updated RETURNING id`, str(r.make, 100), str(r.country, 60), source, t);
  const mo = one(`INSERT INTO models(manufacturer_id,name,source) VALUES(?,?,?) ON CONFLICT(manufacturer_id,name) DO UPDATE SET name=name RETURNING id`, mf.id, str(r.model, 100), source);
  const yf = +(r.year_from || r.year), yt = +(r.year_to || r.year);
  const ge = one(`INSERT INTO generations(model_id,name,year_from,year_to) VALUES(?,?,?,?) ON CONFLICT(model_id,name) DO UPDATE SET year_from=MIN(year_from,excluded.year_from),year_to=MAX(year_to,excluded.year_to) RETURNING id`, mo.id, str(r.generation, 100), yf, yt);
  const en = one(`INSERT INTO engines(generation_id,name,engine_code,displacement,fuel,aspiration,stock_hp,stock_kw,stock_nm,source,confidence,last_updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(generation_id,name,engine_code) DO UPDATE SET displacement=excluded.displacement,fuel=excluded.fuel,aspiration=excluded.aspiration,stock_hp=excluded.stock_hp,stock_kw=excluded.stock_kw,stock_nm=excluded.stock_nm,last_updated=excluded.last_updated RETURNING id`,
    ge.id, str(r.engine, 120), str(r.engine_code, 40), n(r.displacement), str(r.fuel, 40), str(r.aspiration, 40), hp, kw, n(r.stock_nm), source, source === 'import' ? 'IMPORTED' : 'MANUAL', t);
  if (r.ecu) { const s = String(r.ecu).trim(), i = s.indexOf(' '); run('INSERT OR IGNORE INTO vehicle_ecus(engine_id,manufacturer,ecu_model) VALUES(?,?,?)', en.id, i > 0 ? s.slice(0, i) : '', i > 0 ? s.slice(i + 1) : s) }
  for (const s of [1, 2]) if (r[`stage${s}_min_hp`] !== '' && r[`stage${s}_min_hp`] != null)
    run(`INSERT INTO tuning(engine_id,stage,ecu,min_hp,max_hp,min_nm,max_nm,price_eur,hardware,available,verified,notes,source,last_updated) VALUES(?,?,?,?,?,?,?,?,?,1,?,?,?,?) ON CONFLICT(engine_id,stage,ecu) DO UPDATE SET min_hp=excluded.min_hp,max_hp=excluded.max_hp,min_nm=excluded.min_nm,max_nm=excluded.max_nm,price_eur=excluded.price_eur,hardware=excluded.hardware,verified=excluded.verified,notes=excluded.notes,last_updated=excluded.last_updated`,
      en.id, s, '', n(r[`stage${s}_min_hp`]), n(r[`stage${s}_max_hp`]), n(r[`stage${s}_min_nm`]), n(r[`stage${s}_max_nm`]), n(r[`stage${s}_price`]), s === 2 ? str(r.stage2_hardware, 200) : '', /^(1|true|da|yes)$/i.test(String(r.verified || '')) ? 1 : 0, str(r.notes, 300), source, t);
  return en.id;
}
function importData(format, data, dry) {
  let rows; try { rows = format === 'json' ? JSON.parse(data) : parseCSV(String(data)); } catch { bad('Fișier ilegibil (JSON/CSV invalid).') }
  if (!Array.isArray(rows)) bad('JSON-ul trebuie să fie o listă de obiecte.'); if (!rows.length) bad('Fișierul nu conține rânduri.'); if (rows.length > 100000) bad('Maxim 100.000 de rânduri per import.');
  const errors = []; rows = rows.map(r => Object.fromEntries(Object.entries(r || {}).map(([k, v]) => [k.toLowerCase().trim(), typeof v === 'string' ? v.trim() : v])));
  rows.forEach((r, i) => { const e = vRow(r); if (e.length) errors.push({ row: i + 2, errors: e }) });
  if (errors.length) return { ok: false, rows: rows.length, invalid: errors.length, errors: errors.slice(0, 50) };
  if (dry) return { ok: true, dry: true, rows: rows.length };
  tx(() => rows.forEach(r => upsertRow(r))); log('info', 'import', { rows: rows.length });
  return { ok: true, imported: rows.length };
}

/* ---------- backup ---------- */
function backup() { const f = path.join(BK, `app-${new Date().toISOString().slice(0, 10)}.db`); if (fs.existsSync(f)) return path.basename(f); db.exec(`VACUUM INTO '${f.replace(/'/g, "''")}'`);
  const l = fs.readdirSync(BK).filter(x => x.endsWith('.db')).sort(); l.slice(0, Math.max(0, l.length - 14)).forEach(x => fs.unlinkSync(path.join(BK, x))); log('info', 'backup'); return path.basename(f) }

/* ---------- upload ---------- */
const MAGIC = [['jpg', b => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF], ['png', b => b.slice(0, 4).toString('hex') === '89504e47'], ['webp', b => b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP'], ['pdf', b => b.slice(0, 4).toString() === '%PDF']];

/* ---------- rute ---------- */
const routes = []; const R = (m, p, h, o = {}) => routes.push({ m, re: new RegExp('^' + p.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), h, o });
const inYear = e => { const a = []; for (let y = e.year_to; y >= e.year_from; y--) a.push(y); return a };
const EXISTS_E = 'EXISTS(SELECT 1 FROM engines e JOIN generations g ON g.id=e.generation_id JOIN models mo ON mo.id=g.model_id';

R('GET', '/api/health', () => ({ ok: true }));
R('GET', '/api/config', () => ({ wa: E.WA_NUMBER || '40768429345', statuses: STATUSES }));
R('GET', '/api/makes', () => all(`SELECT mf.id,mf.name FROM manufacturers mf WHERE ${EXISTS_E} WHERE mo.manufacturer_id=mf.id) ORDER BY mf.name`));
R('GET', '/api/models', c => all(`SELECT mo.id,mo.name FROM models mo WHERE mo.manufacturer_id=? AND EXISTS(SELECT 1 FROM generations g JOIN engines e ON e.generation_id=g.id WHERE g.model_id=mo.id) ORDER BY mo.name`, +c.q.get('make') || 0));
R('GET', '/api/generations', c => all('SELECT id,name,year_from,year_to FROM generations g WHERE model_id=? AND EXISTS(SELECT 1 FROM engines WHERE generation_id=g.id) ORDER BY year_from DESC', +c.q.get('model') || 0));
R('GET', '/api/engines', c => { const y = +c.q.get('year'); return all('SELECT id,name,engine_code,fuel,displacement,aspiration,stock_hp,stock_nm FROM engines WHERE generation_id=? ORDER BY stock_hp', +c.q.get('generation') || 0).map(e => ({ ...e })) });
R('GET', '/api/engine/:id', c => engineInfo(+c.p.id) || bad('Motorizare inexistentă.', 404));
R('GET', '/api/services', () => all('SELECT key,cat,name,description,price_eur,time_est FROM services WHERE active=1 ORDER BY sort'));
R('POST', '/api/vin', async c => { if (!allow('vin:' + c.ip, 20, 60000)) bad('Prea multe încercări. Încearcă din nou într-un minut.', 429); return decodeVIN((c.body || {}).vin) }, { limit: 2000 });

R('POST', '/api/quotes', c => {
  if (!allow('q:' + c.ip, 5, 600000)) bad('Prea multe cereri trimise. Încearcă mai târziu.', 429);
  const b = c.body || {}, name = str(b.name, 100), phone = str(b.phone, 30), email = str(b.email, 120);
  if (name.length < 2) bad('Completează numele.'); if (!/^[+()\d\s.-]{7,25}$/.test(phone)) bad('Număr de telefon invalid.'); if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) bad('Email invalid.');
  let vin = ''; if (b.vin) { vin = cleanVin(b.vin); if (!VIN_RE.test(vin)) bad('VIN-ul introdus nu este valid.') }
  const eid = n(b.engine_id), info = eid ? engineInfo(eid) : null, vehicle = info ? { make: info.engine.make, model: info.engine.model, generation: info.engine.gen, engine: info.engine.name, code: info.engine.engine_code, fuel: info.engine.fuel, hp: info.engine.stock_hp, nm: info.engine.stock_nm, ecu: str(b.ecu, 80) } : { text: str(b.vehicle_text, 300) };
  const files = Array.isArray(b.files) ? b.files : []; if (files.length > 3) bad('Maxim 3 fișiere.');
  const bufs = files.map(f => { const buf = Buffer.from(String(f.data || ''), 'base64'); if (!buf.length || buf.length > 4 * 1024 * 1024) bad('Fișier gol sau mai mare de 4 MB.'); const t = MAGIC.find(m => m[1](buf)); if (!t) bad('Sunt permise doar JPG, PNG, WEBP sau PDF.'); return { buf, ext: t[0], name: str(f.name, 80).replace(/[^\w.\- ]/g, '_') } });
  const r = one(`INSERT INTO requests(created,status,name,phone,whatsapp,email,km,city,mods,message,service,vin,engine_id,vehicle,files) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`, now(), 'Nouă', name, phone, str(b.whatsapp, 30), email, str(b.km, 20), str(b.city, 80), str(b.mods, 500), str(b.message, 2000), str(b.service, 120), vin, eid, JSON.stringify(vehicle), '[]');
  const saved = bufs.map((f, i) => { const fn = `${r.id}-${i}.${f.ext}`; fs.writeFileSync(path.join(UP, fn), f.buf); return { file: fn, name: f.name } });
  run('UPDATE requests SET files=? WHERE id=?', JSON.stringify(saved), r.id); log('info', 'cerere nouă', { id: r.id }); return { ok: true, id: r.id };
}, { limit: 20e6 });

/* admin */
R('POST', '/api/admin/login', c => {
  if (!allow('login:' + c.ip, 5, 60000)) bad('Prea multe încercări. Așteaptă un minut.', 429);
  const b = c.body || {}, a = one('SELECT * FROM admins WHERE username=?', str(b.username, 60)), h = hashPw(String(b.password || ''), a ? a.salt : '0'.repeat(32));
  if (!a || !crypto.timingSafeEqual(Buffer.from(h), Buffer.from(a.hash))) { log('warn', 'login eșuat', { ip: c.ip }); bad('Date de autentificare incorecte.', 401) }
  const s = mkSess(a.username); c.res.setHeader('Set-Cookie', `sid=${s.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${PROD ? '; Secure' : ''}`); return { ok: true, csrf: s.csrf };
});
R('POST', '/api/admin/logout', c => { c.res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); return { ok: true } });
R('GET', '/api/admin/me', c => ({ user: c.sess.u, csrf: c.sess.csrf }), { admin: 1 });
R('GET', '/api/admin/stats', () => ({
  counts: Object.fromEntries(['manufacturers', 'models', 'generations', 'engines', 'tuning', 'vin_cache', 'requests'].map(t => [t, one(`SELECT COUNT(*) c FROM ${t}`).c])),
  byStatus: all('SELECT status,COUNT(*) c FROM requests GROUP BY status'), topServices: all(`SELECT service,COUNT(*) c FROM requests WHERE service!='' GROUP BY service ORDER BY c DESC LIMIT 8`)
}), { admin: 1 });
R('GET', '/api/admin/requests', c => { const st = c.q.get('status'); return all(`SELECT id,created,status,name,phone,whatsapp,email,km,city,mods,message,service,vin,vehicle,files FROM requests ${st ? 'WHERE status=?' : ''} ORDER BY id DESC LIMIT 300`, ...(st ? [st] : [])).map(r => ({ ...r, vin: maskVin(r.vin), has_vin: !!r.vin, vehicle: JSON.parse(r.vehicle || '{}'), files: JSON.parse(r.files || '[]') })) }, { admin: 1 });
R('GET', '/api/admin/requests/:id/vin', c => { log('info', 'VIN dezvăluit de admin', { id: c.p.id, user: c.sess.u }); return { vin: (one('SELECT vin FROM requests WHERE id=?', +c.p.id) || {}).vin || '' } }, { admin: 1 });
R('PATCH', '/api/admin/requests/:id', c => { if (!STATUSES.includes((c.body || {}).status)) bad('Status invalid.'); run('UPDATE requests SET status=? WHERE id=?', c.body.status, +c.p.id); return { ok: true } }, { admin: 1 });
R('GET', '/api/admin/files/:name', c => { const f = c.p.name; if (!/^\d+-\d\.(jpg|png|webp|pdf)$/.test(f)) bad('Fișier invalid.', 404); const p = path.join(UP, f); if (!fs.existsSync(p)) bad('Inexistent.', 404);
  c.res.writeHead(200, { 'Content-Type': { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf' }[f.split('.')[1]], 'Content-Disposition': 'attachment', 'X-Content-Type-Options': 'nosniff' }); c.res.end(fs.readFileSync(p)); c.sent = true }, { admin: 1 });
R('GET', '/api/admin/engines', c => { const q = '%' + str(c.q.get('q'), 60) + '%'; return all(`SELECT e.id,mf.name make,mo.name model,g.name gen,e.name,e.engine_code,e.fuel,e.stock_hp,e.stock_nm,(SELECT json_group_array(json_object('stage',stage,'min_hp',min_hp,'max_hp',max_hp,'min_nm',min_nm,'max_nm',max_nm,'price_eur',price_eur,'hardware',hardware,'available',available,'verified',verified,'notes',notes)) FROM tuning WHERE engine_id=e.id) tuning FROM engines e JOIN generations g ON g.id=e.generation_id JOIN models mo ON mo.id=g.model_id JOIN manufacturers mf ON mf.id=mo.manufacturer_id WHERE mf.name||' '||mo.name||' '||g.name||' '||e.name||' '||e.engine_code LIKE ? ORDER BY mf.name,mo.name LIMIT 100`, q).map(e => ({ ...e, tuning: JSON.parse(e.tuning || '[]') })) }, { admin: 1 });
R('DELETE', '/api/admin/engines/:id', c => { run('DELETE FROM engines WHERE id=?', +c.p.id); return { ok: true } }, { admin: 1 });
R('PUT', '/api/admin/tuning', c => { const b = c.body || {}, s = +b.stage; if (![1, 2].includes(s) || !one('SELECT 1 x FROM engines WHERE id=?', +b.engine_id)) bad('Date invalide.');
  for (const k of ['min_hp', 'max_hp', 'min_nm', 'max_nm', 'price_eur']) if (b[k] !== '' && b[k] != null && !isFinite(+b[k])) bad(k + ' nu este număr.'); if (n(b.min_hp) != null && n(b.max_hp) != null && b.min_hp > b.max_hp) bad('min_hp > max_hp.');
  run(`INSERT INTO tuning(engine_id,stage,ecu,min_hp,max_hp,min_nm,max_nm,price_eur,hardware,available,verified,notes,source,last_updated) VALUES(?,?,'',?,?,?,?,?,?,?,?,?,'admin',?) ON CONFLICT(engine_id,stage,ecu) DO UPDATE SET min_hp=excluded.min_hp,max_hp=excluded.max_hp,min_nm=excluded.min_nm,max_nm=excluded.max_nm,price_eur=excluded.price_eur,hardware=excluded.hardware,available=excluded.available,verified=excluded.verified,notes=excluded.notes,last_updated=excluded.last_updated`,
    +b.engine_id, s, n(b.min_hp), n(b.max_hp), n(b.min_nm), n(b.max_nm), n(b.price_eur), str(b.hardware, 200), b.available ? 1 : 0, b.verified ? 1 : 0, str(b.notes, 300), now()); return { ok: true } }, { admin: 1 });
R('POST', '/api/admin/vehicle', c => { const r = Object.fromEntries(Object.entries(c.body || {}).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v])), e = vRow(r); if (e.length) bad(e.join('; ')); return { ok: true, engine_id: tx(() => upsertRow(r, 'admin')) } }, { admin: 1 });
R('POST', '/api/admin/import', c => importData((c.body || {}).format === 'json' ? 'json' : 'csv', (c.body || {}).data, !!(c.body || {}).dry), { admin: 1, limit: 30e6 });
R('POST', '/api/admin/sync/nhtsa', async c => {
  const makes = ((c.body || {}).makes || []).map(x => str(x, 60)).filter(Boolean).slice(0, 10); if (!makes.length) bad('Alege cel puțin o marcă.'); const res = [];
  for (const mk of makes) { try { const j = await retry(() => fetchJson(`${NHTSA}/vehicles/GetModelsForMake/${encodeURIComponent(mk)}?format=json`, {}, 10000)), L = j.Results || [];
    tx(() => { const m = one(`INSERT INTO manufacturers(name,source,source_id,last_updated) VALUES(?,?,?,?) ON CONFLICT(name) DO UPDATE SET last_updated=excluded.last_updated RETURNING id`, L[0] ? str(L[0].Make_Name, 100) : mk, 'nhtsa', L[0] ? String(L[0].Make_ID) : '', now()); L.forEach(x => run('INSERT OR IGNORE INTO models(manufacturer_id,name,source,source_id) VALUES(?,?,?,?)', m.id, str(x.Model_Name, 100), 'nhtsa', String(x.Model_ID))) });
    res.push({ make: mk, models: L.length }) } catch (e) { res.push({ make: mk, error: 'Sursa nu a răspuns' }) } }
  return { results: res, note: 'Modelele sincronizate apar în configurator abia după ce au generații și motorizări (import / adăugare manuală).' } }, { admin: 1 });
R('GET', '/api/admin/services', () => all('SELECT * FROM services ORDER BY sort'), { admin: 1 });
R('PATCH', '/api/admin/services/:key', c => { const b = c.body || {}; run('UPDATE services SET price_eur=?,active=? WHERE key=?', n(b.price_eur), b.active ? 1 : 0, c.p.key); return { ok: true } }, { admin: 1 });
R('POST', '/api/admin/backup', () => ({ file: backup() }), { admin: 1 });

/* ---------- server ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const readBody = (req, lim) => new Promise((ok, no) => { let b = '', sz = 0; req.on('data', d => { sz += d.length; if (sz > lim) { no(new HttpError(413, 'Cerere prea mare.')); req.destroy() } else b += d }); req.on('end', () => ok(b)); req.on('error', no) });
const ipOf = req => (E.TRUST_PROXY === '1' && (req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '?';
async function handle(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'same-origin'); res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  if (PROD) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  const url = new URL(req.url, 'http://x'), ip = ipOf(req);
  if (!url.pathname.startsWith('/api/')) {
    let p = url.pathname === '/' ? '/index.html' : url.pathname === '/admin' ? '/admin.html' : url.pathname;
    try { p = decodeURIComponent(p) } catch { res.writeHead(400); return res.end() } const f = path.normalize(path.join(PUB, p));
    if (!f.startsWith(PUB + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); return res.end('Not found') }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); return res.end(fs.readFileSync(f));
  }
  const send = (c, o) => { res.writeHead(c, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)) };
  try {
    if (!allow('g:' + ip, 600, 60000)) bad('Prea multe cereri.', 429);
    const rt = routes.find(r => r.m === req.method && r.re.test(url.pathname)); if (!rt) bad('Not found', 404);
    const ctx = { req, res, ip, q: url.searchParams, p: rt.re.exec(url.pathname).groups || {}, body: null, sess: null };
    if (req.method !== 'GET') {
      const o = req.headers.origin; if (o && new URL(o).host !== req.headers.host) bad('Origine nepermisă.', 403);
      const raw = await readBody(req, rt.o.limit || 1e6); if (raw) { try { ctx.body = JSON.parse(raw) } catch { bad('JSON invalid.') } }
    }
    if (rt.o.admin) { ctx.sess = getSess(req); if (!ctx.sess) bad('Autentificare necesară.', 401); if (req.method !== 'GET' && req.headers['x-csrf-token'] !== ctx.sess.csrf) bad('Token CSRF invalid.', 403) }
    const out = await rt.h(ctx); if (!ctx.sent) send(200, out);
  } catch (e) {
    if (e instanceof HttpError) return send(e.code, { error: e.message });
    log('error', 'eroare internă', { path: url.pathname, err: String(e.message).slice(0, 200) }); send(500, { error: 'Eroare internă. Încearcă din nou.' });
  }
}
function start(port = PORT) { const s = http.createServer(handle); s.requestTimeout = 30000; s.listen(port, () => log('info', 'server pornit', { port: s.address().port })); try { backup() } catch (e) { log('error', 'backup eșuat', { err: e.message }) } setInterval(() => { try { backup() } catch {} }, 864e5).unref(); return s }
module.exports = { start, db, decodeVIN, importData, addAdmin };
if (require.main === module) start();
