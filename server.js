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
        if (predMeta) {
          const nx = history.find((r) => r.n > predMeta.afterN);
          if (nx) { live.tong++; if (nx.kq === predMeta.side) live.dung++; }
        }
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
    Thong_ke: {
      Du_doan_dung: live.dung,
      Du_doan_tong: live.tong,
      Ti_le_thuc_te: live.tong ? Math.round((live.dung / live.tong) * 100) + '%' : 'chưa có',
      Thuat_toan: modelStats,
    },
    Bang_cau: tables,
  };
}

/* ===================== THUẬT TOÁN DỰ ĐOÁN (NHIỀU MÔ HÌNH BỎ PHIẾU) ===================== */
const MAX_USE = 600;   // chỉ dùng 600 phiên gần nhất để tính cho nhẹ
const BT_WINDOW = 100; // số phiên gần nhất dùng để chấm điểm từng thuật toán
const live = { dung: 0, tong: 0 };
let modelStats = [];
let predMeta = null;
let runMeta = null;

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const logit = (p) => { p = clamp(p, 0.02, 0.98); return Math.log(p / (1 - p)); };
const sigm = (z) => 1 / (1 + Math.exp(-z));
const smooth = (hit, tot, k) => {
  const p = (hit + 1) / (tot + 2);
  const w = tot / (tot + k);
  return 0.5 * (1 - w) + p * w;
};
const pointBucket = (p) => (p <= 7 ? 0 : p <= 10 ? 1 : p <= 13 ? 2 : p <= 16 ? 3 : 4);

// Mỗi mô hình: (S, h, n) -> xác suất phiên thứ n ra Tài, chỉ dùng dữ liệu trước n. null = chưa đủ dữ liệu.
// S là chuỗi 'T'/'X', h là mảng bản ghi (có .sum, .dices)

