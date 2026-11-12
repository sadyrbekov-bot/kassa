'use strict';
/* ============ Резервная касса ============
   Настройки (можно менять): */
const CFG = {
  CLOSE_HOUR: 23, CLOSE_MIN: 59,   // сессия закрывается автоматически каждый день в это время (23:59 по часам телефона)
  KEEP_DAYS: 90,          // закрытые сессии и их продажи хранятся столько дней (отчёты за период берут данные отсюда)
  PRICE_URLS: ['prices.xlsx', 'prices.csv'],   // что скачивать рядом с приложением, если свой адрес не задан: сначала выгрузка Excel как есть, затем CSV
  SYNC_EVERY_MIN: 30,     // как часто проверять новый прайс, пока приложение открыто
  SYNC_TIMEOUT_MS: 15000, // если интернета нет, ждать не дольше
  SCAN_REPEAT_MS: 1500,   // пауза против двойного чтения одного штрихкода
  STALE_DAYS: 3,          // через сколько дней предупреждать, что прайс не обновлялся
  VERSION: '1.3'
};

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const r2 = x => Math.round((x + Number.EPSILON) * 100) / 100;
const r3 = x => Math.round((x + Number.EPSILON) * 1000) / 1000;
const nf0 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf3 = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 3 });
const sp = s => s.replace(/[  ]/g, ' ');
const money = x => { x = r2(x || 0); return sp((Number.isInteger(x) ? nf0 : nf2).format(x)); };
const qtyText = (q, unit) => unit === 'кг' ? sp(nf3.format(q)) + ' кг' : sp(nf0.format(q)) + ' шт';
const pad = n => String(n).padStart(2, '0');
const fmtDT = ts => { const d = new Date(ts); return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); };
const fmtTime = ts => { const d = new Date(ts); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
const normText = s => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
const normBC = s => { s = String(s || '').trim().toUpperCase().replace(/\s+/g, ''); if (/^\d+$/.test(s)) s = s.replace(/^0+(?=\d)/, ''); return s; };
const num = v => { const x = parseFloat(String(v || '').replace(/\s/g, '').replace(',', '.')); return isFinite(x) ? x : 0; };
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

/* ---------- хранилище (IndexedDB) ---------- */
const DB = (() => {
  let db;
  const open = () => new Promise((res, rej) => {
    const rq = indexedDB.open('kassa', 1);
    rq.onupgradeneeded = () => {
      const d = rq.result;
      d.createObjectStore('kv');
      d.createObjectStore('sessions', { keyPath: 'id' });
      d.createObjectStore('sales', { keyPath: 'id' }).createIndex('sessionId', 'sessionId');
    };
    rq.onsuccess = () => { db = rq.result; res(); };
    rq.onerror = () => rej(rq.error);
  });
  const run = (store, mode, fn) => new Promise((res, rej) => {
    const t = db.transaction(store, mode); let out;
    t.oncomplete = () => res(out);
    t.onerror = t.onabort = () => rej(t.error);
    const r = fn(t.objectStore(store));
    if (r && 'onsuccess' in r) r.onsuccess = () => { out = r.result; };
  });
  return {
    open,
    get: (s, k) => run(s, 'readonly', o => o.get(k)),
    all: s => run(s, 'readonly', o => o.getAll()),
    bySession: id => run('sales', 'readonly', o => o.index('sessionId').getAll(id)),
    put: (s, v, k) => run(s, 'readwrite', o => (k === undefined ? o.put(v) : o.put(v, k))),
    del: (s, k) => run(s, 'readwrite', o => o.delete(k)),
  };
})();
const kvGet = k => DB.get('kv', k);
const kvSet = (k, v) => DB.put('kv', v, k);

/* ---------- чтение файла прайса (CSV) ---------- */
function decodeBuf(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch (e) { return new TextDecoder('windows-1251').decode(buf); }
}
function hashBuf(buf) {
  const u = new Uint8Array(buf); let h = 2166136261;
  for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i], 16777619);
  return (h >>> 0).toString(16) + ':' + u.length;
}
function parseCSV(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const nl = text.indexOf('\n');
  const first = text.slice(0, nl > 0 ? nl : 3000);
  const cnt = ch => first.split(ch).length - 1;
  const delim = [';', '\t', ','].map(d => [d, cnt(d)]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = [], f = '', q = false, qs = 0, i = 0;
  const n = text.length;
  while (i < n || q) {
    if (q && i >= n) { q = false; f = '"'; i = qs; continue; }      // файл кончился внутри кавычек: значит, кавычка была обычным символом
    const c = text[i];
    if (q) {
      if (c === '"') {
        const nx = text[i + 1];
        if (nx === '"') { f += '"'; i += 2; continue; }
        if (nx === undefined || nx === delim || nx === '\n' || nx === '\r') q = false;   // закрывает поле только кавычка перед разделителем
        else f += c;
      }
      else if (i - qs > 400) { q = false; f = '"'; i = qs; continue; }                  // слишком длинно для названия: кавычка была обычным символом
      else f += c;
    }
    else if (c === '"' && f === '') { q = true; qs = i + 1; }       // кавычка открывает поле только в его начале (ХЛЕБ "БОРОДИНСКИЙ", 6" — это просто текст)
    else if (c === delim) { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
    i++;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows;
}
function parsePrice(v) {
  let s = String(v == null ? '' : v).replace(/[\s ]/g, '');
  if (!s) return null;
  if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else s = s.replace(',', '.');
  const m = s.match(/^\d+(\.\d+)?/);
  const x = m ? parseFloat(m[0]) : 0;
  return x > 0 ? x : null;
}

const HDR = {
  code: ['код', 'артикул', 'id', 'sku', 'кодтовара'],
  name: ['наименование', 'название', 'номенклатура', 'товар', 'name', 'наименованиетовара'],
  bc: ['штрихкод', 'штрихкоды', 'шк', 'barcode', 'ean', 'штрихкодтовара'],
  price: ['розничнаяцена', 'ценапродажи', 'розничная', 'розница', 'ценарозничная', 'цена', 'price'],   // закупочные цены сюда не попадают
  unit: ['единицаизмерения', 'единица', 'едизм', 'ед', 'unit'],
  plu: ['plu', 'плу', 'кодвесов', 'номернавесах', 'номервесах'],
  stock: ['количествоостаток', 'остаток', 'остатокнаскладе', 'количество']       // нужен только для проверки полноты выгрузки, в прайс не попадает
};
const hkey = s => String(s == null ? '' : s).toLowerCase().replace(/ё/g, 'е').replace(/[\s.\-_,]/g, '');
/* Закупочная цена за единицу (для отчёта по себестоимости). Искать её надо так же, как остальные столбцы, но в выборе строки заголовка она не участвует. Раньше в списке — важнее */
const HDR_COST = ['закупочнаяцена', 'ценазакупки', 'закупочная', 'закупка', 'закупцена', 'себестоимость', 'ценапоставщика', 'приходнаяцена', 'входящаяцена'];

/* Строка заголовка. У выгрузок из учётных программ шапка бывает в 2–3 строки (группа «Итого», ниже «Розничная цена», ещё ниже «Код», «Номенклатура»…) */
function findHeader(rows) {
  const scan = Math.min(rows.length, 25), keys = [];
  for (let r = 0; r < scan; r++) keys.push((rows[r] || []).map(hkey));
  const rank = (row, f) => { let b = null; for (let i = 0; i < row.length; i++) { const k = HDR[f].indexOf(row[i]); if (k >= 0 && (!b || k < b.k)) b = { i, k }; } return b; };
  let bi = -1, bs = 0;
  for (let r = 0; r < scan; r++) { let s = 0; for (const f of Object.keys(HDR)) if (rank(keys[r], f)) s++; if (s > bs) { bs = s; bi = r; } }
  if (bi < 0) return null;
  const col = {};
  for (const f of Object.keys(HDR))
    for (let r = bi; r >= Math.max(0, bi - 3); r--) { const x = rank(keys[r], f); if (x) { col[f] = x.i; break; } }
  for (let r = bi; r >= Math.max(0, bi - 3); r--) {
    let b = null; for (let i = 0; i < keys[r].length; i++) { const k = HDR_COST.indexOf(keys[r][i]); if (k >= 0 && (!b || k < b.k)) b = { i, k }; }
    if (b) { col.cost = b.i; break; }
  }
  const above = keys.slice(Math.max(0, bi - 3), bi + 1).map(k => k.join('|')).join('|');
  return { row: bi, col, hasCost: /закуп|себестоим|оптов/.test(above) };
}

/* Превращает строки файла в список товаров. Возвращает {products, report} или {error} */
function buildCatalog(rows) {
  if (!rows.length) return { error: 'Файл пустой' };
  const h = findHeader(rows), col = h ? h.col : {};
  if (!h || col.name == null || col.price == null) {
    const first = rows.find(r => r.some(x => String(x).trim())) || [];
    return { error: 'Не найдены столбцы «Наименование» и «Цена». В начале файла: ' + first.filter(x => String(x).trim()).slice(0, 8).join(' | ') };
  }
  const rep = { rows: 0, products: 0, barcodes: 0, noBarcode: 0, noPrice: 0, deleted: 0, skipped: 0, badBc: 0, badEx: [], conflicts: 0, conflictEx: [],
    weighted: 0, plu: 0, pluConflicts: 0, hasCost: !!h.hasCost, costCol: col.cost != null, costN: 0, stockN: 0, stock: null, conflictList: [], badList: [], noBcList: [], noPriceList: [] };
  const byKey = new Map(), products = [], owner = new Map();
  const clean = v => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  for (let r = h.row + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every(x => !String(x).trim())) continue;
    rep.rows++;
    const name = clean(row[col.name]);
    const codeRaw = col.code != null ? clean(row[col.code]) : '';
    if (!name || /^итого(\s|$)/i.test(name)) { rep.skipped++; continue; }     // итоговые и групповые строки («Организация», «Склад», «Итого»)
    if (/^удалить(\s|$)/i.test(name)) { rep.deleted++; continue; }
    const key = codeRaw ? 'c:' + codeRaw : 'n:' + normText(name);
    let p = byKey.get(key);
    if (!p) {
      let price = parsePrice(row[col.price]);
      if (price != null) price = Math.round(price * 100) / 100;
      let unit = 'шт';
      if (col.unit != null) unit = /^(кг|kg|килограмм)/i.test(clean(row[col.unit])) ? 'кг' : 'шт';
      else if (/(^|\s)вес\s*$/i.test(name)) unit = 'кг';
      p = { code: codeRaw, name, price, unit, bcs: [], plu: null, shared: [], cost: null, stock: null };
      if (col.plu != null) { const v = parseInt(String(row[col.plu] || '').replace(/\D/g, ''), 10); if (v > 0) p.plu = v; }
      if (col.cost != null) { const cv = parsePrice(row[col.cost]); if (cv != null) { p.cost = Math.round(cv * 10000) / 10000; rep.costN++; } }
      byKey.set(key, p); products.push(p);
      if (price == null) { rep.noPrice++; rep.noPriceList.push(p); }
      if (col.stock != null) {
        const sx = String(row[col.stock] == null ? '' : row[col.stock]).replace(/[\s ]/g, '').replace(',', '.');
        if (sx !== '' && isFinite(+sx)) { p.stock = Math.round(+sx * 1000) / 1000; rep.stockN++; rep.stock = rep.stock || { pos: 0, zero: 0, neg: 0 }; if (+sx > 0) rep.stock.pos++; else if (+sx === 0) rep.stock.zero++; else rep.stock.neg++; }
      }
    }
    const cell = col.bc != null ? String(row[col.bc] == null ? '' : row[col.bc]) : '';
    const cellOne = cell.replace(/\s+/g, '');
    for (let part of (/^\d+([.,]\d+)?e\+?\d+$/i.test(cellOne) ? [cellOne] : cell.split(/[;|,\n]+/))) {
      part = part.trim().replace(/\s+/g, '');
      if (!part) continue;
      // не штрихкод: число в экспоненте, строчные буквы и знаки (куски кодов маркировки), цифр больше 14
      if (/^\d+([.,]\d+)?e\+?\d+$/i.test(part) || !/^[0-9A-Z\-]{3,20}$/.test(part) || (/^\d+$/.test(part) && part.length > 14)) {
        rep.badBc++; if (rep.badEx.length < 12) rep.badEx.push(part.slice(0, 26) + ': ' + p.name.slice(0, 28));
        if (rep.badList.length < 3000) rep.badList.push({ code: p.code, name: p.name, value: part });
        continue;
      }
      const nb = normBC(part), ow = owner.get(nb);
      if (ow && ow !== p) {
        if (!p.shared.includes(nb)) {
          p.shared.push(nb); rep.conflicts++;
          if (rep.conflictEx.length < 12) rep.conflictEx.push(part + ': «' + ow.name.slice(0, 28) + '» и «' + p.name.slice(0, 28) + '»');
          if (rep.conflictList.length < 3000) rep.conflictList.push({ bc: part, a: ow, b: p });
        }
      } else if (!ow) { owner.set(nb, p); p.bcs.push(nb); }
    }
  }
  const pluOwner = new Map();
  for (const p of products) {
    if (p.unit === 'кг') {
      rep.weighted++;
      // Номер товара на весах берём только из столбца PLU. Код из учётной программы и число в названии с ним НЕ совпадают: так можно продать не тот товар.
      if (p.plu) { if (pluOwner.has(p.plu) && pluOwner.get(p.plu) !== p) { rep.pluConflicts++; p.plu = null; } else { pluOwner.set(p.plu, p); rep.plu++; } }
    }
    rep.barcodes += p.bcs.length;
    if (!p.bcs.length && !p.shared.length) { rep.noBarcode++; if (rep.noBcList.length < 3000) rep.noBcList.push(p); }
  }
  rep.products = products.length;
  return { products, report: rep };
}
/* Отчёт для хранения в телефоне: без длинных списков */
function liteReport(rep) { const o = Object.assign({}, rep); delete o.conflictList; delete o.badList; delete o.noBcList; delete o.noPriceList; return o; }

/* ---------- чтение Excel (.xlsx) без внешних библиотек ---------- */
const isZip = buf => { const u = new Uint8Array(buf, 0, Math.min(4, buf.byteLength)); return u.length === 4 && u[0] === 0x50 && u[1] === 0x4B && u[2] === 3 && u[3] === 4; };
async function inflateRaw(u8) {
  if (typeof DecompressionStream !== 'function') throw new Error('Этот браузер не умеет читать файлы Excel. Сохраните файл как CSV или обновите Chrome.');
  const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
function unzip(buf) {
  const dv = new DataView(buf), u8 = new Uint8Array(buf), td = new TextDecoder();
  let e = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 66000); i--) if (dv.getUint32(i, true) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error('Файл Excel повреждён или скачан не полностью');
  const n = dv.getUint16(e + 10, true); let p = dv.getUint32(e + 16, true);
  const files = {};
  for (let k = 0; k < n && dv.getUint32(p, true) === 0x02014b50; k++) {
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    files[td.decode(u8.subarray(p + 46, p + 46 + nlen))] = { method: dv.getUint16(p + 10, true), csize: dv.getUint32(p + 20, true), off: dv.getUint32(p + 42, true) };
    p += 46 + nlen + xlen + clen;
  }
  return {
    names: Object.keys(files),
    async read(name) {
      const f = files[name]; if (!f) return null;
      const start = f.off + 30 + dv.getUint16(f.off + 26, true) + dv.getUint16(f.off + 28, true), data = u8.subarray(start, start + f.csize);
      if (f.method === 0) return data;
      if (f.method === 8) return inflateRaw(data);
      throw new Error('Неподдерживаемое сжатие внутри файла Excel');
    }
  };
}
/* Разбор разметки листа без DOM. Выгрузки из учётных программ «тяжёлые» (сотни байт разметки на ячейку): DOMParser на таком файле
   занимает десятки секунд на телефоне и очень много памяти. Результат тот же, что у разбора через DOM (это проверяют тесты) */
const xmlDec = s => s.indexOf('&') < 0 ? s : s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (m, e) => {
  if (e === 'amp') return '&'; if (e === 'lt') return '<'; if (e === 'gt') return '>'; if (e === 'quot') return '"'; if (e === 'apos') return "'";
  try { return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)); } catch (_) { return ''; }
});
function xmlTexts(s) {      // весь текст из <t>…</t> внутри фрагмента (в том числе из частей «форматированного текста»)
  let out = '', m; const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
  while ((m = re.exec(s))) out += m[1];
  return xmlDec(out);
}
function fastShared(txt) {
  const out = [], re = /<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g; let m;
  while ((m = re.exec(txt))) out.push(m[1] ? xmlTexts(m[1]) : '');
  return out;
}
function fastRows(txt, ss) {
  const rows = [], rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g, cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let rm, found = 0;
  while ((rm = rowRe.exec(txt))) {
    found++;
    const rn = /(?:^|\s)r="(\d+)"/.exec(rm[1]), ri = rn ? parseInt(rn[1], 10) - 1 : -1, cells = [], body = rm[2];
    if (body) {
      let cm, ci = 0; cellRe.lastIndex = 0;
      while ((cm = cellRe.exec(body))) {
        const cr = /(?:^|\s)r="([A-Z]+)\d*"/.exec(cm[1]);
        if (cr) { let k = 0; for (let q = 0; q < cr[1].length; q++) k = k * 26 + cr[1].charCodeAt(q) - 64; ci = k - 1; }
        const ct = /(?:^|\s)t="([^"]*)"/.exec(cm[1]), t = ct ? ct[1] : '', cb = cm[2];
        let v = '';
        if (cb) {
          if (t === 'inlineStr') v = xmlTexts(cb);
          else { const vm = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(cb); v = vm ? xmlDec(vm[1]) : ''; if (t === 's') v = ss[+v] || ''; }
        }
        cells[ci++] = v;
      }
    }
    rows[ri >= 0 ? ri : rows.length] = Array.from(cells, x => x == null ? '' : x);
  }
  for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
  // страховка: число найденных строк должно совпасть с числом тегов <row>, иначе разбор через DOM
  let tags = 0, ix = -1;
  while ((ix = txt.indexOf('<row', ix + 1)) >= 0) { const ch = txt.charCodeAt(ix + 4); if (ch === 32 || ch === 62 || ch === 47 || ch === 10 || ch === 13 || ch === 9) tags++; }
  return tags === found ? rows : null;
}
async function xlsxSheets(buf, viaDom) {
  const z = unzip(buf), td = new TextDecoder('utf-8');
  const text = async n => { const d = await z.read(n); return d ? td.decode(d) : null; };
  const xml = async n => {
    const s = await text(n); if (s == null) return null;
    const doc = new DOMParser().parseFromString(s, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('Файл Excel повреждён');
    return doc;
  };
  let ss = [];
  if (viaDom) { const sx = await xml('xl/sharedStrings.xml'); if (sx) for (const si of sx.getElementsByTagName('si')) ss.push([...si.getElementsByTagName('t')].map(t => t.textContent).join('')); }
  else { const s = await text('xl/sharedStrings.xml'); if (s) ss = fastShared(s); }
  const wb = await xml('xl/workbook.xml'), rels = await xml('xl/_rels/workbook.xml.rels'), relMap = {};
  if (rels) for (const r of rels.getElementsByTagName('Relationship')) relMap[r.getAttribute('Id')] = r.getAttribute('Target');
  const list = [];
  if (wb) for (const s of wb.getElementsByTagName('sheet')) {
    if (s.getAttribute('state') === 'hidden') continue;
    const rid = s.getAttribute('r:id') || s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
    let t = relMap[rid]; if (!t) continue;
    t = t.replace(/^\//, ''); if (!t.startsWith('xl/')) t = 'xl/' + t;
    list.push({ name: s.getAttribute('name'), path: t });
  }
  if (!list.length) z.names.filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).forEach(n => list.push({ name: n, path: n }));
  const out = [];
  for (const sh of list) {
    let rows = null;
    if (!viaDom) { const s = await text(sh.path); if (s == null) continue; rows = fastRows(s, ss); }
    if (!rows) {      // разбор через DOM (запасной путь и эталон для тестов)
      const doc = await xml(sh.path); if (!doc) continue;
      rows = [];
      for (const row of doc.getElementsByTagName('row')) {
        const ri = parseInt(row.getAttribute('r'), 10) - 1, cells = [];
        let ci = 0;
        for (const c of row.getElementsByTagName('c')) {
          const ref = c.getAttribute('r'), m = ref && ref.match(/^([A-Z]+)/);
          if (m) { let k = 0; for (const ch of m[1]) k = k * 26 + ch.charCodeAt(0) - 64; ci = k - 1; }
          const t = c.getAttribute('t'); let v = '';
          if (t === 'inlineStr') v = [...c.getElementsByTagName('t')].map(x => x.textContent).join('');
          else { const ve = c.getElementsByTagName('v')[0]; v = ve ? ve.textContent : ''; if (t === 's') v = ss[+v] || ''; }
          cells[ci++] = v;
        }
        rows[ri >= 0 ? ri : rows.length] = Array.from(cells, x => x == null ? '' : x);
      }
      for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
    }
    out.push({ name: sh.name, rows });
  }
  return out;
}
/* Любой файл прайса (Excel, CSV): разобрать и построить каталог. Листы Excel перебираются, пока не найдётся нужный */
async function buildCatalogFromBuffer(buf) {
  const h4 = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
  if (h4[0] === 0xD0 && h4[1] === 0xCF && h4[2] === 0x11 && h4[3] === 0xE0)
    return { error: 'Это старый формат Excel (.xls). Откройте файл в Excel и сохраните как «Книга Excel (.xlsx)» или «CSV UTF-8».' };
  let tabs;
  try { tabs = isZip(buf) ? await xlsxSheets(buf) : [{ name: 'CSV', rows: parseCSV(decodeBuf(buf)) }]; }
  catch (e) { return { error: (e && e.message) || String(e) }; }
  let last = null;
  for (const t of tabs) {
    let res = buildCatalog(t.rows);
    // CSV, открытый в Excel без разбиения по столбцам и сохранённый как xlsx: вся строка лежит в первой ячейке. Разбираем её как CSV
    if (res.error && t.name !== 'CSV' && t.rows.slice(0, 20).some(r => String(r[0] || '').split(/[;\t]/).length >= 3))
      res = buildCatalog(parseCSV(t.rows.map(r => r.join(',').replace(/,+$/, '')).join('\n')));
    if (!res.error) { res.sheet = t.name; return res; }
    last = res;
  }
  return last || { error: 'В файле нет данных' };
}

/* ---------- чистый CSV для публикации и отчёт о проблемах ---------- */
const csvCell = v => { v = String(v == null ? '' : v); return /[;"\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
function catalogToCsv(products, withCost, withStock) {      // withCost: добавить столбец «Закупка», withStock: столбец «Остаток» (для отчётов в приложении). Без них файл такой же, как раньше
  const out = ['Код;Наименование;Штрихкод;Цена;Ед.;PLU' + (withCost ? ';Закупка' : '') + (withStock ? ';Остаток' : '')];
  for (const p of products) {
    const price = p.price == null ? '' : String(p.price).replace('.', ',');
    const cost = p.cost == null ? '' : String(p.cost).replace('.', ',');
    const stock = p.stock == null ? '' : String(p.stock).replace('.', ',');
    const bcs = [...p.bcs, ...(p.shared || [])];
    for (const b of (bcs.length ? bcs : [''])) out.push([p.code, p.name, b, price, p.unit, p.plu || ''].concat(withCost ? [cost] : [], withStock ? [stock] : []).map(csvCell).join(';'));
  }
  return '﻿' + out.join('\r\n') + '\r\n';
}
function problemsCsv(rep) {
  const L = ['Проблема;Код;Наименование;Штрихкод;Что сделать'];
  const add = (t, c, n, b, d) => L.push([t, c, n, b, d].map(csvCell).join(';'));
  for (const c of rep.conflictList) for (const p of [c.a, c.b]) add('Один штрихкод у двух товаров', p.code, p.name, c.bc, 'Оставить штрихкод только у того товара, которому он принадлежит');
  for (const b of rep.badList) add('Некорректный штрихкод', b.code, b.name, b.value, 'Удалить значение (похоже на код маркировки или ошибку ввода)');
  for (const p of rep.noBcList) add('Нет штрихкода', p.code, p.name, '', p.unit === 'кг' ? 'Весовой товар: найдётся по этикетке с весов или по названию' : 'Добавить штрихкод, иначе товар найдётся только по названию');
  for (const p of rep.noPriceList) add('Нет цены', p.code, p.name, '', 'Указать розничную цену');
  return '﻿' + L.join('\r\n') + '\r\n';
}

/* ---------- каталог в памяти ---------- */
const CAT = { products: [], names: [], byBc: new Map(), byPlu: new Map(), byKey: new Map(), dups: new Map(), bcList: [], skipped: [], meta: null };
const EXTRA = new Map();    // товары, которых нет в прайсе (кассир ввёл вручную): штрихкод -> {name, price, unit}
const PLUMAP = new Map();   // номер товара на весах -> ключ товара. Запоминается, когда кассир один раз сопоставил этикетку с товаром
const pkey = p => p.code ? 'c:' + p.code : 'n:' + normText(p.name);
const CAT_FMT = 2;      // формат каталога на телефоне: 2 = с закупочными ценами. Если на телефоне формат старее, прайс при ближайшей проверке разбирается заново

/* Правки товаров из прайса (вкладка «Отчёты» → «Товары: цены и остаток»): ключ товара -> {price?, cost?, stock?, sts?, base:{…}}.
   base — значения в прайсе в тот момент, когда правку внесли. Если в новом прайсе значение стало другим, правка снимается и берётся прайс. */
const EDIT = new Map();
/* Значения товара: из прайса (fprice, fcost, fstock), поверх них ваши правки. sts — с какого момента считается остаток:
   время загрузки прайса или время, когда вы вписали остаток; всё проданное после этого момента вычитается */
function overlay(p) {
  const e = EDIT.get(p.key) || {}, m = CAT.meta;
  p.price = e.price != null ? e.price : p.fprice;
  p.cost = e.cost != null ? e.cost : p.fcost;
  if (e.stock != null) { p.stock = e.stock; p.sts = e.sts || 0; } else { p.stock = p.fstock; p.sts = (m && m.loadedAt) || 0; }
  p.edited = e.price != null || e.cost != null || e.stock != null;
}
function setCatalog(arr, meta) {
  CAT.meta = meta || null; CAT.skipped = [];
  // Штрихкод уже внесён вручную: в базе телефона остаётся ручной товар, а товар из прайса не заносится.
  // В сохранённом списке (arr) он остаётся: если ручной товар удалят, товар из прайса вернётся
  const keep = [];
  for (const a of arr) {
    if (EXTRA.size && [...a[4], ...(a[6] || [])].some(b => EXTRA.has(b))) CAT.skipped.push({ code: a[0], name: a[1] });
    else keep.push(a);
  }
  CAT.products = keep.map((a, i) => ({ i, code: a[0], name: a[1], fprice: a[2], unit: a[3], bcs: a[4], plu: a[5], shared: a[6] || [], fcost: a[7] == null ? null : a[7], fstock: a[8] == null ? null : a[8] }));
  CAT.names = CAT.products.map(p => normText(p.name));
  CAT.byBc = new Map(); CAT.byPlu = new Map(); CAT.byKey = new Map(); CAT.dups = new Map(); CAT.bcList = [];
  for (const p of CAT.products) {
    p.key = pkey(p); overlay(p);
    CAT.byKey.set(p.key, p);
    for (const b of p.bcs) { CAT.byBc.set(b, p); CAT.bcList.push(b); }
    if (p.plu) CAT.byPlu.set(p.plu, p);
  }
  // штрихкоды, которые в прайсе закреплены за несколькими товарами: при сканировании спросим, какой товар перед кассиром
  for (const p of CAT.products) for (const b of p.shared) {
    let l = CAT.dups.get(b);
    if (!l) { l = []; const o = CAT.byBc.get(b); if (o) l.push(o); CAT.dups.set(b, l); }
    if (!l.includes(p)) l.push(p);
  }
}
/* Новый прайс и правки: правка остаётся, пока в прайсе это значение не изменилось. Изменилось: берётся значение из прайса */
function reconcileEdits(products) {
  const byKey = new Map(products.map(p => [pkey(p), p]));
  for (const [k, e] of [...EDIT]) {
    const p = byKey.get(k); if (!p) continue;              // товара в новом прайсе нет: правка ждёт, вдруг он вернётся
    const b = e.base || {};
    for (const f of ['price', 'cost', 'stock']) {
      if (e[f] == null) continue;
      if ((p[f] == null ? null : p[f]) !== (b[f] == null ? null : b[f])) { delete e[f]; delete b[f]; if (f === 'stock') delete e.sts; }
    }
    if (e.price == null && e.cost == null && e.stock == null) EDIT.delete(k);
  }
}
async function loadEdits() {
  const o = (await kvGet('edits')) || {};
  EDIT.clear();
  for (const [k, v] of Object.entries(o)) EDIT.set(k, v);
}
async function loadCatalogFromDB() {
  const arr = await kvGet('catalog');
  if (arr && arr.length) { setCatalog(arr, await kvGet('catmeta')); return true; }
  return false;
}
async function loadExtra() {
  const o = (await kvGet('extra')) || {};
  EXTRA.clear();
  for (const [bc, v] of Object.entries(o)) EXTRA.set(bc, v);
}
async function loadPluMap() {
  const o = (await kvGet('pluMap')) || {};
  PLUMAP.clear();
  for (const [k, v] of Object.entries(o)) PLUMAP.set(+k, v);
}
const savePluMap = () => kvSet('pluMap', Object.fromEntries(PLUMAP)).catch(() => { });
/* Товар по номеру на весах: сначала столбец PLU из прайса, затем то, что запомнил кассир */
function pluProduct(plu) {
  return CAT.byPlu.get(plu) || (PLUMAP.has(plu) ? CAT.byKey.get(PLUMAP.get(plu)) : null) || null;
}

/* Сохранить результат разбора прайса */
async function applyResult(res, meta, manual) {
  if (res.error) throw new Error(res.error);
  const n = res.products.length, prev = CAT.products.length;
  if (!n) throw new Error('В файле нет ни одного товара');
  if (!manual && prev > 100 && n < prev * 0.5)
    throw new Error('Новый прайс отклонён: в нём ' + n + ' товаров, а было ' + prev + '. Оставлен прежний.');
  const arr = res.products.map(p => [p.code, p.name, p.price, p.unit, p.bcs, p.plu, p.shared, p.cost == null ? null : p.cost, p.stock == null ? null : p.stock]);
  const m = Object.assign({}, meta, { loadedAt: Date.now(), checkedAt: Date.now(), count: n, sheet: res.sheet || '', fmt: CAT_FMT, report: liteReport(res.report) });
  reconcileEdits(res.products);
  await kvSet('catalog', arr);
  await kvSet('catmeta', m);
  await kvSet('edits', Object.fromEntries(EDIT));
  setCatalog(arr, m);      // товары, чей штрихкод уже внесён вручную, в базу телефона не попадают: ручной товар главнее
  return res.report;
}
const applyCatalogText = (text, meta, manual) => applyResult(buildCatalog(parseCSV(text)), meta, manual);
const applyCatalogBuffer = async (buf, meta, manual) => applyResult(await buildCatalogFromBuffer(buf), meta, manual);

/* Прайс из «демо»-файла, который лежит в папке приложения для проверки: показываем это в шапке, чтобы его не приняли за свой */
const isDemoCatalog = () => CAT.products.length > 0 && CAT.products.length <= 20 && CAT.products.every(p => /^демо/i.test(p.name));

/* Скачать один файл прайса. probing = ищем файл рядом с приложением: «нет такого файла» (404 или страница вместо файла) даёт null, а не ошибку */
async function fetchPrice(url, probing) {
  const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), CFG.SYNC_TIMEOUT_MS);
  try {
    const r = await fetch(url, { cache: 'no-cache', signal: ctl.signal });
    if (probing && (r.status === 404 || r.status === 410)) return null;
    if (!r.ok) throw new Error('сервер ответил ' + r.status + (r.status === 404 ? ' (по этому адресу файла нет)' : ''));
    if (probing && /text\/html/i.test(r.headers.get('content-type') || '')) return null;   // некоторые серверы на «нет файла» отдают главную страницу
    return { buf: await r.arrayBuffer(), lastModified: r.headers.get('last-modified') || '' };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('нет ответа (вероятно, нет интернета)');
    if (e instanceof TypeError) throw new Error('не удалось скачать файл: нет интернета или адрес указан неверно');
    throw e;
  } finally { clearTimeout(to); }
}

/* Скачать прайс: по адресу из настроек, а если он пуст, то prices.xlsx (выгрузка как есть) или prices.csv рядом с приложением.
   Если файл найден, но не читается, запасной вариант НЕ берём: иначе старый или демонстрационный файл молча подменил бы свежий. */
async function syncCatalog(force) {
  const custom = await kvGet('priceUrl'), urls = custom ? [custom] : CFG.PRICE_URLS;
  let got = null, url = '';
  for (const u of urls) {
    const g = await fetchPrice(u, !custom);
    if (g) { got = g; url = u; break; }
  }
  if (!got) throw new Error('на сервере нет файла прайса (нужен ' + CFG.PRICE_URLS.join(' или ') + ' рядом с приложением)');
  const hash = hashBuf(got.buf), m = CAT.meta;
  if (!force && m && m.hash === hash && m.source === url && m.fmt === CAT_FMT && CAT.products.length) {
    m.checkedAt = Date.now(); await kvSet('catmeta', m);
    return { same: true };
  }
  const rep = await applyCatalogBuffer(got.buf, { hash, source: url, lastModified: got.lastModified }, false);
  return { updated: true, rep };
}

/* ---------- поиск и распознавание кода ---------- */
function ean13ok(c) {
  let s = 0; for (let i = 0; i < 12; i++) s += (+c[i]) * (i % 2 ? 3 : 1);
  return (10 - s % 10) % 10 === +c[12];
}
const bcProducts = b => CAT.dups.get(b) || (CAT.byBc.has(b) ? [CAT.byBc.get(b)] : []);

/* Подсказки при вводе: по штрихкоду (целиком или по последним цифрам), по номеру на весах и по названию */
function searchProducts(q, limit) {
  limit = limit || 15;
  const qn = normText(q);
  if (!qn) return [];
  const out = [], seen = new Set();
  const add = (p, bc) => { if (p && !seen.has(p.i)) { seen.add(p.i); out.push({ p, bc }); } };
  if (/^\d+$/.test(qn)) {
    const nb = normBC(qn);
    for (const p of bcProducts(nb)) add(p, nb);
    if (qn.length <= 6) {
      const wp = pluProduct(+qn);
      if (wp) add(wp, 'PLU ' + (+qn));
    }
    if (qn.length >= 3 && out.length < limit) {
      for (const b of CAT.bcList) {
        if (b.endsWith(nb) || (qn.length >= 5 && b.includes(nb))) { for (const p of bcProducts(b)) add(p, b); if (out.length >= limit) break; }
      }
    }
    if (out.length) return out;
  }
  const toks = qn.split(' '), hits = [];
  for (let i = 0; i < CAT.names.length; i++) {
    const nm = CAT.names[i]; let ok = true;
    for (let k = 0; k < toks.length; k++) if (!nm.includes(toks[k])) { ok = false; break; }
    if (ok) { hits.push(i); if (hits.length >= 400) break; }
  }
  hits.sort((a, b) => {
    const na = CAT.names[a], nb2 = CAT.names[b];
    const sa = na.startsWith(qn) ? 0 : (na.includes(' ' + toks[0]) ? 1 : 2);
    const sb = nb2.startsWith(qn) ? 0 : (nb2.includes(' ' + toks[0]) ? 1 : 2);
    return sa - sb || na.length - nb2.length;
  });
  for (const i of hits) { add(CAT.products[i]); if (out.length >= limit) break; }
  return out;
}

/* Что за код: товар, несколько товаров (спорный штрихкод), весовая этикетка или неизвестный.
   Весовая этикетка: 2 + номер товара на весах (6 цифр) + вес в граммах (5 цифр) + контрольная цифра */
function lookupCode(text) {
  const raw = String(text || '').trim(), nb = normBC(raw);
  if (!nb) return null;
  const d = CAT.dups.get(nb);
  if (d && d.length > 1) return { choose: d, bc: nb };
  const p = CAT.byBc.get(nb);
  if (p) return { p, bc: nb };
  const ex = EXTRA.get(nb);
  if (ex) return { extra: ex, bc: nb };
  const c = raw.replace(/\s+/g, '');
  if (/^\d{13}$/.test(c) && c[0] === '2' && c[1] === '0' && ean13ok(c)) {
    const plu = parseInt(c.slice(1, 7), 10), g = parseInt(c.slice(7, 12), 10);
    if (plu > 0 && g > 0) {
      const wp = pluProduct(plu);
      return wp ? { p: wp, weight: g / 1000, bc: c } : { weightOnly: g / 1000, plu, bc: c };
    }
  }
  return { none: true, bc: nb, raw };
}

/* ---------- состояние ---------- */
const S = { lines: [], pending: null, undo: null, tab: 'kassa', view: 'sum', scanning: false, lastCode: '', lastCodeAt: 0 };

/* ---------- всплывашки ---------- */
let toastT;
function hideToast() { $('#toast').classList.remove('show'); }
function toast(text, btn, fn, ms) {
  $('#toastText').textContent = text;
  const b = $('#toastBtn');
  if (btn) { b.textContent = btn; b.style.display = ''; b.onclick = () => { hideToast(); fn && fn(); }; } else b.style.display = 'none';
  $('#toast').classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(hideToast, ms || (btn ? 8000 : 3500));
}
const sheetOpen = () => $('#ov').classList.contains('show');
function openSheet(html) { $('#sheet').innerHTML = html; $('#ov').classList.add('show'); }
function closeSheet() { if (repScanner || $('#reader2')) stopRepScan(); $('#ov').classList.remove('show'); $('#sheet').innerHTML = ''; }
$('#ov').addEventListener('click', e => { if (e.target.id === 'ov') closeSheet(); });
function confirmSheet(title, text, okLabel, onOk, danger) {
  openSheet(`<h2>${esc(title)}</h2><p class="muted">${esc(text)}</p><div class="btns"><button class="btn sec" id="shNo">Отмена</button><button class="btn ${danger ? 'danger' : 'primary'}" id="shYes">${esc(okLabel)}</button></div>`);
  $('#shNo').onclick = closeSheet;
  $('#shYes').onclick = () => { closeSheet(); onOk(); };
}

/* ---------- чек ---------- */
function calcLine(l) {
  if (!l.weighted || l.driver === 'weight') l.sum = r2((l.price || 0) * l.qty);
  else l.qty = l.price ? r3(l.sum / l.price) : 0;
}
const cartTotal = () => r2(S.lines.reduce((a, l) => a + l.sum, 0));
const saveDraft = debounce(() => kvSet('draft', S.lines).catch(() => { }), 250);

function lineHtml(l) {
  const priceTxt = l.price ? money(l.price) + (l.weighted ? ' сом/кг' : '') : 'цена?';
  const pc = !l.price ? 'none' : (l.changed ? 'changed' : '');
  const tags = (l.unknown ? '<span class="tag">нет в прайсе</span>' : '') + (l.changed ? '<span class="tag">цена изменена</span>' : '');
  const val = v => v ? String(v).replace('.', ',') : '';
  let top = `<button class="price ${pc}" data-a="price">${priceTxt}</button>`, bottom = '';
  if (l.weighted) {
    bottom = `<div class="wbox"><label>Сумма, сом<input data-a="s" inputmode="decimal" placeholder="с этикетки" value="${val(l.sum)}"></label><label>Вес, кг<input data-a="w" inputmode="decimal" placeholder="0,000" value="${val(l.qty)}"></label></div>`;
  } else {
    top += `<div class="qty"><button data-a="minus" ${l.qty <= 1 ? 'disabled' : ''}>−</button><input data-a="qty" inputmode="numeric" value="${l.qty}"><button data-a="plus">+</button></div><div class="lsum">${money(l.sum)}</div>`;
  }
  return `<div class="line" data-id="${l.id}"><div class="top"><div class="nm">${esc(l.name)}${tags}</div><button class="rm" data-a="rm" aria-label="Убрать">×</button></div><div class="row">${top}</div>${bottom}</div>`;
}
function renderCart() {
  const pend = S.pending ? `<div class="banner warn"><div>Весовая этикетка: ${esc(sp(nf3.format(S.pending.weight)))} кг, номер на весах ${S.pending.plu}. Приложение не знает этот номер. Найдите товар по названию выше: вес подставится сам, а номер можно будет запомнить.</div><button class="btn sec small" style="margin-top:8px" data-a="pendCancel">Отмена</button></div>` : '';
  $('#cart').innerHTML = pend + (S.lines.length ? S.lines.map(lineHtml).join('') : '<div class="empty">Наведите камеру на штрихкод или введите название товара</div>');
  $('#total').textContent = money(cartTotal());
  $('#cnt').textContent = 'Позиций: ' + S.lines.length;
  $('#btnSell').disabled = !S.lines.length;
}
function afterCartChange(focusId) {
  renderCart(); saveDraft();
  if (focusId) {
    const l = S.lines.find(x => x.id === focusId);
    if (l && l.weighted && !l.sum) { const i = $(`.line[data-id="${focusId}"] input[data-a="s"]`); if (i) i.focus(); }
  }
}
function moveTop(l) { S.lines = [l, ...S.lines.filter(x => x !== l)]; }

/* Незнакомая весовая этикетка: кассир нашёл товар по названию. Предлагаем запомнить связь «номер на весах = товар»,
   чтобы в следующий раз этикетка распознавалась сама. Сами не запоминаем: ошибочный выбор потом продавал бы не тот товар. */
function offerRemember(plu, p) {
  if (!plu || !p.key || PLUMAP.get(plu) === p.key) return;
  toast('Номер ' + plu + ' на весах — это «' + p.name.slice(0, 34) + '»?', 'Запомнить', () => {
    PLUMAP.set(plu, p.key); savePluMap();
    toast('Запомнил: номер ' + plu + ' = ' + p.name.slice(0, 34));
  }, 10000);
}
function addProduct(p, o) {
  o = o || {};
  const w = p.unit === 'кг', pend = S.pending, fromPending = !!(pend && w && !o.weight);
  if (fromPending) o.weight = pend.weight;
  S.pending = null;
  if (!w) {
    const ex = S.lines.find(l => !l.weighted && !l.unknown && l.code === p.code && l.name === p.name);
    if (ex) { ex.qty += 1; calcLine(ex); moveTop(ex); afterCartChange(); return ex; }
  }
  const l = { id: uid(), code: p.code, name: p.name, unit: p.unit, price: p.price, origPrice: p.price, weighted: w, qty: w ? (o.weight || 0) : 1, sum: 0, driver: 'weight', bc: o.bc || '', cost: p.cost == null ? null : p.cost, unknown: false, changed: false };
  calcLine(l); S.lines.unshift(l);
  afterCartChange(l.id);
  if (fromPending) offerRemember(pend.plu, p);
  return l;
}

/* штрихкод закреплён за несколькими товарами: показываем варианты, кассир выбирает тот, что в руках */
function chooseProduct(list, bc, onPick) {       // onPick: что сделать с выбранным товаром (по умолчанию добавить в чек)
  const priceOf = p => (p.price ? money(p.price) + (p.unit === 'кг' ? ' сом/кг' : ' сом') : 'без цены');
  openSheet(`<h2>Какой это товар?</h2><p class="muted">Штрихкод ${esc(bc)} в прайсе указан у ${list.length} товаров. Выберите тот, что перед вами.</p>`
    + list.map((p, i) => `<button class="pick" data-i="${i}"><span class="n">${esc(p.name)}</span><span class="m">${esc(priceOf(p))}</span></button>`).join('')
    + '<div class="btns"><button class="btn sec" id="shNo">Отмена</button></div>');
  $('#shNo').onclick = closeSheet;
  $$('#sheet .pick').forEach(b => b.onclick = () => { const p = list[+b.dataset.i]; closeSheet(); if (onPick) onPick(p); else { addProduct(p, { bc }); feedback(true); } });
}
function addExtra(bc, ex) {
  const old = S.lines.find(l => l.unknown && l.bc && l.bc === bc);
  if (old) { old.qty += 1; calcLine(old); moveTop(old); afterCartChange(); return; }
  const l = { id: uid(), code: '', name: ex.name, unit: 'шт', price: ex.price, origPrice: ex.price, weighted: false, qty: 1, sum: 0, driver: 'weight', bc: bc || '', cost: ex.cost == null ? null : ex.cost, unknown: true, changed: false };
  calcLine(l); S.lines.unshift(l); afterCartChange();
}
function removeLine(l) {
  const idx = S.lines.indexOf(l);
  S.lines.splice(idx, 1); afterCartChange();
  toast('Убрано: ' + l.name.slice(0, 40), 'Вернуть', () => { S.lines.splice(Math.min(idx, S.lines.length), 0, l); afterCartChange(); });
}

/* цена в строке */
function editPrice(l) {
  openSheet(`<h2>Цена за ${l.weighted ? '1 кг' : '1 шт'}</h2><p class="muted">${esc(l.name)}</p>
    <label>Цена, сом</label><input id="pIn" inputmode="decimal" value="${l.price ? String(l.price).replace('.', ',') : ''}">
    ${l.origPrice && l.changed ? `<p class="muted">По прайсу: ${money(l.origPrice)}</p>` : ''}
    <div class="btns"><button class="btn sec" id="shNo">Отмена</button>${l.origPrice && l.changed ? '<button class="btn sec" id="pRes">Как в прайсе</button>' : ''}<button class="btn primary" id="pOk">Готово</button></div>`);
  const inp = $('#pIn'); inp.focus(); inp.select();
  const apply = v => { l.price = v; l.changed = !l.unknown && !!l.origPrice && v !== l.origPrice; calcLine(l); closeSheet(); afterCartChange(); };
  $('#shNo').onclick = closeSheet;
  if ($('#pRes')) $('#pRes').onclick = () => apply(l.origPrice);
  $('#pOk').onclick = () => { const v = r2(num(inp.value)); if (v > 0) apply(v); else toast('Введите цену больше нуля'); };
  inp.onkeydown = e => { if (e.key === 'Enter') $('#pOk').click(); };
}

/* товар, которого нет в прайсе */
function openUnknown(bc, raw, nameHint) {
  const code = bc && bc.length >= 3 ? bc : '';
  openSheet(`<h2>Товара нет в прайсе</h2>${code ? `<p class="muted">Штрихкод: ${esc(raw || code)}</p>` : ''}
    <label>Название</label><input id="uName" value="${esc(nameHint || '')}" autocomplete="off">
    <label>Розничная цена за 1 шт, сом</label><input id="uPrice" inputmode="decimal">
    <label>Закупочная цена за 1 шт, сом (необязательно)</label><input id="uCost" inputmode="decimal">
    ${code ? '<label style="display:flex;gap:8px;align-items:center;color:inherit;font-size:15px"><input type="checkbox" id="uSave" checked style="width:22px;height:22px">Запомнить на этом телефоне</label>' : ''}
    <div class="btns"><button class="btn sec" id="shNo">Отмена</button><button class="btn primary" id="uOk">Добавить в чек</button></div>`);
  $('#shNo').onclick = closeSheet;
  setTimeout(() => $(nameHint ? '#uPrice' : '#uName').focus(), 50);
  $('#uOk').onclick = async () => {
    const name = $('#uName').value.trim(), price = r2(num($('#uPrice').value)), costRaw = $('#uCost').value.trim(), cost = costRaw ? r4(num(costRaw)) : null;
    if (!name || !(price > 0)) { toast('Укажите название и розничную цену'); return; }
    if (costRaw && !(cost > 0)) { toast('Закупочная цена: впишите число больше нуля или оставьте поле пустым'); return; }
    if (code && $('#uSave') && $('#uSave').checked) { EXTRA.set(code, { name, price, unit: 'шт', cost }); kvSet('extra', Object.fromEntries(EXTRA)).catch(() => { }); }
    closeSheet(); addExtra(code, { name, price, cost });
  };
}

/* ---------- ввод: штрихкод / название ---------- */
const qEl = $('#q'), sgEl = $('#suggest');
let sgItems = [];
function hideSuggest() { sgEl.style.display = 'none'; sgItems = []; }
function clearQuery() { qEl.value = ''; $('#qClear').style.display = 'none'; hideSuggest(); qEl.blur(); }
function showSuggest() {
  const q = qEl.value;
  $('#qClear').style.display = q ? 'block' : 'none';
  if (!q.trim()) { hideSuggest(); return; }
  sgItems = searchProducts(q, 15);
  const meta = r => (r.p.price ? money(r.p.price) + (r.p.unit === 'кг' ? ' сом/кг' : ' сом') : 'без цены') + (r.bc ? ' · ' + r.bc : '');
  sgEl.innerHTML = sgItems.map((r, i) => `<div class="it" data-i="${i}"><div class="n">${esc(r.p.name)}</div><div class="m">${esc(meta(r))}</div></div>`).join('')
    + (/\D/.test(q) ? `<div class="it" data-i="manual"><div class="n">＋ Добавить вручную: «${esc(q.trim())}»</div><div class="m">если товара нет в списке</div></div>` : '');
  sgEl.style.display = sgItems.length || /\D/.test(q) ? 'block' : 'none';
  // список не должен уходить под экранную клавиатуру: ограничиваем высоту видимой частью экрана
  const vv = window.visualViewport, top = sgEl.getBoundingClientRect().top;
  const avail = (vv ? vv.offsetTop + vv.height : window.innerHeight) - top - 8;
  sgEl.style.maxHeight = Math.max(110, Math.min(avail, window.innerHeight * 0.5)) + 'px';
}
function pickSuggest(i) {
  if (i === 'manual') { const t = qEl.value.trim(); clearQuery(); openUnknown('', '', t); return; }
  const r = sgItems[+i]; if (!r) return;
  clearQuery(); addProduct(r.p, { bc: /^PLU/.test(r.bc || '') ? '' : (r.bc || '') });
}
qEl.addEventListener('input', debounce(showSuggest, 90));
qEl.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const q = qEl.value.trim(); if (!q) return;
  e.preventDefault();
  if (/^\d{8,}$/.test(q.replace(/\s+/g, ''))) { clearQuery(); handleCode(q); }
  else if (sgItems.length) pickSuggest(0);
  else if (/^\d+$/.test(q)) { clearQuery(); handleCode(q); }
});
sgEl.addEventListener('click', e => { const it = e.target.closest('.it'); if (it) pickSuggest(it.dataset.i); });
$('#qClear').addEventListener('click', () => { clearQuery(); qEl.focus(); });
document.addEventListener('click', e => { if (!e.target.closest('.searchRow')) hideSuggest(); });

