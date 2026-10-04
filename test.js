'use strict';
// Rulează: npm test. Folosește DB temporar și un server NHTSA fals DOAR în teste.
// Datele din fixture sunt valori de test, nu date reale de vehicule.
const http = require('node:http'), os = require('node:os'), fs = require('node:fs'), path = require('node:path');
const { test, before, after } = require('node:test'), assert = require('node:assert/strict');
let fake, calls = 0, mode = 'ok', flaky = 0, srv, base, cookie = '', csrf = '';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tms-'));
const FIX = `make,model,generation,year_from,year_to,engine,engine_code,fuel,stock_hp,stock_nm,ecu,stage1_min_hp,stage1_max_hp,stage1_min_nm,stage1_max_nm,stage1_price,stage2_min_hp,stage2_max_hp,stage2_hardware,verified
TestMake,TestModel,G1,2018,2022,2.0 Diesel,TST1,Diesel,190,400,Bosch EDC17,30,40,50,80,300,,,,1
TestMake,TestModel,G1,2018,2022,2.0 Petrol,TST2,Petrol,250,370,,,,,,,,,,0`;
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(32)]).toString('base64');

before(async () => {
  fake = http.createServer((q, r) => {
    calls++; r.setHeader('Content-Type', 'application/json');
    if (mode === 'down') { r.statusCode = 500; return r.end('{}') }
    if (flaky > 0) { flaky--; r.statusCode = 500; return r.end('{}') }
    const vin = q.url.split('/').pop().split('?')[0];
    const R = vin.startsWith('WBA') ? { Make: 'TestMake', Model: 'TestModel', ModelYear: '2020', FuelTypePrimary: 'Diesel', EngineHP: '190', DisplacementL: '2.0', EngineModel: 'TST1' } : { Make: '', Model: '' };
    r.end(JSON.stringify({ Results: [R] }));
  });
  await new Promise(r => fake.listen(0, r));
  Object.assign(process.env, { DATA_DIR: tmp, NHTSA_BASE: `http://127.0.0.1:${fake.address().port}/api`, ADMIN_USER: 'admin', ADMIN_PASSWORD: 'parola-de-test-123', QUIET: '1', VIN_PROVIDERS: 'nhtsa' });
  srv = require('./server.js').start(0); await new Promise(r => setTimeout(r, 100)); base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => { srv.close(); fake.close(); setTimeout(() => process.exit(0), 100) });
const api = async (m, p, b, admin) => {
  const h = { 'Content-Type': 'application/json' }; if (admin) { h.cookie = cookie; h['x-csrf-token'] = csrf }
  const r = await fetch(base + p, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined }); return { s: r.status, j: await r.json().catch(() => null), r };
};