// 1) Cầu theo/bẻ: thế cầu y hệt trong lịch sử đã đi tiếp hay đã dừng, có điểm dừng cho bệt
function mRun(S, h, n) {
  const runs = runsOf(S.slice(0, n));
  const m = runs.length;
  if (m < 3) return null;
  const cur = runs[m - 1];
  const L = cur.len;
  let num = 0, den = 0, best = null;
  for (let k = 0; k <= 4; k++) {
    if (m - 1 - k < 0) break;
    const ctx = runs.slice(m - 1 - k, m - 1).map((r) => r.len).join('-');
    let cont = 0, brk = 0;
    for (let j = k; j <= m - 2; j++) {
      if (runs[j].len < L) continue;
      const c = runs.slice(j - k, j).map((r) => r.len).join('-');
      if (c !== ctx) continue;
      const w = 1 + j / m;
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
  let pc = den > 0 ? (num + 0.15) / (den + 0.3) : 0.5;
  if (L >= 4) pc -= Math.min(0.25, (L - 3) * 0.04); // điểm dừng của bệt
  pc = clamp(pc, 0.2, 0.8);
  runMeta = { best, L, cur, runs };
  return cur.v === 'T' ? pc : 1 - pc;
}

// 2) Markov bậc k
const mMarkov = (k) => (S, h, n) => {
  if (n < k + 15) return null;
  const cur = S.substr(n - k, k);
  let hit = 0, tot = 0;
  for (let j = k; j < n; j++) {
    if (S.substr(j - k, k) === cur) { tot++; if (S[j] === 'T') hit++; }
  }
  return tot < 3 ? null : smooth(hit, tot, 4);
};

// 3) N-gram đa bậc (2..8), bậc cao ưu tiên khi đủ mẫu
function mNgram(S, h, n) {
  if (n < 30) return null;
  let p = 0.5, used = false;
  for (let k = 2; k <= 8; k++) {
    const cur = S.substr(n - k, k);
    let hit = 0, tot = 0;
    for (let j = k; j < n; j++) {
      if (S.substr(j - k, k) === cur) { tot++; if (S[j] === 'T') hit++; }
    }
    if (tot > 0) {
      const pk = (hit + 1) / (tot + 2);
      const w = tot / (tot + 5);
      p = w * pk + (1 - w) * p;
      used = true;
    }
  }
  return used ? p : null;
}

// 4) Cầu đan xen 1-1: chuỗi đan xen dài a thì lịch sử cho thấy tiếp tục đan xen hay gãy
function mZigzag(S, h, n) {
  if (n < 20) return null;
  let a = 1;
  const cnt = {};
  for (let j = 1; j < n; j++) {
    const key = Math.min(a, 8);
    const c = cnt[key] || (cnt[key] = [0, 0]);
    c[1]++;
    if (S[j] !== S[j - 1]) c[0]++;
    a = S[j] !== S[j - 1] ? a + 1 : 1;
  }
  if (a < 3) return null;
  const c = cnt[Math.min(a, 8)];
  if (!c || c[1] < 3) return null;
  const pAlt = smooth(c[0], c[1], 4);
  return S[n - 1] === 'T' ? 1 - pAlt : pAlt;
}

// 5) Cầu chu kỳ (lặp lại theo chu kỳ 2..6)
function mPeriod(S, h, n) {
  for (let p = 2; p <= 6; p++) {
    if (n < p * 3 + 10) continue;
    let ok = true;
    for (let i = n - 1; i >= n - 2 * p; i--) {
      if (S[i] !== S[i - p]) { ok = false; break; }
    }
    if (ok) return S[n - p] === 'T' ? 0.62 : 0.38;
  }
  return null;
}

// 6) Cân bằng Tài/Xỉu trong 30 phiên gần nhất (hồi quy về trung bình, rất nhẹ)
function mFreq(S, h, n) {
  if (n < 30) return null;
  let t = 0;
  for (let i = n - 30; i < n; i++) if (S[i] === 'T') t++;
  return clamp(0.5 - (t / 30 - 0.5) * 0.5, 0.35, 0.65);
}

// 7) Các mô hình theo đặc trưng của điểm xúc xắc
const mKeyed = (keyFn, d, minTot) => (S, h, n) => {
  if (n < 20) return null;
  const key = (j) => { let s = ''; for (let i = j - d; i < j; i++) s += keyFn(h[i]) + ','; return s; };
  const cur = key(n);
  let hit = 0, tot = 0;
  for (let j = d; j < n; j++) {
    if (key(j) === cur) { tot++; if (S[j] === 'T') hit++; }
  }
  return tot < minTot ? null : smooth(hit, tot, 8);
};

const MODELS = [
  ['Cầu theo/bẻ + điểm dừng bệt', mRun],
  ['Markov bậc 2', mMarkov(2)],
  ['Markov bậc 3', mMarkov(3)],
  ['Markov bậc 4', mMarkov(4)],
  ['Markov bậc 5', mMarkov(5)],
  ['N-gram đa bậc', mNgram],
  ['Cầu đan xen 1-1', mZigzag],
  ['Cầu chu kỳ', mPeriod],
  ['Cân bằng Tài/Xỉu 30 phiên', mFreq],
  ['Điểm xúc xắc phiên trước', mKeyed((r) => pointBucket(r.sum), 1, 5)],
  ['Chuỗi điểm 2 phiên', mKeyed((r) => pointBucket(r.sum), 2, 5)],
  ['Chẵn/lẻ tổng điểm', mKeyed((r) => r.sum % 2, 3, 5)],
  ['Bộ ba / điểm cực đoan', mKeyed((r) => (r.dices[0] === r.dices[1] && r.dices[1] === r.dices[2] ? 'B' : r.sum <= 5 ? 'L' : r.sum >= 16 ? 'H' : 'N'), 1, 5)],
];

const safe = (fn, S, h, n) => {
  try { const p = fn(S, h, n); return typeof p === 'number' && isFinite(p) ? p : null; } catch (e) { return null; }
};

function buildPrediction() {
  if (!history.length) return null;
  const h = history.slice(-MAX_USE);
  const n = h.length;
  const S = h.map((r) => r.kq).join('');
  const last = h[n - 1];
  const start = Math.max(30, n - BT_WINDOW);

  // chấm điểm từng thuật toán bằng backtest, rồi lấy phiếu hiện tại
  const stats = [];
  runMeta = null;
  for (const [name, fn] of MODELS) {
    let ok = 0, cnt = 0;
    for (let i = start; i < n; i++) {
      const p = safe(fn, S, h, i);
      if (p === null || Math.abs(p - 0.5) < 0.005) continue;
      cnt++;
      if ((p >= 0.5) === (S[i] === 'T')) ok++;
    }
    const acc = cnt ? ok / cnt : 0.5;
    const shrunk = (ok + 25) / (cnt + 50); // kéo về 50% khi ít mẫu để tránh may mắn ngẫu nhiên
    const w = 0.03 + Math.max(0, shrunk - 0.53) * 6;
    stats.push({ name, acc, cnt, w, p: safe(fn, S, h, n) });
  }
  const used = stats.filter((s) => s.p !== null);

  let pT = 0.5;
  if (used.length) {
    let z = 0, ws = 0;
    for (const s of used) { z += s.w * logit(s.p); ws += s.w; }
    pT = sigm(z / ws);
  }
  pT = clamp(pT, 0.38, 0.62);

  const runs = runsOf(S);
  const cur = runs[runs.length - 1];
  const L = cur.len;
  const side = pT >= 0.5 ? 'T' : 'X';
  const follow = side === cur.v;
  const strength = Math.abs(pT - 0.5);
  const how = (follow ? 'theo' : 'bẻ') + (strength > 0.08 ? ' mạnh' : ' nhẹ');

  let confidence = Math.round(Math.max(pT, 1 - pT) * 100);
  confidence = clamp(confidence, 51, 62); // xúc xắc là ngẫu nhiên nên không để độ tin cậy ảo cao
  if (n < TABLE_SIZE) confidence = Math.min(confidence, 55);

  const top = used
    .slice()
    .sort((a, b) => Math.abs(b.w * logit(b.p)) - Math.abs(a.w * logit(a.p)))
    .slice(0, 3);

  let reason = `Dựa vào /dulieucau: cầu đang chạy dạng ${describeRuns(runs)}, hiện ${L} phiên ${nameOf(cur.v)} liên tiếp`;
  if (L >= 4) reason += `, bệt ${L} đã vào vùng cân nhắc điểm dừng`;
  if (runMeta && runMeta.best) {
    reason += `; cầu này trong lịch sử đã đi tiếp ${Math.round(runMeta.best.cont)} lần, dừng ${Math.round(runMeta.best.brk)} lần`;
  }
  if (top.length) {
    reason += `; ${used.length} thuật toán bỏ phiếu, nổi bật: ` +
      top.map((t) => `${t.name} nghiêng ${t.p >= 0.5 ? 'Tài' : 'Xỉu'} (khớp ${Math.round(t.acc * 100)}%/${t.cnt} phiên gần nhất)`).join(', ');
  }
  reason += `. Chọn ${how}.`;

  modelStats = stats.map((s) => ({
    Thuat_toan: s.name,
    Phieu: s.p === null ? 'chưa đủ dữ liệu' : (s.p >= 0.5 ? 'Tài' : 'Xỉu'),
    Ti_le_backtest: s.cnt ? Math.round(s.acc * 100) + '%' : 'n/a',
    So_mau: s.cnt,
    Trong_so: Number(s.w.toFixed(3)),
  }));
  predMeta = { afterN: last.n, side };

  return {
    Id: ID_NAME,
    Phien: last.phien,
    Ket_qua: nameOf(last.kq),
    Xuc_xac: last.dices.join('-'),
    Du_doan: nameOf(side),
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