/* штрихкод пришёл с камеры или набран руками */
function handleCode(text) {
  const r = lookupCode(text);
  if (!r) return;
  if (r.choose) { feedback(false); chooseProduct(r.choose, r.bc); }
  else if (r.p) { addProduct(r.p, { bc: r.bc, weight: r.weight }); feedback(true); }
  else if (r.extra) { addExtra(r.bc, r.extra); feedback(true); }
  else if (r.weightOnly) { S.pending = { weight: r.weightOnly, plu: r.plu }; renderCart(); feedback(false); qEl.focus(); }
  else { feedback(false); openUnknown(r.bc, r.raw); }
}

/* ---------- кнопки чека ---------- */
$('#cart').addEventListener('focusin', e => { if (e.target.matches('input')) setTimeout(() => e.target.select(), 0); });
$('#cart').addEventListener('click', e => {
  const b = e.target.closest('[data-a]'); if (!b) return;
  if (b.dataset.a === 'pendCancel') { S.pending = null; renderCart(); return; }
  const el = b.closest('.line'), l = el && S.lines.find(x => x.id === el.dataset.id);
  if (!l) return;
  const a = b.dataset.a;
  if (a === 'plus') { l.qty += 1; calcLine(l); afterCartChange(); }
  else if (a === 'minus') { if (l.qty > 1) { l.qty -= 1; calcLine(l); afterCartChange(); } }
  else if (a === 'rm') removeLine(l);
  else if (a === 'price') editPrice(l);
});
$('#cart').addEventListener('change', e => {
  const i = e.target, a = i.dataset && i.dataset.a, el = i.closest && i.closest('.line');
  if (!a || !el) return;
  const l = S.lines.find(x => x.id === el.dataset.id); if (!l) return;
  if (a === 'qty') { l.qty = Math.max(1, Math.round(num(i.value)) || 1); calcLine(l); }
  else if (a === 'w') { l.qty = r3(Math.max(0, num(i.value))); l.driver = 'weight'; calcLine(l); }
  else if (a === 's') { l.sum = r2(Math.max(0, num(i.value))); l.driver = 'sum'; calcLine(l); }
  afterCartChange();
});
$('#btnClear').addEventListener('click', () => {
  if (!S.lines.length) return;
  confirmSheet('Очистить чек?', 'Все позиции текущего чека будут убраны.', 'Очистить', () => { S.lines = []; S.pending = null; afterCartChange(); }, true);
});
$('#btnSell').addEventListener('click', () => sell());

