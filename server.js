'use strict';
/**
 * Server dự đoán Tài/Xỉu - chỉ có 2 link GET:
 *   /dulieucau   : dữ liệu cầu (mỗi bảng 20 kết quả)
 *   /dudoanlc79  : dự đoán phiên mới
 * Yêu cầu Node >= 18 (dùng fetch có sẵn, không cần cài thư viện).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const API_URL = process.env.API_URL || 'https://wtxmd52.tele68.com/v1/txmd5/sessions';
const POLL_MS = Number(process.env.POLL_MS) || 5000;
const TABLE_SIZE = 20;
const MAX_HISTORY = 2000; // bội số của 20
const DATA_FILE = path.join(__dirname, 'data.json');
const ID_NAME = 'Ha Quoc';

/* ===================== LƯU TRỮ LỊCH SỬ ===================== */
const store = new Map(); // phien -> record
let history = [];        // mảng record đã sắp xếp tăng dần
let dirty = false;
let lastPrediction = null;
let lastPhien = null;

function loadFile() {
  try {
    const arr = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (Array.isArray(arr)) {
      arr.forEach((r) => {
        if (r && r.phien && Array.isArray(r.dices)) store.set(String(r.phien), r);
      });
      rebuild();
    }
  } catch (e) { /* chưa có file thì bỏ qua */ }
}

function saveFile() {
  if (!dirty) return;
  dirty = false;
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(history)); } catch (e) { /* Render có thể không cho ghi, bỏ qua */ }
}

function rebuild() {
  history = Array.from(store.values()).sort((a, b) => a.n - b.n);
  if (history.length > MAX_HISTORY) {
    let cut = history.length - MAX_HISTORY;
    cut = Math.ceil(cut / TABLE_SIZE) * TABLE_SIZE; // cắt theo bội số 20 để bảng không bị lệch
    history.slice(0, cut).forEach((r) => store.delete(String(r.phien)));
    history = history.slice(cut);
  }
}

/* ===================== LẤY DỮ LIỆU TỪ API GỐC ===================== */
function findArray(obj, depth = 0) {
  if (Array.isArray(obj)) return obj;
  if (!obj || typeof obj !== 'object' || depth > 4) return null;
  const keys = ['list', 'data', 'sessions', 'items', 'result', 'results', 'rows'];
  for (const k of keys) {
    if (obj[k] !== undefined) {
      const f = findArray(obj[k], depth + 1);
      if (f) return f;
    }
  }
  for (const k of Object.keys(obj)) {
    const f = findArray(obj[k], depth + 1);
    if (f && f.length && typeof f[0] === 'object') return f;
  }
  return null;
}

function toDices(it) {
  let d = it.dices ?? it.dice ?? it.xucxac ?? it.xuc_xac ?? it.diceList ?? null;
  if (typeof d === 'string') d = d.split(/[^0-9]+/).filter(Boolean).map(Number);
  if (!Array.isArray(d)) {
    d = [
      it.dice1 ?? it.d1 ?? it.firstDice,
      it.dice2 ?? it.d2 ?? it.secondDice,
      it.dice3 ?? it.d3 ?? it.thirdDice,
    ];
  }
  d = d.map(Number);
  if (d.length === 3 && d.every((x) => Number.isInteger(x) && x >= 1 && x <= 6)) return d;
  return null;
}

function normalize(it, idx) {
  if (!it || typeof it !== 'object') return null;
  const dices = toDices(it);
  if (!dices) return null;
  const rawId = it.id ?? it.sessionId ?? it.session_id ?? it.session ?? it.phien ?? it.sid ?? it.no;
  if (rawId === undefined || rawId === null) return null;
  const phien = String(rawId);
  let n = Number(phien.replace(/\D/g, ''));
  if (!Number.isFinite(n)) n = idx;
  const sum = dices[0] + dices[1] + dices[2];
  return { phien, n, dices, sum, kq: sum >= 11 ? 'T' : 'X' };
}

async function fetchSessions() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(API_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    const arr = findArray(json) || [];
    return arr.map(normalize).filter(Boolean);
  } finally {
    clearTimeout(timer);
  }
}

