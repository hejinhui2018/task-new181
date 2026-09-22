'use strict';
// HTTP API：静态前端 + /api 命令接口与派生视图。
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Store } = require('./persistence');
const domain = require('./domain');

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const DATA_DIR = process.env.CH_DATA_DIR || path.join(__dirname, '..', 'data');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const store = new Store(DATA_DIR);

function buildView() {
  const s = store.state;
  const r = domain.readiness(s);
  const quarantine = domain.quarantineList(s);
  const timeline = domain.roundTimeline(s);
  return {
    meta: s.meta,
    definitions: s.definitions,
    regions: s.regions,
    products: s.products,
    clauses: s.clauses,
    rounds: s.rounds,
    timeline,
    packages: s.packages.map((p) => ({ ...p, receipt: domain.packageReceiptStatus(s, p) })),
    readiness: r.rows,
    conflicts: r.conflicts,
    quarantine: quarantine,
    releaseCandidates: domain.releaseCandidates(s),
    audit: s.audit.slice(-200).reverse(),
    recoveryEvents: s.recoveryEvents.slice(-50),
    openRoundId: (domain.currentOpenRound(s) || {}).id || null,
    appliedSeq: store.appliedSeq,
  };
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 2_000_000) reject(new Error('body too large')); });
    req.on('end', () => {
      if (!buf) return resolve({});
      try { resolve(JSON.parse(buf)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA 回退
      if (urlPath.startsWith('/api/')) { res.writeHead(404); return res.end('not found'); }
      return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, idx) => {
        if (e2) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(idx);
      });
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = req.url.split('?')[0];
    if (req.method === 'GET' && url === '/api/state') return sendJson(res, 200, buildView());

    if (req.method === 'POST' && url === '/api/dispatch') {
      const body = await readBody(req);
      if (!body.type) return sendJson(res, 400, { error: '缺少 type' });
      try {
        const result = store.dispatch(body.type, body.args || {});
        return sendJson(res, 200, { ok: true, result, view: buildView() });
      } catch (e) {
        return sendJson(res, e.status || 500, { ok: false, error: e.message });
      }
    }

    if (req.method === 'POST' && url === '/api/seed') {
      const { seedDemo } = require('./seed');
      seedDemo(store);
      return sendJson(res, 200, { ok: true, view: buildView() });
    }

    if (req.method === 'POST' && url === '/api/checkpoint') {
      store.forceCheckpoint();
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url === '/api/debug/fault') {
      // 异常演练：corrupt_snapshot / truncate_wal
      const body = await readBody(req);
      if (body.kind === 'corrupt_snapshot') store._debugCorruptSnapshot();
      else if (body.kind === 'truncate_wal') store._debugTruncateWalTail();
      else return sendJson(res, 400, { error: '未知故障类型' });
      return sendJson(res, 200, { ok: true, hint: '故障已注入，重启进程后触发恢复' });
    }

    if (req.method === 'POST' && url === '/api/reload') {
      store.reload();
      return sendJson(res, 200, { ok: true, view: buildView() });
    }

    if (req.method === 'GET' && url.startsWith('/api/')) return sendJson(res, 404, { error: 'unknown api' });
    return serveStatic(req, res);
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`ClauseHarbor 运行于 http://localhost:${PORT}  数据目录: ${DATA_DIR}`);
});

module.exports = { server, store };