/* ---------- сессии и продажи ---------- */
const HOUR = 3600e3, DAY = 864e5;
const hm = ms => { if (ms < 60e3) return 'менее минуты'; const m = Math.floor(ms / 60e3); return (m >= 60 ? Math.floor(m / 60) + ' ч ' : '') + (m % 60) + ' мин'; };

/* Сессия закрывается сама каждый день в 23:59 (по часам телефона): в ближайшие 23:59 после её начала */
const nextClose = ts => {
  const d = new Date(ts); d.setHours(CFG.CLOSE_HOUR, CFG.CLOSE_MIN, 0, 0);
  if (d.getTime() <= ts) d.setDate(d.getDate() + 1);
  return d.getTime();
};
const closeLabel = () => pad(CFG.CLOSE_HOUR) + ':' + pad(CFG.CLOSE_MIN);
async function autoCloseSessions(now) {
  now = now || Date.now(); let ch = false;
  for (const s of await DB.all('sessions')) {
    if (s.closedAt) continue;
    const at = nextClose(s.startedAt);
    if (now >= at) { s.closedAt = at; s.closedBy = 'auto'; await DB.put('sessions', s); ch = true; }
  }
  return ch;
}
const openSession = async () => (await DB.all('sessions')).find(s => !s.closedAt) || null;