async function poll() {
  try {
    const items = await fetchSessions();
    let added = 0;
    for (const r of items) {
      if (!store.has(r.phien)) { store.set(r.phien, r); added++; }
    }
    if (added > 0) {
      rebuild();
      dirty = true;
      saveFile();
    }
    if (history.length) {
      const last = history[history.length - 1];
      if (last.phien !== lastPhien) {
        lastPhien = last.phien;
        lastPrediction = buildPrediction();
      }
    }
  } catch (e) {
    console.error('[poll] lỗi lấy dữ liệu:', e.message);
  }
}

/* ===================== DỮ LIỆU CẦU ===================== */
const nameOf = (v) => (v === 'T' ? 'Tài' : 'Xỉu');

function runsOf(seq) {
  const runs = [];
  for (const v of seq) {
    const last = runs[runs.length - 1];
    if (last && last.v === v) last.len++;
    else runs.push({ v, len: 1 });
  }
  return runs;
}

function describeRuns(runs) {
  const lens = runs.map((r) => r.len);
  const tail = lens.slice(-4);
  if (tail.length >= 2 && tail.every((x) => x === 1)) return '1-1';
  if (tail.length && runs[runs.length - 1].len >= 4) return 'Bệt ' + runs[runs.length - 1].len;
  return tail.join('-');
}

function buildTables() {
  const tables = [];
  for (let i = 0; i < history.length; i += TABLE_SIZE) {
    const chunk = history.slice(i, i + TABLE_SIZE);
    const seq = chunk.map((r) => r.kq);
    const runs = runsOf(seq);
    const bet = runs.filter((r) => r.len >= 4).map((r) => nameOf(r.v) + ' x' + r.len);
    tables.push({
      Bang: tables.length + 1,
      Hoan_thanh: chunk.length === TABLE_SIZE,
      So_ket_qua: chunk.length,
      Phien_dau: chunk[0].phien,
      Phien_cuoi: chunk[chunk.length - 1].phien,
      Day_cau: seq.map((v) => (v === 'T' ? 'T' : 'X')).join(' '),
      Xuc_xac: chunk.map((r) => r.dices.join('-')),
      Dang_cau: runs.map((r) => r.len).join('-'),
      Cau_bet: bet,
    });
  }
  return tables;
}

function buildCauData() {
  const tables = buildTables();
  const seq = history.map((r) => r.kq);
  const runs = runsOf(seq);
  return {
    Tong_phien: history.length,
    Tong_bang: tables.length,
    Cau_hien_tai: runs.length ? describeRuns(runs) : null,
    Bang_cau: tables,
  };
}

/* ===================== THUẬT TOÁN DỰ ĐOÁN ===================== */
/**
 * Dựa trên dãy cầu (cùng dữ liệu của /dulieucau), với cầu đang chạy (độ dài run hiện tại L)
 * và ngữ cảnh k run trước đó (vd 2-1-2, 1-1, 2-2...), tìm trong lịch sử các lần cầu y hệt:
 * cầu đó đã đi tiếp (theo) hay đã dừng đúng chỗ (bẻ). Từ đó ra xác suất theo/bẻ.
 */
