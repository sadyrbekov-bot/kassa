'use strict';
/* ============ Резервная касса ============
   Настройки (можно менять): */
const CFG = {
  SESSION_HOURS: 24,      // сессия закрывается автоматически через столько часов
  KEEP_DAYS: 5,           // закрытые сессии хранятся столько дней
  PRICE_URL_DEFAULT: 'prices.csv',
  SYNC_EVERY_MIN: 30,     // как часто проверять новый прайс, пока приложение открыто
  SYNC_TIMEOUT_MS: 15000, // если интернета нет, ждать не дольше
  SCAN_REPEAT_MS: 1500,   // пауза против двойного чтения одного штрихкода
  STALE_DAYS: 3,          // через сколько дней предупреждать, что прайс не обновлялся
  VERSION: '1.1'
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
    weighted: 0, plu: 0, pluConflicts: 0, hasCost: !!h.hasCost, stock: null, conflictList: [], badList: [], noBcList: [], noPriceList: [] };
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
      p = { code: codeRaw, name, price, unit, bcs: [], plu: null, shared: [] };
      if (col.plu != null) { const v = parseInt(String(row[col.plu] || '').replace(/\D/g, ''), 10); if (v > 0) p.plu = v; }
      byKey.set(key, p); products.push(p);
      if (price == null) { rep.noPrice++; rep.noPriceList.push(p); }
      if (col.stock != null) {
        const sx = String(row[col.stock] == null ? '' : row[col.stock]).replace(/[\s ]/g, '').replace(',', '.');
        if (sx !== '' && isFinite(+sx)) { rep.stock = rep.stock || { pos: 0, zero: 0, neg: 0 }; if (+sx > 0) rep.stock.pos++; else if (+sx === 0) rep.stock.zero++; else rep.stock.neg++; }
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
async function xlsxSheets(buf) {
  const z = unzip(buf), td = new TextDecoder('utf-8');
  const xml = async n => {
    const d = await z.read(n); if (!d) return null;
    const doc = new DOMParser().parseFromString(td.decode(d), 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('Файл Excel повреждён');
    return doc;
  };
  const ss = [], sx = await xml('xl/sharedStrings.xml');
  if (sx) for (const si of sx.getElementsByTagName('si')) ss.push([...si.getElementsByTagName('t')].map(t => t.textContent).join(''));
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
    const doc = await xml(sh.path); if (!doc) continue;
    const rows = [];
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
function catalogToCsv(products) {
  const out = ['Код;Наименование;Штрихкод;Цена;Ед.;PLU'];
  for (const p of products) {
    const price = p.price == null ? '' : String(p.price).replace('.', ',');
    const bcs = [...p.bcs, ...(p.shared || [])];
    for (const b of (bcs.length ? bcs : [''])) out.push([p.code, p.name, b, price, p.unit, p.plu || ''].map(csvCell).join(';'));
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
const CAT = { products: [], names: [], byBc: new Map(), byPlu: new Map(), byKey: new Map(), dups: new Map(), bcList: [], meta: null };
const EXTRA = new Map();    // товары, которых нет в прайсе (кассир ввёл вручную): штрихкод -> {name, price, unit}
const PLUMAP = new Map();   // номер товара на весах -> ключ товара. Запоминается, когда кассир один раз сопоставил этикетку с товаром
const pkey = p => p.code ? 'c:' + p.code : 'n:' + normText(p.name);

function setCatalog(arr, meta) {
  CAT.products = arr.map((a, i) => ({ i, code: a[0], name: a[1], price: a[2], unit: a[3], bcs: a[4], plu: a[5], shared: a[6] || [] }));
  CAT.names = CAT.products.map(p => normText(p.name));
  CAT.byBc = new Map(); CAT.byPlu = new Map(); CAT.byKey = new Map(); CAT.dups = new Map(); CAT.bcList = [];
  for (const p of CAT.products) {
    p.key = pkey(p);
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
  CAT.meta = meta || null;
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
  const arr = res.products.map(p => [p.code, p.name, p.price, p.unit, p.bcs, p.plu, p.shared]);
  const m = Object.assign({}, meta, { loadedAt: Date.now(), checkedAt: Date.now(), count: n, sheet: res.sheet || '', report: liteReport(res.report) });
  await kvSet('catalog', arr);
  await kvSet('catmeta', m);
  setCatalog(arr, m);
  // штрихкоды, которые теперь есть в прайсе, из «временных» убираем
  let ch = false; for (const b of [...EXTRA.keys()]) if (CAT.byBc.has(b)) { EXTRA.delete(b); ch = true; }
  if (ch) await kvSet('extra', Object.fromEntries(EXTRA));
  return res.report;
}
const applyCatalogText = (text, meta, manual) => applyResult(buildCatalog(parseCSV(text)), meta, manual);
const applyCatalogBuffer = async (buf, meta, manual) => applyResult(await buildCatalogFromBuffer(buf), meta, manual);

/* Скачать прайс по адресу из настроек (или prices.csv рядом с приложением). Подходят CSV и Excel */
async function syncCatalog(force) {
  const url = (await kvGet('priceUrl')) || CFG.PRICE_URL_DEFAULT;
  const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), CFG.SYNC_TIMEOUT_MS);
  try {
    const r = await fetch(url, { cache: 'no-cache', signal: ctl.signal });
    if (!r.ok) throw new Error('сервер ответил ' + r.status);
    const buf = await r.arrayBuffer();
    const hash = hashBuf(buf), m = CAT.meta;
    if (!force && m && m.hash === hash && m.source === url && CAT.products.length) {
      m.checkedAt = Date.now(); await kvSet('catmeta', m);
      return { same: true };
    }
    const rep = await applyCatalogBuffer(buf, { hash, source: url, lastModified: r.headers.get('last-modified') || '' }, false);
    return { updated: true, rep };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('нет ответа (вероятно, нет интернета)');
    if (e instanceof TypeError) throw new Error('не удалось скачать файл: нет интернета или адрес указан неверно');
    throw e;
  } finally { clearTimeout(to); }
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
function closeSheet() { $('#ov').classList.remove('show'); $('#sheet').innerHTML = ''; }
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
  const l = { id: uid(), code: p.code, name: p.name, unit: p.unit, price: p.price, origPrice: p.price, weighted: w, qty: w ? (o.weight || 0) : 1, sum: 0, driver: 'weight', bc: o.bc || '', unknown: false, changed: false };
  calcLine(l); S.lines.unshift(l);
  afterCartChange(l.id);
  if (fromPending) offerRemember(pend.plu, p);
  return l;
}

/* штрихкод закреплён за несколькими товарами: показываем варианты, кассир выбирает тот, что в руках */
function chooseProduct(list, bc) {
  const priceOf = p => (p.price ? money(p.price) + (p.unit === 'кг' ? ' сом/кг' : ' сом') : 'без цены');
  openSheet(`<h2>Какой это товар?</h2><p class="muted">Штрихкод ${esc(bc)} в прайсе указан у ${list.length} товаров. Выберите тот, что перед вами.</p>`
    + list.map((p, i) => `<button class="pick" data-i="${i}"><span class="n">${esc(p.name)}</span><span class="m">${esc(priceOf(p))}</span></button>`).join('')
    + '<div class="btns"><button class="btn sec" id="shNo">Отмена</button></div>');
  $('#shNo').onclick = closeSheet;
  $$('#sheet .pick').forEach(b => b.onclick = () => { const p = list[+b.dataset.i]; closeSheet(); addProduct(p, { bc }); feedback(true); });
}
function addExtra(bc, ex) {
  const old = S.lines.find(l => l.unknown && l.bc && l.bc === bc);
  if (old) { old.qty += 1; calcLine(old); moveTop(old); afterCartChange(); return; }
  const l = { id: uid(), code: '', name: ex.name, unit: 'шт', price: ex.price, origPrice: ex.price, weighted: false, qty: 1, sum: 0, driver: 'weight', bc: bc || '', unknown: true, changed: false };
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
    <label>Цена за 1 шт, сом</label><input id="uPrice" inputmode="decimal">
    ${code ? '<label style="display:flex;gap:8px;align-items:center;color:inherit;font-size:15px"><input type="checkbox" id="uSave" checked style="width:22px;height:22px">Запомнить на этом телефоне</label>' : ''}
    <div class="btns"><button class="btn sec" id="shNo">Отмена</button><button class="btn primary" id="uOk">Добавить в чек</button></div>`);
  $('#shNo').onclick = closeSheet;
  setTimeout(() => $(nameHint ? '#uPrice' : '#uName').focus(), 50);
  $('#uOk').onclick = async () => {
    const name = $('#uName').value.trim(), price = r2(num($('#uPrice').value));
    if (!name || !(price > 0)) { toast('Укажите название и цену'); return; }
    if (code && $('#uSave') && $('#uSave').checked) { EXTRA.set(code, { name, price, unit: 'шт' }); kvSet('extra', Object.fromEntries(EXTRA)).catch(() => { }); }
    closeSheet(); addExtra(code, { name, price });
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

async function autoCloseSessions(now) {
  now = now || Date.now(); let ch = false;
  for (const s of await DB.all('sessions')) {
    if (!s.closedAt && now >= s.startedAt + CFG.SESSION_HOURS * HOUR) {
      s.closedAt = s.startedAt + CFG.SESSION_HOURS * HOUR; s.closedBy = 'auto';
      await DB.put('sessions', s); ch = true;
    }
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
    lines: S.lines.map(l => ({ code: l.code, name: l.name, unit: l.unit, price: l.price, origPrice: l.origPrice, qty: l.qty, sum: l.sum, changed: l.changed, unknown: l.unknown, bc: l.bc }))
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
  const left = s.startedAt + CFG.SESSION_HOURS * HOUR - Date.now();
  pane.innerHTML = `<div class="banner warn">Внесите эти продажи в кассу магазина и закройте сессию. Открыта с ${fmtDT(s.startedAt)}, закроется автоматически через ${hm(left)}: после этого её продажи считаются внесёнными.</div>
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
}
$$('nav button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

/* ---------- прайс: индикатор и настройки ---------- */
function renderChip() {
  const c = $('#priceChip'), m = CAT.meta;
  if (!CAT.products.length) { c.textContent = 'прайс не загружен'; c.className = 'chip warn'; return; }
  const ts = (m && (m.checkedAt || m.loadedAt)) || 0, age = (Date.now() - ts) / DAY;   // когда прайс в последний раз сверяли с источником
  c.innerHTML = `<span class="dot ${navigator.onLine ? 'on' : 'off'}"></span>прайс ${fmtDT(ts)}`;
  c.className = 'chip' + (age > CFG.STALE_DAYS ? ' warn' : '');
}
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
  if (r.hasCost) L.push('ВНИМАНИЕ: в файле есть закупочные цены. В приложение они не загружены, но такой файл нельзя выкладывать в интернет.');
  if (r.stock && !r.stock.zero && r.products > 100) L.push('Внимание: в файле нет товаров с нулевым остатком. Товары, которых сейчас нет на складе, в прайс не попали и при сканировании будут «не найдены».');
  return L.join('\n');
};
let syncing = false;
async function doSync(manual) {
  if (syncing) return; syncing = true;
  try {
    const r = await syncCatalog(false);
    renderChip();
    if (r.updated && r.rep && r.rep.hasCost) toast('Прайс обновлён, но в файле на сервере есть закупочные цены. Уберите их: файл виден всем, у кого есть адрес.', null, null, 12000);
    else if (r.updated) toast('Прайс обновлён: ' + nf0.format(CAT.products.length) + ' товаров');
    else if (manual) toast('Прайс актуален');
    return r;
  } catch (e) {
    renderChip();
    if (manual) toast('Прайс не обновлён: ' + e.message, null, null, 6000);
  } finally { syncing = false; }
}
async function openSettings() {
  const m = CAT.meta || {}, url = (await kvGet('priceUrl')) || '';
  let persisted = '—'; try { persisted = (await navigator.storage.persisted()) ? 'да' : 'нет'; } catch (e) { }
  openSheet(`<h2>Настройки</h2>
    <div class="kv"><span>Товаров в прайсе</span><span>${nf0.format(CAT.products.length)}</span></div>
    <div class="kv"><span>Прайс изменён</span><span>${m.loadedAt ? fmtDT(m.loadedAt) : 'нет'}</span></div>
    <div class="kv"><span>Прайс проверен</span><span>${m.checkedAt ? fmtDT(m.checkedAt) : 'нет'}</span></div>
    <div class="kv"><span>Интернет</span><span>${navigator.onLine ? 'есть' : 'нет'}</span></div>
    <div class="kv"><span>Данные защищены от очистки</span><span>${persisted}</span></div>
    <div class="kv"><span>Версия</span><span>${CFG.VERSION}</span></div>
    ${persisted === 'нет' ? '<p class="muted" style="margin:6px 0 0">Чтобы телефон не удалял данные приложения, добавьте его на главный экран: меню браузера → «Установить приложение».</p>' : ''}
    <label>Адрес файла прайса (пусто: prices.csv рядом с приложением)</label>
    <input id="stUrl" type="text" value="${esc(url)}" placeholder="https://…/pub?output=csv" autocomplete="off" autocapitalize="off">
    <div class="btns"><button class="btn sec" id="stSave">Сохранить адрес</button><button class="btn primary" id="stSync">Обновить прайс</button></div>
    <div class="btns"><button class="btn sec" id="stFile">Загрузить файл прайса (Excel или CSV)</button></div>
    <div class="btns"><a class="btn sec lnk" href="prep.html" target="_blank" rel="noopener">Подготовить чистый prices.csv из выгрузки</a></div>
    ${m.report ? `<h3 style="margin:14px 0 6px">Последняя загрузка</h3><pre class="rep">${esc(repText(m.report))}</pre>` : ''}
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
    toast('Прайс загружен из файла: ' + nf0.format(CAT.products.length) + ' товаров' + (rep && rep.hasCost ? '. В файле были закупочные цены: в приложение они не попали' : ''), null, null, rep && rep.hasCost ? 8000 : 0);
    setTimeout(openSettings, 400);
  } catch (err) { toast('Не удалось прочитать файл: ' + err.message, null, null, 7000); }
});
$('#btnSettings').addEventListener('click', openSettings);
$('#priceChip').addEventListener('click', openSettings);

/* ---------- запуск ---------- */
async function init() {
  await DB.open();
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) { }
  await loadCatalogFromDB(); await loadExtra(); await loadPluMap();
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
    if (document.hidden) { stopScanner(); return; }
    keepAwake(); tick(); renderChip(); if (S.tab === 'kassa') startScanner();
  });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').then(reg => { if (navigator.onLine !== false) reg.update().catch(() => { }); }).catch(() => { });   // при каждом запуске проверяем, не вышла ли новая версия приложения
}
init().catch(e => { document.body.insertAdjacentHTML('afterbegin', '<div style="padding:16px;color:#b00020">Ошибка запуска: ' + esc(e && e.message || e) + '</div>'); });