async function cleanupOld(now) {
  now = now || Date.now();
  for (const s of await DB.all('sessions')) {
    if (s.closedAt && now - s.closedAt > CFG.KEEP_DAYS * DAY) {
      for (const sl of await DB.bySession(s.id)) await DB.del('sales', sl.id);
      await DB.del('sessions', s.id);
    }
  }
}

async function sell() {
  if (S.selling) return;                                // второе нажатие «Продать» не должно записать продажу ещё раз
  S.selling = true;
  try { await sellInner(); } finally { S.selling = false; }
}
async function sellInner() {
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  await new Promise(r => setTimeout(r, 40));            // дать сработать «change» у поля
  if (!S.lines.length) return;
  const bad = S.lines.find(l => !(l.price > 0) || !(l.sum > 0) || !(l.qty > 0));
  if (bad) { toast('Проверьте строку «' + bad.name.slice(0, 36) + '»: цена, вес или сумма'); return; }
  const now = Date.now();
  await autoCloseSessions(now);
  let s = await openSession(), created = null;
  if (!s) { s = { id: uid(), startedAt: now, closedAt: null, closedBy: null }; await DB.put('sessions', s); created = s.id; }
  const sale = {
    id: uid(), sessionId: s.id, ts: now, status: 'ok', total: cartTotal(),
    lines: S.lines.map(l => ({ code: l.code, name: l.name, unit: l.unit, price: l.price, origPrice: l.origPrice, qty: l.qty, sum: l.sum, changed: l.changed, unknown: l.unknown, bc: l.bc, cost: l.cost == null ? null : l.cost }))
  };
  await DB.put('sales', sale);
  const snapshot = S.lines;
  S.lines = []; S.pending = null; afterCartChange();
  S.undo = { saleId: sale.id, lines: snapshot, createdSession: created };
  toast('Продано на ' + money(sale.total) + ' сом', 'Вернуть', undoSale, 8000);
  refreshSessionUI();
}
async function undoSale() {
  const u = S.undo; if (!u) return; S.undo = null;
  await DB.del('sales', u.saleId);
  if (u.createdSession) await DB.del('sessions', u.createdSession);
  S.lines = [...S.lines, ...u.lines]; afterCartChange(); refreshSessionUI();
}
async function cancelSale(id) {
  const s = await DB.get('sales', id); if (!s || s.status !== 'ok') return;
  s.status = 'cancelled'; s.cancelledAt = Date.now(); await DB.put('sales', s);
  toast('Продажа отменена и не входит в итог'); refreshSessionUI();
}
async function closeSession() {
  const s = await openSession(); if (!s) return;
  s.closedAt = Date.now(); s.closedBy = 'manual'; await DB.put('sessions', s);
  S.undo = null; toast('Сессия закрыта. Новые продажи пойдут в новую сессию'); refreshSessionUI();
}