test('VIN invalid / caractere interzise / prea scurt', async () => {
  assert.equal((await api('POST', '/api/vin', { vin: 'ABC' })).j.error, 'VIN-ul introdus nu este valid.');
  assert.equal((await api('POST', '/api/vin', { vin: 'WBAIOQ00000000000' })).s, 400);
});
test('admin: neautentificat 401, login greșit 401, login ok', async () => {
  assert.equal((await api('GET', '/api/admin/stats')).s, 401);
  assert.equal((await api('POST', '/api/admin/login', { username: 'admin', password: 'gresit' })).s, 401);
  const l = await api('POST', '/api/admin/login', { username: 'admin', password: 'parola-de-test-123' });
  assert.equal(l.s, 200); cookie = l.r.headers.get('set-cookie').split(';')[0]; csrf = l.j.csrf;
  assert.equal((await api('GET', '/api/admin/stats', null, true)).s, 200);
  assert.equal((await fetch(base + '/api/admin/backup', { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: '{}' })).status, 403); // fără CSRF
});
test('import CSV: validare (rând greșit) apoi import real', async () => {
  const badCsv = FIX + '\nX,Y,G,2020,2019,eng,,Diesel,abc,,,,,,,,,,,';
  const v = await api('POST', '/api/admin/import', { format: 'csv', data: badCsv, dry: true }, true);
  assert.equal(v.j.ok, false); assert.ok(v.j.errors.length >= 1);
  assert.equal((await api('POST', '/api/admin/import', { format: 'csv', data: FIX, dry: true }, true)).j.dry, true);
  assert.equal((await api('POST', '/api/admin/import', { format: 'csv', data: FIX }, true)).j.imported, 2);
  const json = await api('POST', '/api/admin/import', { format: 'json', data: JSON.stringify([{ make: 'JMake', model: 'JModel', generation: 'A', year: 2015, engine: '1.6', fuel: 'Petrol', stock_hp: 110 }]) }, true);
  assert.equal(json.j.imported, 1);
});
test('configurator manual: marcă → model → generație → motor → calcul Stage 1/2', async () => {
  const mk = (await api('GET', '/api/makes')).j; assert.ok(mk.find(x => x.name === 'TestMake'));
  const mo = (await api('GET', '/api/models?make=' + mk.find(x => x.name === 'TestMake').id)).j; assert.equal(mo[0].name, 'TestModel');
  const ge = (await api('GET', '/api/generations?model=' + mo[0].id)).j; assert.equal(ge[0].year_from, 2018);
  const en = (await api('GET', '/api/engines?generation=' + ge[0].id)).j; assert.equal(en.length, 2);
  const d = (await api('GET', '/api/engine/' + en.find(e => e.engine_code === 'TST1').id)).j;
  assert.deepEqual(d.tuning[1].hp, [220, 230]); assert.deepEqual(d.tuning[1].nm, [450, 480]); assert.equal(d.tuning[1].label, 'TUNING DATABASE'); assert.equal(d.tuning[2].available, false);
  const d2 = (await api('GET', '/api/engine/' + en.find(e => e.engine_code === 'TST2').id)).j; assert.equal(d2.tuning[1].available, false);
});
test('VIN valid → identificat + potrivire DB; al doilea apel vine din cache', async () => {
  calls = 0; const a = (await api('POST', '/api/vin', { vin: ' wba 12345678901234 ' })).j;
  assert.equal(a.status, 'identified'); assert.ok(a.match.engine_id); assert.equal(a.vin_masked, 'WBA***********234'); assert.equal(a.confidence.engine_code, 'CONFIRMED');
  const b = (await api('POST', '/api/vin', { vin: 'WBA12345678901234' })).j; assert.equal(b.cached, true); assert.equal(calls, 1);
});
test('VIN necunoscut → not_found', async () => { assert.equal((await api('POST', '/api/vin', { vin: 'ZZZ12345678901234' })).j.status, 'not_found') });
test('retry: provider cade de 2 ori apoi răspunde', async () => { flaky = 2; assert.equal((await api('POST', '/api/vin', { vin: 'WBA99999999999999' })).j.status, 'identified') });
test('provider indisponibil, fără cache → mesaj prietenos (nu eroare tehnică)', async () => {
  mode = 'down'; const r = (await api('POST', '/api/vin', { vin: 'WBC12345678901234' })); mode = 'ok';
  assert.equal(r.s, 200); assert.equal(r.j.status, 'unavailable'); assert.match(r.j.message, /temporar indisponibilă/);
});
test('cerere ofertă + upload valid, upload invalid respins, status în admin', async () => {
  const eid = (await api('GET', '/api/admin/engines?q=TST1', null, true)).j[0].id;
  const body = { name: 'Client Test', phone: '+40 700 000 000', email: 'a@b.ro', service: 'Stage 1', engine_id: eid, vin: 'WBA12345678901234', files: [{ name: 'poza.png', data: PNG }] };
  const q = await api('POST', '/api/quotes', body); assert.equal(q.s, 200);
  assert.equal((await api('POST', '/api/quotes', { ...body, files: [{ name: 'x.exe', data: Buffer.from('MZ-rau').toString('base64') }] })).s, 400);
  assert.equal((await api('POST', '/api/quotes', { ...body, phone: 'abc' })).s, 400);
  const list = (await api('GET', '/api/admin/requests', null, true)).j; assert.equal(list[0].vin, 'WBA***********234'); assert.equal(list[0].files.length, 1);
  assert.equal((await api('PATCH', '/api/admin/requests/' + list[0].id, { status: 'În verificare' }, true)).s, 200);
  assert.equal((await api('PATCH', '/api/admin/requests/' + list[0].id, { status: 'Inventat' }, true)).s, 400);
});
test('fișiere statice: path traversal blocat; pagina principală servită', async () => {
  assert.equal((await fetch(base + '/..%2fserver.js')).status, 404);
  assert.equal((await fetch(base + '/')).status, 200);
});