function buildPrediction() {
  if (!history.length) return null;
  const last = history[history.length - 1];
  const seq = history.map((r) => r.kq);
  const runs = runsOf(seq);
  const n = runs.length;
  const cur = runs[n - 1];
  const L = cur.len;

  let num = 0;
  let den = 0;
  let best = null;

  for (let k = 0; k <= 4; k++) {
    if (n - 1 - k < 0) break;
    const ctx = runs.slice(n - 1 - k, n - 1).map((r) => r.len).join('-');
    let cont = 0;
    let brk = 0;
    for (let j = k; j <= n - 2; j++) {
      if (runs[j].len < L) continue;
      const c = runs.slice(j - k, j).map((r) => r.len).join('-');
      if (c !== ctx) continue;
      const w = 1 + j / n; // phiên gần đây có trọng số cao hơn
      if (runs[j].len > L) cont += w; else brk += w;
    }
    const tot = cont + brk;
    if (tot <= 0) continue;
    const p = (cont + 1) / (tot + 2);
    const weight = (k + 1) * (tot / (tot + 2));
    num += weight * p;
    den += weight;
    if (!best || weight > best.weight) best = { k, ctx, cont, brk, tot, weight };
  }

  let pc = den > 0 ? (num + 0.5 * 0.3) / (den + 0.3) : 0.5; // xác suất cầu đi tiếp (theo)
  const notes = [];

  // Điểm dừng cho cầu bệt: bệt từ 4 trở đi thì càng dài càng phải cân nhắc bẻ
  if (L >= 4) {
    const pen = Math.min(0.25, (L - 3) * 0.04);
    pc -= pen;
    notes.push(`bệt ${L} phiên ${nameOf(cur.v)}, đã vào vùng cân nhắc điểm dừng`);
  }

  // Tính thầm điểm xúc xắc phiên vừa ra
  const s = last.sum;
  const triple = last.dices[0] === last.dices[1] && last.dices[1] === last.dices[2];
  if (triple) { pc -= 0.04; notes.push(`bộ ba ${last.dices.join('-')} có tín hiệu bẻ`); }
  else if (s <= 5 || s >= 16) { pc -= 0.03; notes.push(`điểm cực đoan ${s}, nghiêng về bẻ nhẹ`); }
  else if (s === 10 || s === 11) { pc += 0.02; notes.push(`điểm sát ngưỡng ${s}, nghiêng về theo nhẹ`); }

  pc = Math.max(0.2, Math.min(0.8, pc));

  const follow = pc >= 0.5;
  const predSide = follow ? cur.v : (cur.v === 'T' ? 'X' : 'T');
  const strength = Math.abs(pc - 0.5);
  const how = follow ? (strength > 0.15 ? 'theo mạnh' : 'theo nhẹ') : (strength > 0.15 ? 'bẻ mạnh' : 'bẻ nhẹ');

  let confidence = Math.round(50 + strength * 100);
  confidence = Math.max(51, Math.min(60, confidence)); // kết quả xúc xắc là ngẫu nhiên nên không để độ tin cậy ảo cao
  if (history.length < TABLE_SIZE) confidence = Math.min(confidence, 55);

  const dang = describeRuns(runs);
  let reason = `Dựa vào /dulieucau: cầu đang chạy dạng ${dang}, hiện ${L} phiên ${nameOf(cur.v)} liên tiếp`;
  if (best) {
    reason += `; cầu này trong lịch sử đã đi tiếp ${Math.round(best.cont)} lần, dừng ${Math.round(best.brk)} lần`;
  } else {
    reason += '; chưa đủ mẫu cầu tương tự';
  }
  if (notes.length) reason += '; ' + notes.join('; ');
  reason += `. Chọn ${how}.`;

  return {
    Id: ID_NAME,
    Phien: last.phien,
    Ket_qua: nameOf(last.kq),
    Xuc_xac: last.dices.join('-'),
    Du_doan: nameOf(predSide),
    Do_tin_cay: confidence + '%',
    Li_do: reason,
  };
}

/* ===================== HTTP SERVER ===================== */
function send(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = (req.url || '').split('?')[0].replace(/\/+$/, '') || '/';
  if (req.method !== 'GET') return send(res, 405, { loi: 'Method not allowed' });

  if (url === '/dulieucau') {
    if (!history.length) return send(res, 200, { thong_bao: 'Đang chờ dữ liệu từ API gốc...' });
    return send(res, 200, buildCauData());
  }
  if (url === '/dudoanlc79') {
    const p = lastPrediction || buildPrediction();
    if (!p) return send(res, 200, { thong_bao: 'Đang chờ dữ liệu từ API gốc...' });
    return send(res, 200, p);
  }
  return send(res, 404, { loi: 'Not found' });
});

loadFile();
if (history.length) lastPrediction = buildPrediction();

server.listen(PORT, '0.0.0.0', () => {
  console.log('Server chạy ở cổng ' + PORT);
  poll();
  setInterval(poll, POLL_MS);
});

process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));