/* ---------- сводка ---------- */
function summarize(sales) {
  const m = new Map(); let total = 0, n = 0;
  for (const sl of sales) {
    if (sl.status !== 'ok') continue;
    n++; total += sl.total;
    for (const l of sl.lines) {
      const k = (l.code || 'u:' + (l.bc || l.name)) + '|' + l.price + '|' + l.unit;
      let e = m.get(k);
      if (!e) { e = { name: l.name, unit: l.unit, price: l.price, changed: l.changed, unknown: l.unknown, qty: 0, sum: 0 }; m.set(k, e); }
      e.qty += l.qty; e.sum += l.sum;
    }
  }
  const rows = [...m.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  rows.forEach(r => { r.qty = r3(r.qty); r.sum = r2(r.sum); });
  return { rows, total: r2(total), n };
}
const tagsHtml = l => (l.changed ? '<span class="tag">цена изменена</span>' : '') + (l.unknown ? '<span class="tag">нет в прайсе</span>' : '');
function summaryHtml(sum) {
  if (!sum.n) return '<p class="muted">Продаж пока нет.</p>';
  return '<table class="sum">' + sum.rows.map(r => `<tr><td>${esc(r.name)}${tagsHtml(r)}</td><td>${esc(qtyText(r.qty, r.unit))}</td><td>${money(r.sum)}</td></tr>`).join('')
    + `<tr class="tot"><td>Итого</td><td></td><td>${money(sum.total)}</td></tr></table>`;
}
function salesHtml(sales, canCancel) {
  if (!sales.length) return '<p class="muted">Продаж нет.</p>';
  return sales.slice().sort((a, b) => b.ts - a.ts).map(sl => `<div class="card sale ${sl.status === 'ok' ? '' : 'cancelled'}">
    <div class="hd"><div><b>${money(sl.total)} сом</b> <span class="muted">${fmtTime(sl.ts)} · ${sl.lines.length} поз.${sl.status === 'ok' ? '' : ' · отменена'}</span></div>
    ${canCancel && sl.status === 'ok' ? `<button class="btn sec small" data-cancel="${sl.id}">Отменить</button>` : ''}</div>
    <ul>${sl.lines.map(l => `<li><span>${esc(l.name)}${tagsHtml(l)}</span><span>${esc(qtyText(l.qty, l.unit))} · ${money(l.sum)}</span></li>`).join('')}</ul></div>`).join('');
}

/* ---------- вкладки «Сессия» и «История» ---------- */
async function renderSession() {
  const pane = $('#sessionPane'), s = await openSession();
  if (!s) {
    pane.innerHTML = '<div class="card"><h3>Открытой сессии нет</h3><p class="muted">Она появится после первой продажи. Продажи сессии нужно внести в кассу магазина, когда она заработает, и закрыть сессию.</p></div>';
    return;
  }
  const sales = await DB.bySession(s.id), sum = summarize(sales);
  const left = nextClose(s.startedAt) - Date.now();
  pane.innerHTML = `<div class="banner warn">Внесите эти продажи в кассу магазина и закройте сессию. Открыта с ${fmtDT(s.startedAt)}, закроется автоматически в ${closeLabel()} (через ${hm(left)}): после этого её продажи считаются внесёнными.</div>
    <div class="card"><div class="totalRow"><span>Продаж: ${sum.n}</span><div style="font-size:28px;font-weight:800">${money(sum.total)} сом</div></div></div>
    <div class="seg"><button data-v="sum" class="${S.view === 'sum' ? 'active' : ''}">Итого по товарам</button><button data-v="each" class="${S.view === 'each' ? 'active' : ''}">По отдельности</button></div>
    ${S.view === 'sum' ? '<div class="card">' + summaryHtml(sum) + '</div>' : salesHtml(sales, true)}
    <button class="btn primary" style="width:100%;margin-top:6px;font-size:17px" id="btnClose">Закрыть сессию: всё внесено в кассу</button>`;
}
async function renderHistory() {
  const pane = $('#historyPane');
  const ss = (await DB.all('sessions')).filter(s => s.closedAt).sort((a, b) => b.closedAt - a.closedAt);
  if (!ss.length) { pane.innerHTML = `<div class="card"><h3>История пуста</h3><p class="muted">Здесь будут закрытые сессии за последние ${CFG.KEEP_DAYS} дн.</p></div>`; return; }
  let html = `<p class="muted" style="margin:0 2px 8px">Закрытые сессии хранятся ${CFG.KEEP_DAYS} дн.</p>`;
  for (const s of ss) {
    const sum = summarize(await DB.bySession(s.id));
    html += `<button class="hist" data-sid="${s.id}"><b>${fmtDT(s.startedAt)} – ${fmtDT(s.closedAt)}</b><br><span class="muted">${sum.n} продаж · ${money(sum.total)} сом · ${s.closedBy === 'auto' ? 'закрыта автоматически' : 'закрыта вручную'}</span></button>`;
  }
  pane.innerHTML = html;
}
async function openHistoryItem(id) {
  const s = await DB.get('sessions', id); if (!s) return;
  const sales = await DB.bySession(id), sum = summarize(sales);
  openSheet(`<h2>${fmtDT(s.startedAt)} – ${fmtDT(s.closedAt)}</h2>
    <p class="muted">${sum.n} продаж · ${money(sum.total)} сом · ${s.closedBy === 'auto' ? 'закрыта автоматически' : 'закрыта вручную'}</p>
    <h3 style="margin:12px 0 6px">Итого по товарам</h3><div class="card">${summaryHtml(sum)}</div>
    <h3 style="margin:12px 0 6px">Продажи по отдельности</h3>${salesHtml(sales, false)}
    <div class="btns"><button class="btn sec" id="shNo">Закрыть</button></div>`);
  $('#shNo').onclick = closeSheet;
}
async function updateBadge() {
  const s = await openSession(); let n = 0;
  if (s) n = (await DB.bySession(s.id)).filter(x => x.status === 'ok').length;
  const b = $('#badge'); b.textContent = n; b.style.display = n ? '' : 'none';
}
async function refreshSessionUI() {
  await updateBadge();
  if (S.tab === 'session') await renderSession();
  if (S.tab === 'history') await renderHistory();
}
async function tick() {
  const ch = await autoCloseSessions();
  if (ch || S.tab === 'session') await refreshSessionUI(); else await updateBadge();
  await cleanupOld();
}

$('#sessionPane').addEventListener('click', e => {
  const v = e.target.closest('[data-v]'); if (v) { S.view = v.dataset.v; renderSession(); return; }
  const c = e.target.closest('[data-cancel]');
  if (c) { confirmSheet('Отменить продажу?', 'Она останется в истории с пометкой «отменена» и не войдёт в итог.', 'Отменить продажу', () => cancelSale(c.dataset.cancel), true); return; }
  if (e.target.closest('#btnClose'))
    confirmSheet('Закрыть сессию?', 'Продажи внесены в кассу магазина? После закрытия новые продажи пойдут в новую сессию.', 'Да, закрыть', closeSession, false);
});
$('#historyPane').addEventListener('click', e => { const h = e.target.closest('[data-sid]'); if (h) openHistoryItem(h.dataset.sid); });

/* ---------- вкладка «Отчёты» ---------- */
const REP = { view: 'rep', mode: 'today', from: '', to: '', sort: 'sum', q: '' };      // что открыто и выбранный период (помнится, пока приложение открыто)
let repSeq = 0, repRows = [], gItems = [];
const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const parseYmd = s => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '')); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
const fmtDate = d => pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear();
const dayStart = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const dayEnd = d => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime();
const r4 = x => Math.round((x + Number.EPSILON) * 10000) / 10000;

/* Выбранный период целыми днями: с 00:00 первого дня по 23:59:59 последнего */
function repRange(now) {
  const t = new Date(now || Date.now()), Y = t.getFullYear(), M = t.getMonth(), D = t.getDate();
  let a = new Date(Y, M, D), b = a;
  if (REP.mode === 'yesterday') a = b = new Date(Y, M, D - 1);
  else if (REP.mode === 'week') a = new Date(Y, M, D - 6);
  else if (REP.mode === 'month') a = new Date(Y, M, 1);
  else if (REP.mode === 'custom') {
    a = parseYmd(REP.from) || parseYmd(REP.to) || a; b = parseYmd(REP.to) || a;
    if (a > b) { const x = a; a = b; b = x; }
  }
  return { a, b, from: dayStart(a), to: dayEnd(b) };
}

/* Все действующие продажи за период (отменённые не входят). Читаются только те сессии, которые могли в него попасть */
async function loadPeriod(from, to) {
  const all = await DB.all('sessions');
  const ss = all.filter(s => s.startedAt <= to + DAY && (!s.closedAt || s.closedAt >= from - DAY));
  const parts = await Promise.all(ss.map(s => DB.bySession(s.id)));
  const sales = [];
  for (const part of parts) for (const sl of part) if (sl.status === 'ok' && sl.ts >= from && sl.ts <= to) sales.push(sl);
  sales.sort((x, y) => x.ts - y.ts);
  return { sales, oldest: all.length ? Math.min(...all.map(s => s.startedAt)) : null };
}

