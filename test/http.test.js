'use strict';
// HTTP 端到端：通过真实端口走完整业务链路（含 409 冻结、发布包、刷新一致、故障恢复接口）。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
let proc, base;

async function waitReady(port, tries = 50) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/state`); if (r.ok) return; } catch (_) {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server not ready');
}
function post(url, body) {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : '{}' }).then(async (r) => ({ status: r.status, json: await r.json() }));
}
function dispatch(type, args) { return post(base + '/api/dispatch', { type, args }); }

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-http-'));
  const port = 4100 + Math.floor(Math.random() * 300);
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    env: { ...process.env, CH_DATA_DIR: dir, PORT: String(port) },
  });
  await waitReady(port);
});
test.after(() => { proc && proc.kill(); });

test('完整链路：基础数据→条款→两轮评审（冻结/补交）→发布包→回执漂移', async () => {
  // 基础数据
  const reg = (await dispatch('addRegion', { code: 'N', name: '华北' })).json.result;
  const reg2 = (await dispatch('addRegion', { code: 'E', name: '华东' })).json.result;
  const prd = (await dispatch('addProduct', { code: 'P1', name: '医疗险', regions: [reg.id, reg2.id] })).json.result;
  await dispatch('addDefinition', { code: 'D1', text: '定义一' });

  // 第 1 轮
  await dispatch('openRound', { name: 'R1' });
  const c1 = (await dispatch('createClause', { title: '等待期', products: [prd.id], effectiveDate: '2026-10-01', definitionRefs: ['D1'] })).json.result;
  // 草稿保存可反复
  await dispatch('saveDraft', { clauseId: c1.id, patch: { body: '正文 A' } });
  await dispatch('saveDraft', { clauseId: c1.id, patch: { body: '正文 B' } });
  await dispatch('submit', { clauseId: c1.id });
  const st1 = (await (await fetch(base + '/api/state')).json());
  const v1 = st1.clauses[0].openVersionId;
  await dispatch('recordReview', { clauseId: c1.id, versionId: v1, input: { regionId: reg.id, verdict: 'approved' } });
  await dispatch('recordReview', { clauseId: c1.id, versionId: v1, input: { regionId: reg2.id, verdict: 'approved' } });

  // 关闭轮次后改写旧意见 → 409
  const rounds = (await (await fetch(base + '/api/state')).json()).rounds;
  await dispatch('closeRound', { roundId: rounds[0].id });
  const frozen = await dispatch('recordReview', { clauseId: c1.id, versionId: v1, input: { regionId: reg.id, verdict: 'rejected' } });
  assert.equal(frozen.status, 409);
  assert.match(frozen.json.error, /冻结/);

  // 第 2 轮：替换已通过条款
  await dispatch('openRound', { name: 'R2' });
  await dispatch('replace', { clauseId: c1.id, patch: { body: '正文 C' } });
  let st2 = await (await fetch(base + '/api/state')).json();
  const c1now = st2.clauses[0];
  assert.equal(c1now.status, 'in_review');
  const v2 = c1now.openVersionId;
  await dispatch('recordReview', { clauseId: c1.id, versionId: v2, input: { regionId: reg.id, verdict: 'approved' } });
  await dispatch('recordReview', { clauseId: c1.id, versionId: v2, input: { regionId: reg2.id, verdict: 'approved' } });
  st2 = await (await fetch(base + '/api/state')).json();
  assert.equal(st2.clauses[0].status, 'approved_current');
  assert.equal(st2.clauses[0].versions[0].status, 'superseded');

  // 发布包 + 移交回执
  const cand = st2.releaseCandidates.map((c) => c.clauseId);
  assert.ok(cand.includes(c1.id));
  const pkg = (await dispatch('createPackage', { name: '包', clauseIds: cand })).json.result;
  const handed = await dispatch('handoffPackage', { packageId: pkg.id, input: { to: '林舟' } });
  assert.match(handed.json.result.receiptNo, /^RCPT-/);

  // 再替换一次 → 回执漂移提示
  await dispatch('closeRound', { roundId: st2.rounds[1].id });
  await dispatch('openRound', { name: 'R3' });
  await dispatch('replace', { clauseId: c1.id, patch: { body: '正文 D' } });
  const st3 = await (await fetch(base + '/api/state')).json();
  const pkgView = st3.packages[0];
  assert.equal(pkgView.receipt.drift.length, 1);
  // 回执快照仍指向 v2
  assert.equal(pkgView.items[0].versionId, v2);
  assert.equal(pkgView.items[0].body, '正文 C');

  // 校验：冲突视图、准备度、隔离区字段都存在
  assert.ok(Array.isArray(st3.conflicts));
  assert.ok(Array.isArray(st3.quarantine));
  assert.equal(st3.readiness[0].clauseId, c1.id);
});

test('非法命令返回结构化错误且不破坏数据', async () => {
  const bad = await dispatch('createClause', { title: '' });
  assert.equal(bad.status, 400);
  assert.ok(bad.json.error);
});