/* ---- какой товар стоит за строкой продажи ----
   Ключ: «c:код» и «n:название» — товар из прайса; «b:штрихкод» — внесённый вручную и запомненный; «u:название» — внесённый вручную и не запомненный */
const lineKey = l => l.unknown ? (l.bc ? 'b:' + l.bc : 'u:' + normText(l.name)) : (l.code ? 'c:' + l.code : 'n:' + normText(l.name));
function refByKey(k) {         // {kind:'f', p} — из прайса; {kind:'x', bc, x} — внесённый вручную; null — такого товара в телефоне нет
  if (k[0] === 'b') { const bc = k.slice(2), x = EXTRA.get(bc); return x ? { kind: 'x', bc, x } : null; }
  if (k[0] === 'u') return null;
  const p = CAT.byKey.get(k); return p ? { kind: 'f', p } : null;
}
const refObj = r => r.kind === 'x' ? r.x : r.p;
const refKey = r => r.kind === 'x' ? 'b:' + r.bc : r.p.key;

/* Закупочная цена за единицу: та, что в телефоне сейчас (из прайса или ваша правка), поэтому исправленная цена сразу меняет отчёт.
   Если товара в телефоне больше нет или цены у него нет, берётся записанная в самой продаже */
function lineCost(l) {
  const r = refByKey(lineKey(l)), o = r && refObj(r);
  if (o && o.cost != null) return o.cost;
  return l.cost != null ? l.cost : null;
}

/* Остаток сейчас = остаток из прайса (или вписанный вами) минус проданное в приложении после этого момента. Отменённые продажи не считаются */
async function stockInfo(keys) {
  const base = new Map(); let from = Infinity;
  for (const k of keys) {
    const r = refByKey(k), o = r && refObj(r);
    if (o && o.stock != null) { const ts = o.sts || 0; base.set(k, { v: o.stock, ts }); if (ts < from) from = ts; }
  }
  const out = new Map();
  if (!base.size) return out;
  const sold = new Map();
  const { sales } = await loadPeriod(from, Date.now() + DAY);
  for (const sl of sales) for (const l of sl.lines) {
    const k = lineKey(l), b = base.get(k);
    if (b && sl.ts > b.ts) sold.set(k, (sold.get(k) || 0) + l.qty);
  }
  for (const [k, b] of base) { const s = r3(sold.get(k) || 0); out.set(k, { v: b.v, ts: b.ts, sold: s, now: r3(b.v - s) }); }
  return out;
}
const stockText = (v, unit) => v == null ? '—' : sp(nf3.format(v)) + (unit === 'кг' ? ' кг' : ' шт');
const parseStock = s => { s = String(s).replace(/[\s ]/g, '').replace(/[−–—]/g, '-').replace(',', '.'); return /^-?\d+(\.\d+)?$/.test(s) ? r3(parseFloat(s)) : NaN; };

/* Отчёт 1: чеки, сумма продаж, средний чек */
function reportTotals(sales) {
  let total = 0; for (const s of sales) total += s.total;
  total = r2(total);
  return { n: sales.length, total, avg: sales.length ? r2(total / sales.length) : null };
}
/* Отчёт 2: по товарам. Себестоимость строки = сумма (количество × закупочная цена); если у какой-то продажи товара цены нет, у строки «—» */
function reportByProduct(sales, sort) {
  const m = new Map();
  for (const s of sales) for (const l of s.lines) {
    const k = lineKey(l), kk = k + '|' + l.unit;
    let e = m.get(kk);
    if (!e) { e = { k, name: l.name, unit: l.unit, qty: 0, sum: 0, cost: 0, known: true }; m.set(kk, e); }
    e.name = l.name; e.qty += l.qty; e.sum += l.sum;
    const c = lineCost(l);
    if (c == null) e.known = false; else e.cost += l.qty * c;
  }
  const rows = [...m.values()];
  for (const e of rows) { e.qty = r3(e.qty); e.sum = r2(e.sum); e.cost = e.known ? r2(e.cost) : null; }
  const byName = (a, b) => a.name.localeCompare(b.name, 'ru');
  rows.sort(sort === 'name' ? byName : (a, b) => b.sum - a.sum || byName(a, b));
  const costed = rows.filter(e => e.cost != null);
  return { rows, sum: r2(rows.reduce((a, e) => a + e.sum, 0)), cost: costed.length ? r2(costed.reduce((a, e) => a + e.cost, 0)) : null, noCost: rows.length - costed.length };
}

function repViewHtml() {
  return `<div class="seg"><button data-rv="rep" class="${REP.view === 'goods' ? '' : 'active'}">Отчёты</button><button data-rv="goods" class="${REP.view === 'goods' ? 'active' : ''}">Товары: цены и остаток</button></div>`;
}
function repControlsHtml() {
  const rg = repRange(), modes = [['today', 'Сегодня'], ['yesterday', 'Вчера'], ['week', '7 дней'], ['month', 'Месяц'], ['custom', 'Период']];
  return '<div class="chips">' + modes.map(([k, t]) => `<button data-rm="${k}" class="${REP.mode === k ? 'active' : ''}">${t}</button>`).join('') + '</div>'
    + (REP.mode === 'custom' ? `<div class="dates"><label>С<input type="date" id="repFrom" value="${ymd(rg.a)}"></label><label>По<input type="date" id="repTo" value="${ymd(rg.b)}"></label></div>` : '')
    + '<p class="rngTxt" id="repRange"></p>';
}
function repTablesHtml(sales, p, st) {
  const t = reportTotals(sales), na = '<span class="na">—</span>';
  repRows = p.rows;
  let h = '<div class="card"><h3>Итоги за период</h3><table class="rpt rpt1"><tbody>'
    + `<tr><td>Чеков</td><td>${sp(nf0.format(t.n))}</td></tr>`
    + `<tr><td>Сумма продаж, сом</td><td>${money(t.total)}</td></tr>`
    + `<tr><td>Средний чек, сом</td><td>${t.avg == null ? na : money(t.avg)}</td></tr></tbody></table></div>`
    + '<div class="card"><h3>Продажи по товарам</h3>';
  if (!p.rows.length) return h + '<p class="muted">За выбранный период продаж нет.</p></div>';
  h += `<div class="seg"><button data-rs="sum" class="${REP.sort === 'name' ? '' : 'active'}">Сначала крупные</button><button data-rs="name" class="${REP.sort === 'name' ? 'active' : ''}">По названию</button></div>`
    + '<div class="scrollx"><table class="rpt rpt2"><thead><tr><th>Товар</th><th>Продано</th><th>Себесто&shy;имость, сом</th><th>Розничная сумма, сом</th><th>Остаток</th></tr></thead><tbody>'
    + p.rows.map((r, i) => { const s = st.get(r.k); return `<tr data-ri="${i}"><td>${esc(r.name)}</td><td>${esc(qtyText(r.qty, r.unit))}</td><td>${r.cost == null ? na : money(r.cost)}</td><td>${money(r.sum)}</td><td${s && s.now < 0 ? ' class="neg"' : ''}>${s ? esc(stockText(s.now, r.unit)) : na}</td></tr>`; }).join('')
    + `</tbody><tfoot><tr class="tot"><td>Итого</td><td></td><td>${p.cost == null ? na : money(p.cost)}</td><td>${money(p.sum)}</td><td></td></tr></tfoot></table></div>`;
  const nSt = p.rows.filter(r => st.get(r.k)).length, mt = CAT.meta;
  h += '<p class="muted" style="margin:8px 0 0">' + (nSt
    ? 'Остаток: ' + (mt && mt.loadedAt ? 'из прайса от ' + fmtDT(mt.loadedAt) : 'из прайса') + ' минус проданное в приложении после этого (вписанный вами остаток считается от времени правки). '
    : 'Остаток не показан: в прайсе нет остатков. Его можно вписать вручную. ') + 'Нажмите на товар, чтобы изменить цены и остаток.</p>';
  if (p.noCost === p.rows.length) h += '<p class="muted" style="margin:8px 0 0">Себестоимость не показана: в прайсе нет закупочных цен. Чтобы она появилась, загрузите прайс со столбцом «Закупочная цена» (⚙ → «Обновить прайс») или впишите закупочную цену товара: нажмите на него в таблице.</p>';
  else if (p.noCost) h += `<p class="muted" style="margin:8px 0 0">Товаров без закупочной цены: ${p.noCost} (в таблице «—»). В итоговую себестоимость они не входят.</p>`;
  return h + '</div>';
}
async function renderRepOut() {
  const out = $('#repOut'); if (!out) return;
  const my = ++repSeq, rg = repRange();
  const { sales, oldest } = await loadPeriod(rg.from, rg.to);
  const p = reportByProduct(sales, REP.sort), st = await stockInfo(p.rows.map(r => r.k));
  if (my !== repSeq || S.tab !== 'reports' || REP.view !== 'rep') return;      // пока считалось, выбрали другой период или ушли с вкладки
  const same = ymd(rg.a) === ymd(rg.b);
  $('#repRange').textContent = same ? fmtDate(rg.a) : fmtDate(rg.a) + ' – ' + fmtDate(rg.b);
  out.innerHTML = repTablesHtml(sales, p, st)
    + (oldest != null && rg.from < dayStart(new Date(oldest)) ? `<p class="muted" style="margin:0 2px">Продажи в телефоне есть с ${fmtDate(new Date(oldest))}. Что было раньше, приложение не хранит (хранение: ${CFG.KEEP_DAYS} дн.).</p>` : '');
}

/* ---- вкладка «Товары: цены и остаток»: поиск (руками или камерой) и правка розничной, закупочной цены и остатка ---- */
function goodsHtml() {
  return `<div class="card"><h3>Цены и остаток товара</h3>
    <p class="muted" style="margin:0 0 8px">Найдите товар по названию или штрихкоду, либо наведите камеру на штрихкод. Затем измените розничную цену, закупочную цену или остаток.</p>
    <div class="gSearch"><input id="gq" type="text" inputmode="search" autocomplete="off" autocapitalize="off" placeholder="Название или штрихкод" value="${esc(REP.q)}"><button id="gCam" class="gcam" aria-label="Найти камерой по штрихкоду">📷</button></div>
    <div id="gList"></div></div>`;
}
/* Что искать в этой вкладке: товары из прайса (так же, как в чеке) и внесённые вручную (по названию и штрихкоду) */
function searchEditable(q) {
  const qn = normText(q), out = [];
  if (!qn) return out;
  const toks = qn.split(' '), isNum = /^\d+$/.test(qn), nb = isNum ? normBC(qn) : '';
  for (const [bc, x] of EXTRA) {
    const hit = (isNum && (bc === nb || (qn.length >= 3 && bc.endsWith(nb)) || (qn.length >= 5 && bc.includes(nb)))) || toks.every(t => normText(x.name).includes(t));
    if (hit) out.push({ kind: 'x', bc, x });
  }
  for (const r of searchProducts(q, 25)) out.push({ kind: 'f', p: r.p, bc: r.bc });
  return out.slice(0, 25);
}
function renderGoodsList() {
  const box = $('#gList'); if (!box) return;
  const q = REP.q.trim(), tip = t => `<p class="muted" style="margin:10px 2px 0">${t}</p>`;
  gItems = [];
  if (!q) { box.innerHTML = tip('Введите название или штрихкод, либо нажмите 📷.'); return; }
  gItems = searchEditable(q);
  if (!gItems.length) { box.innerHTML = tip('Ничего не найдено. Проверьте написание или нажмите 📷.'); return; }
  box.innerHTML = gItems.map((g, i) => {
    const o = g.kind === 'x' ? g.x : g.p, tags = (g.kind === 'x' ? '<span class="tag">вручную</span>' : '') + (o.edited ? '<span class="tag">изменено</span>' : '');
    const bcShow = g.kind === 'x' ? g.bc : ((g.bc && !/^PLU/.test(g.bc)) ? g.bc : ((o.bcs && o.bcs[0]) || (o.plu ? 'весы №' + o.plu : '')));
    const meta = (o.price ? money(o.price) + (o.unit === 'кг' ? ' сом/кг' : ' сом') : 'без цены') + ' · закупка ' + (o.cost != null ? money(o.cost) : '—') + (bcShow ? ' · ' + bcShow : '');
    return `<button class="pick" data-gi="${i}"><span class="n">${esc(o.name)}${tags}</span><span class="m">${esc(meta)}</span></button>`;
  }).join('') + (gItems.length >= 25 ? tip('Показаны первые 25. Уточните запрос.') : '');
}
const repRefresh = () => { if (S.tab !== 'reports') return; if (REP.view === 'goods') renderGoodsList(); else renderRepOut(); };
const gSearch = debounce(() => renderGoodsList(), 120);

/* Окно правки. ref: {kind:'f', p} — товар из прайса; {kind:'x', bc, x} — внесённый вручную */
async function openEditor(ref) {
  const o = refObj(ref), key = refKey(ref), man = ref.kind === 'x', u = o.unit === 'кг' ? 'кг' : 'шт';
  const si = (await stockInfo([key])).get(key), cur = si ? si.now : null;
  const val = v => v == null ? '' : String(v).replace('.', ',');
  const mon = v => v == null ? 'нет' : money(v), E = (!man && EDIT.get(key)) || {};
  const ids = man ? 'Штрихкод ' + ref.bc + ' · внесён вручную'
    : ([o.code ? 'Код ' + o.code : '', o.bcs.length ? 'штрихкод ' + o.bcs[0] + (o.bcs.length > 1 ? ' и ещё ' + (o.bcs.length - 1) : '') : ''].filter(Boolean).join(' · ') || 'без кода и штрихкода');
  let note = man ? '' : 'В прайсе: цена ' + mon(o.fprice) + ' · закупка ' + mon(o.fcost) + ' · остаток ' + (o.fstock == null ? 'нет' : sp(nf3.format(o.fstock))) + '.';
  if (si) note += (note ? ' ' : '') + (man || E.stock != null ? 'Остаток вписан вами ' : 'Остаток из прайса от ') + fmtDT(si.ts) + ': ' + sp(nf3.format(si.v)) + (si.sold ? ', продано в приложении после этого: ' + sp(nf3.format(si.sold)) : '') + '.';
  else note += (note ? ' ' : '') + 'Остатка нет: впишите его, дальше приложение будет вычитать продажи.';
  const mark = f => E[f] != null ? ' <span class="tag">изменено</span>' : '';
  openSheet(`<h2>${esc(o.name)}</h2><p class="muted" style="margin:0">${esc(ids)}</p>
    <label>Розничная цена за 1 ${u}, сом${mark('price')}</label><input id="ePrice" inputmode="decimal" value="${val(o.price)}" autocomplete="off">
    <label>Закупочная цена за 1 ${u}, сом${mark('cost')}</label><input id="eCost" inputmode="decimal" value="${val(o.cost)}" autocomplete="off">
    <label>Остаток на складе, ${u}${mark('stock')}</label><input id="eStock" inputmode="decimal" value="${val(cur)}" autocomplete="off">
    <p class="muted" style="margin:8px 0 0">${esc(note)}</p>
    <div class="btns"><button class="btn sec" id="shNo">Отмена</button><button class="btn primary" id="eOk">Сохранить</button></div>
    ${!man && o.edited ? '<div class="btns"><button class="btn sec" id="eReset">Вернуть значения из прайса</button></div>' : ''}
    ${man ? '<div class="btns"><button class="btn sec" id="eDel">Удалить товар из телефона</button></div>' : ''}`);
  $('#shNo').onclick = closeSheet;
  $('#eOk').onclick = async () => {
    const pv = $('#ePrice').value.trim(), cv = $('#eCost').value.trim(), sv = $('#eStock').value.trim();
    const price = pv === '' ? null : r2(num(pv)), cost = cv === '' ? null : r4(num(cv)), stk = sv === '' ? null : parseStock(sv);
    if (pv !== '' && !(price > 0)) { toast('Розничная цена: впишите число больше нуля'); return; }
    if (man && pv === '') { toast('Укажите розничную цену'); return; }
    if (cv !== '' && !(cost > 0)) { toast('Закупочная цена: впишите число больше нуля или оставьте поле пустым'); return; }
    if (sv !== '' && stk !== stk) { toast('Остаток: впишите число'); return; }
    const now = Date.now();
    if (man) {
      const x = ref.x; x.price = price;
      if (cost == null) delete x.cost; else x.cost = cost;
      if (sv === '') { delete x.stock; delete x.sts; } else if (stk !== cur) { x.stock = stk; x.sts = now; }
      await kvSet('extra', Object.fromEntries(EXTRA));
    } else {
      // пустое поле или значение, как в прайсе: правки нет. Остаток, который вы не трогали, не пересчитывается
      const e = EDIT.get(key) || { base: {} }; e.base = e.base || {};
      if (price == null || price === o.fprice) { delete e.price; delete e.base.price; } else { e.price = price; e.base.price = o.fprice == null ? null : o.fprice; }
      if (cost == null || cost === o.fcost) { delete e.cost; delete e.base.cost; } else { e.cost = cost; e.base.cost = o.fcost == null ? null : o.fcost; }
      if (sv === '') { delete e.stock; delete e.sts; delete e.base.stock; } else if (stk !== cur) { e.stock = stk; e.sts = now; e.base.stock = o.fstock == null ? null : o.fstock; }
      if (e.price == null && e.cost == null && e.stock == null) EDIT.delete(key); else EDIT.set(key, e);
      await kvSet('edits', Object.fromEntries(EDIT));
      overlay(CAT.byKey.get(key) || o);
    }
    closeSheet(); toast('Сохранено'); repRefresh();
  };
  if ($('#eReset')) $('#eReset').onclick = async () => {
    EDIT.delete(key); await kvSet('edits', Object.fromEntries(EDIT)); overlay(CAT.byKey.get(key) || o);
    closeSheet(); toast('Возвращены значения из прайса'); repRefresh();
  };
  if ($('#eDel')) $('#eDel').onclick = () => confirmSheet('Удалить товар из телефона?',
    '«' + o.name.slice(0, 60) + '» исчезнет из телефона. Прошлые продажи в отчётах останутся. Если такой штрихкод есть в прайсе, вернётся товар из прайса.', 'Удалить', async () => {
      EXTRA.delete(ref.bc); await kvSet('extra', Object.fromEntries(EXTRA)); await loadCatalogFromDB();
      toast('Товар удалён из телефона'); repRefresh();
    }, true);
}
$('#sheet').addEventListener('focusin', e => { if (e.target.matches('#ePrice,#eCost,#eStock')) setTimeout(() => e.target.select(), 0); });

/* Штрихкод пришёл с камеры или набран руками: открыть товар на правку */
function repFound(text) {
  const r = lookupCode(text);
  if (!r) return;
  if (r.choose) chooseProduct(r.choose, r.bc, p => openEditor({ kind: 'f', p }));
  else if (r.p) openEditor({ kind: 'f', p: r.p });
  else if (r.extra) openEditor({ kind: 'x', bc: r.bc, x: r.extra });
  else {
    toast(r.weightOnly ? 'Номер ' + r.plu + ' на весах в телефоне не найден. Найдите товар по названию' : 'Штрихкод ' + (r.raw || r.bc) + ' в телефоне не найден', null, null, 5000);
    const q = $('#gq'); if (q) { q.value = r.weightOnly ? '' : String(r.raw || r.bc); REP.q = q.value; renderGoodsList(); }
  }
}

/* Камера в этой вкладке: отдельное окно, после первого прочитанного штрихкода закрывается само */
let repScanner = null, repScanBusy = false;
const repCamMsg = t => { const m = $('#camMsg2'); if (m) m.textContent = t || ''; };
function startRepScan() {
  return camRun(async () => {
    if (repScanner || !$('#reader2')) return;
    if (!window.Html5Qrcode) { repCamMsg('Сканер не загрузился. Введите штрихкод вручную.'); return; }
    repCamMsg('Запуск камеры…');
    const F = Html5QrcodeSupportedFormats;
    const sc = new Html5Qrcode('reader2', { formatsToSupport: [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.CODE_39, F.ITF], useBarCodeDetectorIfSupported: true, verbose: false });
    try {
      await sc.start({ facingMode: 'environment' }, { fps: 10, disableFlip: true, qrbox: (w, h) => ({ width: Math.max(50, Math.floor(w * 0.92)), height: Math.max(50, Math.floor(h * 0.6)) }) }, onRepScan, () => { });
      repScanner = sc; repCamMsg('');
    } catch (e) { try { sc.clear(); } catch (x) { } repCamMsg(camError(e)); }
  });
}
function stopRepScan() {
  return camRun(async () => {
    if (!repScanner) return;
    const sc = repScanner; repScanner = null;
    try { await sc.stop(); } catch (e) { }
    try { sc.clear(); } catch (e) { }
  });
}
function onRepScan(text) {
  if (repScanBusy) return;
  repScanBusy = true; setTimeout(() => { repScanBusy = false; }, 800);
  closeSheet(); feedback(true);
  repFound(text);
}
function openRepScan() {
  openSheet('<h2>Наведите камеру на штрихкод</h2><div id="reader2"></div><p class="muted" id="camMsg2" style="min-height:20px;margin:4px 0 0"></p><div class="btns"><button class="btn sec" id="shNo">Закрыть</button></div>');
  $('#shNo').onclick = closeSheet;
  startRepScan();
}

async function renderReports() {
  const pane = $('#reportsPane'); if (!pane) return;
  if (REP.view === 'goods') { pane.innerHTML = repViewHtml() + goodsHtml(); renderGoodsList(); return; }
  pane.innerHTML = repViewHtml() + repControlsHtml() + '<div id="repOut"></div>';
  await renderRepOut();
}
{
  const pane = $('#reportsPane');
  if (pane) {
    pane.addEventListener('click', e => {
      const v = e.target.closest('[data-rv]');
      if (v) { REP.view = v.dataset.rv; renderReports(); return; }
      const m = e.target.closest('[data-rm]');
      if (m) {
        if (m.dataset.rm === 'custom' && REP.mode !== 'custom') { const rg = repRange(); REP.from = ymd(rg.a); REP.to = ymd(rg.b); }
        REP.mode = m.dataset.rm; renderReports(); return;
      }
      const s = e.target.closest('[data-rs]');
      if (s) { REP.sort = s.dataset.rs; renderRepOut(); return; }
      const tr = e.target.closest('tr[data-ri]');
      if (tr) {
        const r = repRows[+tr.dataset.ri], ref = r && refByKey(r.k);
        if (ref) openEditor(ref); else toast('Этого товара нет в телефоне: править нечего');
        return;
      }
      const g = e.target.closest('[data-gi]');
      if (g) { const it = gItems[+g.dataset.gi]; if (it) openEditor(it.kind === 'x' ? { kind: 'x', bc: it.bc, x: it.x } : { kind: 'f', p: it.p }); return; }
      if (e.target.closest('#gCam')) openRepScan();
    });
    pane.addEventListener('input', e => { if (e.target.id === 'gq') { REP.q = e.target.value; gSearch(); } });
    pane.addEventListener('keydown', e => {
      if (e.key !== 'Enter' || e.target.id !== 'gq') return;
      const q = e.target.value.trim(); if (!q) return;
      e.preventDefault(); e.target.blur();
      if (/^\d{8,}$/.test(q.replace(/\s+/g, ''))) repFound(q);
      else { renderGoodsList(); if (gItems.length) { const it = gItems[0]; openEditor(it.kind === 'x' ? { kind: 'x', bc: it.bc, x: it.x } : { kind: 'f', p: it.p }); } }
    });
    pane.addEventListener('change', e => {
      if (e.target.id === 'repFrom') REP.from = e.target.value;
      else if (e.target.id === 'repTo') REP.to = e.target.value;
      else return;
      renderRepOut();
    });
  }
}

/* ---------- сигнал, вибрация, экран не гаснет ---------- */
let actx;
function audioCtx() {           // звук на телефоне разрешён только после первого касания: разбудим его при любом касании
  try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume(); } catch (e) { }
  return actx;
}
['pointerdown', 'touchend', 'keydown'].forEach(ev => document.addEventListener(ev, audioCtx, { passive: true }));
function beep(ok) {
  try {
    const a = audioCtx(); if (!a) return;
    const o = a.createOscillator(), g = a.createGain();
    o.frequency.value = ok ? 1100 : 300; g.gain.value = 0.15;
    o.connect(g); g.connect(a.destination); o.start(); o.stop(a.currentTime + (ok ? 0.08 : 0.25));
  } catch (e) { }
}
function feedback(ok) {
  beep(ok);
  try { navigator.vibrate && navigator.vibrate(ok ? 40 : [60, 40, 60]); } catch (e) { }
  const w = $('#camWrap'); w.classList.add('hit'); setTimeout(() => w.classList.remove('hit'), 300);
}
let wl;
async function keepAwake() { try { if (navigator.wakeLock && !document.hidden) wl = await navigator.wakeLock.request('screen'); } catch (e) { } }

/* ---------- камера ---------- */
let scanner = null, torchFeat = null, torchOn = false, camQ = Promise.resolve();
const camMsg = t => { $('#camMsg').textContent = t || ''; };
const camRun = fn => (camQ = camQ.then(fn).catch(() => { }));     // включение и выключение камеры идут строго по очереди
window.addEventListener('unhandledrejection', e => {              // библиотека сканера при мгновенном выключении камеры сообщает о прерванном play(): это не ошибка
  if (/play\(\) request was interrupted|media was removed/i.test(String(e.reason && (e.reason.message || e.reason)))) e.preventDefault();
});
function onScan(text) {
  if (sheetOpen()) return;
  const now = Date.now();
  if (text === S.lastCode && now - S.lastCodeAt < CFG.SCAN_REPEAT_MS) { S.lastCodeAt = now; return; }
  S.lastCode = text; S.lastCodeAt = now;
  handleCode(text);
}
function camError(e) {
  const m = String((e && e.name ? e.name + ' ' : '') + (e && (e.message || e) || ''));
  if (/NotAllowed|Permission|denied/i.test(m)) return 'Нет доступа к камере. Разрешите камеру для этого сайта (значок замка рядом с адресом). Ввод вручную работает.';
  if (/NotFound|DevicesNotFound|device not found/i.test(m)) return 'Камера не найдена. Ввод вручную работает.';
  if (/NotReadable|TrackStart|in use/i.test(m)) return 'Камера занята другим приложением. Закройте его и нажмите 📷.';
  if (!window.isSecureContext) return 'Камера работает только на защищённом адресе (https).';
  return 'Камера не запустилась. Нажмите 📷, чтобы повторить. Ввод вручную работает.';
}
function startScanner() {
  return camRun(async () => {
    if (scanner || S.camOff || S.tab !== 'kassa' || document.hidden) return;
    if (!window.Html5Qrcode) { camMsg('Сканер не загрузился. Введите штрихкод вручную.'); return; }
    camMsg('Запуск камеры…');
    const F = Html5QrcodeSupportedFormats;
    const sc = new Html5Qrcode('reader', {
      formatsToSupport: [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.CODE_39, F.ITF],     // без QR: коды маркировки и платёжные QR не нужны
      useBarCodeDetectorIfSupported: true, verbose: false
    });
    try {
      await sc.start({ facingMode: 'environment' },
        { fps: 10, disableFlip: true, qrbox: (w, h) => ({ width: Math.floor(w * 0.92), height: Math.floor(Math.max(70, h * 0.6)) }) },
        onScan, () => { });
      scanner = sc; S.scanning = true; camMsg('');
      try { torchFeat = sc.getRunningTrackCameraCapabilities().torchFeature(); } catch (e) { torchFeat = null; }
      $('#btnTorch').style.display = torchFeat && torchFeat.isSupported() ? '' : 'none';
      torchOn = false; $('#btnTorch').classList.remove('on');
    } catch (e) {
      try { sc.clear(); } catch (x) { }
      camMsg(camError(e));
    }
  });
}
function stopScanner() {
  return camRun(async () => {
    if (!scanner) return;
    const sc = scanner; scanner = null; S.scanning = false; torchFeat = null; $('#btnTorch').style.display = 'none';
    try { await sc.stop(); } catch (e) { }
    try { sc.clear(); } catch (e) { }
  });
}
$('#btnTorch').addEventListener('click', async () => {
  if (!torchFeat) return;
  try { torchOn = !torchOn; await torchFeat.apply(torchOn); $('#btnTorch').classList.toggle('on', torchOn); } catch (e) { torchOn = false; toast('Фонарик не включился'); }
});
$('#btnCam').addEventListener('click', async () => {
  if (S.scanning) { S.camOff = true; await stopScanner(); camMsg('Камера выключена. Нажмите 📷, чтобы включить.'); }
  else { S.camOff = false; startScanner(); }
});

/* ---------- вкладки ---------- */
function showTab(t) {
  S.tab = t;
  $$('.tab').forEach(x => x.classList.toggle('active', x.id === 'tab-' + t));
  $$('nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
  if (t === 'kassa') startScanner(); else stopScanner();
  if (t === 'session') renderSession();
  if (t === 'history') renderHistory();
  if (t === 'reports') renderReports();
}
$$('nav button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

/* ---------- прайс: индикатор и настройки ---------- */
function renderChip() {
  const c = $('#priceChip'), m = CAT.meta;
  if (!CAT.products.length) { c.textContent = 'прайс не загружен'; c.className = 'chip warn'; return; }
  if (isDemoCatalog()) { c.innerHTML = `<span class="dot ${navigator.onLine ? 'on' : 'off'}"></span>демо-прайс`; c.className = 'chip warn'; return; }   // в приложении лежит учебный список, а не прайс магазина
  const ts = (m && (m.checkedAt || m.loadedAt)) || 0, age = (Date.now() - ts) / DAY;   // когда прайс в последний раз сверяли с источником
  c.innerHTML = `<span class="dot ${navigator.onLine ? 'on' : 'off'}"></span>прайс ${fmtDT(ts)}`;
  c.className = 'chip' + (age > CFG.STALE_DAYS ? ' warn' : '');
}
const srcName = s => { if (!s) return '—'; if (/^https?:\/\//i.test(s)) { try { return new URL(s).host; } catch (e) { } } return s; };
const repText = r => {
  if (!r) return '';
  const L = [
    'Товаров: ' + nf0.format(r.products), 'Штрихкодов: ' + nf0.format(r.barcodes),
    'Без штрихкода: ' + nf0.format(r.noBarcode), 'Без цены: ' + nf0.format(r.noPrice),
    'Весовых: ' + nf0.format(r.weighted) + ' (с номером на весах в прайсе: ' + nf0.format(r.plu) + ')',
    'Пропущено «удалить»: ' + nf0.format(r.deleted), 'Пропущено итоговых строк: ' + nf0.format(r.skipped || 0),
    'Некорректных штрихкодов (не загружены): ' + nf0.format(r.badBc) + (r.badEx && r.badEx.length ? '\n  ' + r.badEx.join('\n  ') : ''),
    'Штрихкод у двух товаров: ' + nf0.format(r.conflicts) + (r.conflictEx && r.conflictEx.length ? '\n  ' + r.conflictEx.join('\n  ') : ''),
    'Одинаковый номер на весах у двух товаров: ' + nf0.format(r.pluConflicts)
  ];
  if (r.costN) L.push('Закупочные цены: ' + nf0.format(r.costN) + ' товаров (для отчёта по себестоимости). Учтите: если файл лежит на GitHub, закупочные цены видят все, у кого есть адрес.');
  else if (r.costN === 0) L.push('Закупочных цен в файле нет' + (r.costCol ? ' (столбец есть, но пустой)' : '') + ': в отчёте по товарам себестоимость будет «—».');
  else if (r.hasCost) L.push('Этот прайс загружен прежней версией приложения: закупочные цены и остатки в нём не учтены. Нажмите «Обновить прайс».');
  if (r.stockN) L.push('Остатки: ' + nf0.format(r.stockN) + ' товаров (в отчёте по товарам остаток уменьшается с продажами в приложении). Учтите: если файл лежит на GitHub, остатки видят все, у кого есть адрес.');
  else if (r.stockN === 0) L.push('Остатков в файле нет: столбец «Остаток» не найден или пуст. Остаток можно вписать вручную: Отчёты → Товары: цены и остаток.');
  if (r.stock && !r.stock.zero && r.products > 100) L.push('Внимание: в файле нет товаров с нулевым остатком. Товары, которых сейчас нет на складе, в прайс не попали и при сканировании будут «не найдены».');
  return L.join('\n');
};
let syncing = false;
async function doSync(manual) {
  if (syncing) return; syncing = true;
  try {
    const r = await syncCatalog(false);
    renderChip();
    if (r.updated) toast('Прайс обновлён: ' + nf0.format(CAT.products.length) + ' товаров' + (CAT.skipped.length ? '. Не загружено ' + nf0.format(CAT.skipped.length) + ': их штрихкод уже внесён вручную' : ''), null, null, CAT.skipped.length ? 6000 : 0);
    else if (manual) toast('Прайс актуален');
    return r;
  } catch (e) {
    renderChip();
    if (manual) toast('Прайс не обновлён: ' + e.message, null, null, 6000);
  } finally { syncing = false; }
}
/* Что ещё сказать про загрузку: ручные товары главнее прайса, правки товаров */
const extraText = () => {
  let t = '';
  if (CAT.skipped.length) t += '\nНе загружено, потому что штрихкод уже внесён вручную: ' + nf0.format(CAT.skipped.length) + '. В телефоне остались товары, внесённые вручную.\n  '
    + CAT.skipped.slice(0, 8).map(s => s.name.slice(0, 40)).join('\n  ') + (CAT.skipped.length > 8 ? '\n  … и ещё ' + (CAT.skipped.length - 8) : '');
  if (EDIT.size) t += '\nИзменено вручную в товарах из прайса: ' + nf0.format(EDIT.size) + '. Правка действует, пока в новом прайсе это значение не изменится.';
  return t;
};
async function openSettings() {
  const m = CAT.meta || {}, url = (await kvGet('priceUrl')) || '';
  let persisted = '—'; try { persisted = (await navigator.storage.persisted()) ? 'да' : 'нет'; } catch (e) { }
  openSheet(`<h2>Настройки</h2>
    ${isDemoCatalog() ? `<p style="background:#fff3cd;color:#4a3300;border-radius:8px;padding:8px 10px;margin:0 0 8px;font-size:13px">Сейчас в приложении учебный прайс из ${CAT.products.length} товаров, а не ваш. Положите выгрузку из 1С на сайт приложения под именем prices.xlsx (приложение подхватит её само) или загрузите файл вручную кнопкой ниже.</p>` : ''}
    <div class="kv"><span>Товаров в прайсе</span><span>${nf0.format(CAT.products.length)}</span></div>
    <div class="kv"><span>Откуда прайс</span><span>${esc(srcName(m.source))}</span></div>
    <div class="kv"><span>Прайс изменён</span><span>${m.loadedAt ? fmtDT(m.loadedAt) : 'нет'}</span></div>
    <div class="kv"><span>Прайс проверен</span><span>${m.checkedAt ? fmtDT(m.checkedAt) : 'нет'}</span></div>
    <div class="kv"><span>Интернет</span><span>${navigator.onLine ? 'есть' : 'нет'}</span></div>
    <div class="kv"><span>Данные защищены от очистки</span><span>${persisted}</span></div>
    <div class="kv"><span>Версия</span><span>${CFG.VERSION}</span></div>
    ${persisted === 'нет' ? '<p class="muted" style="margin:6px 0 0">Чтобы телефон не удалял данные приложения, добавьте его на главный экран: меню браузера → «Установить приложение».</p>' : ''}
    <label>Адрес файла прайса (пусто: prices.xlsx или prices.csv рядом с приложением)</label>
    <input id="stUrl" type="text" value="${esc(url)}" placeholder="https://…/pub?output=csv" autocomplete="off" autocapitalize="off">
    <div class="btns"><button class="btn sec" id="stSave">Сохранить адрес</button><button class="btn primary" id="stSync">Обновить прайс</button></div>
    <div class="btns"><button class="btn sec" id="stFile">Загрузить файл прайса (Excel или CSV)</button></div>
    <div class="btns"><a class="btn sec lnk" href="prep.html" target="_blank" rel="noopener">Сделать prices.csv (закупочные цены и остатки по желанию)</a></div>
    ${m.report ? `<h3 style="margin:14px 0 6px">Последняя загрузка</h3><pre class="rep">${esc(repText(m.report) + extraText())}</pre>` : ''}
    ${PLUMAP.size ? `<h3 style="margin:14px 0 6px">Номера с весов, которые вы запомнили</h3>` + [...PLUMAP].map(([plu, key]) => { const p = CAT.byKey.get(key); return `<div class="kv"><span>№ ${plu}: ${p ? esc(p.name) : 'товара больше нет в прайсе'}</span><button class="xbtn" data-plu="${plu}" aria-label="Забыть">✕</button></div>`; }).join('') : ''}
    <div class="btns"><button class="btn sec" id="shNo">Закрыть</button></div>`);
  $('#shNo').onclick = closeSheet;
  $$('#sheet .xbtn').forEach(b => b.onclick = () => { PLUMAP.delete(+b.dataset.plu); savePluMap(); toast('Номер ' + b.dataset.plu + ' забыт'); openSettings(); });
  $('#stSave').onclick = async () => { await kvSet('priceUrl', $('#stUrl').value.trim()); toast('Адрес сохранён'); };
  $('#stSync').onclick = async () => {
    await kvSet('priceUrl', $('#stUrl').value.trim());
    $('#stSync').textContent = 'Загружаю…'; $('#stSync').disabled = true;
    try {
      await syncCatalog(true); renderChip(); closeSheet();
      toast('Прайс загружен: ' + nf0.format(CAT.products.length) + ' товаров'); setTimeout(openSettings, 400);
    } catch (e) { $('#stSync').textContent = 'Обновить прайс'; $('#stSync').disabled = false; toast('Не удалось: ' + e.message, null, null, 6000); }
  };
  $('#stFile').onclick = () => $('#fileIn').click();
}
$('#fileIn').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    const buf = await f.arrayBuffer();
    const rep = await applyCatalogBuffer(buf, { hash: hashBuf(buf), source: 'файл: ' + f.name }, true);
    renderChip(); closeSheet();
    toast('Прайс загружен из файла: ' + nf0.format(CAT.products.length) + ' товаров');
    setTimeout(openSettings, 400);
  } catch (err) { toast('Не удалось прочитать файл: ' + err.message, null, null, 7000); }
});
$('#btnSettings').addEventListener('click', openSettings);
$('#priceChip').addEventListener('click', openSettings);

/* ---------- запуск ---------- */
async function init() {
  await DB.open();
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) { }
  await loadExtra(); await loadEdits(); await loadCatalogFromDB(); await loadPluMap();
  const d = await kvGet('draft'); if (Array.isArray(d)) S.lines = d;
  await autoCloseSessions(); await cleanupOld();
  renderChip(); renderCart(); await updateBadge();
  showTab('kassa'); keepAwake();
  if (navigator.onLine !== false) doSync(false);
  setInterval(() => { tick(); renderChip(); }, 30000);
  setInterval(() => { if (navigator.onLine) doSync(false); }, CFG.SYNC_EVERY_MIN * 60000);
  window.addEventListener('online', () => { renderChip(); doSync(false); });
  window.addEventListener('offline', renderChip);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { stopScanner(); if ($('#reader2')) closeSheet(); return; }
    keepAwake(); tick(); renderChip(); if (S.tab === 'kassa') startScanner();
  });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').then(reg => { if (navigator.onLine !== false) reg.update().catch(() => { }); }).catch(() => { });   // при каждом запуске проверяем, не вышла ли новая версия приложения
}
init().catch(e => { document.body.insertAdjacentHTML('afterbegin', '<div style="padding:16px;color:#b00020">Ошибка запуска: ' + esc(e && e.message || e) + '</div>'); });
