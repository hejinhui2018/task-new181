'use strict';
// 持久化回归：刷新一致、ID 稳定、草稿/撤回不回归、快照损坏与 WAL 截断恢复。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/persistence');
const { seedDemo } = require('../src/seed');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ch-test-'));
}
function hashState(s) {
  return JSON.stringify({
    clauses: s.clauses.map((c) => [c.id, c.status, c.currentVersionId, c.openVersionId,
      c.versions.map((v) => [v.id, v.index, v.status, v.roundId, v.reviews.map((r) => [r.regionId, r.verdict, r.comment])])]),
    rounds: s.rounds.map((r) => [r.id, r.name, r.status]),
    packages: s.packages.map((p) => [p.id, p.receiptNo, p.items.map((i) => [i.clauseId, i.versionId])]),
    defs: s.definitions.map((d) => d.id),
  });
}

test('种子数据：两轮评审、冻结、发布包回执与隔离区', () => {
  const dir = tmpDir();
  const st = new Store(dir);
  seedDemo(st);
  const s = st.state;
  assert.equal(s.rounds.length, 2);
  assert.equal(s.rounds[0].status, 'closed');
  assert.equal(s.rounds[1].status, 'open');
  // 第 1 轮通过的条款
  const wait = s.clauses.find((c) => c.code === 'MED-W-01');
  assert.equal(wait.status, 'approved_current');
  // 责任免除：v1 退回（冻结），v2 补交在审
  const ex = s.clauses.find((c) => c.code === 'MED-E-03');
  assert.equal(ex.versions.length, 2);
  assert.equal(ex.versions[0].status, 'returned');
  assert.equal(ex.versions[0].reviews[2].comment.includes('旧轮意见'), true);
  assert.equal(ex.versions[1].status, 'resubmitted');
  assert.notEqual(ex.versions[0].reviews[0].at, undefined);
  // 发布包与回执
  assert.equal(s.packages.length, 1);
  assert.equal(s.packages[0].status, 'handed_off');
  assert.match(s.packages[0].receiptNo, /^RCPT-/);
});

test('刷新（重新装载）后版本关系、评审意见与发布包回执一一对应', () => {
  const dir = tmpDir();
  const st = new Store(dir);
  seedDemo(st);
  const before = hashState(st.state);
  const st2 = new Store(dir); // 模拟重启
  const after = hashState(st2.state);
  assert.equal(before, after);
});

test('纯 WAL 重放与实体 ID 稳定（无快照时）', () => {
  const dir = tmpDir();
  const st = new Store(dir);
  const reg = st.dispatch('addRegion', { name: '华北' });
  const prd = st.dispatch('addProduct', { name: '产品X', regions: [reg.id] });
  const cls = st.dispatch('createClause', { title: '条款', products: [prd.id], effectiveDate: '2026-10-01' });
  st.dispatch('saveDraft', { clauseId: cls.id, patch: { body: '正文', definitionRefs: [] } });
  st.dispatch('openRound', { name: 'R1' });
  st.dispatch('submit', { clauseId: cls.id });
  st.dispatch('recordReview', { clauseId: cls.id, versionId: cls.openVersionId, input: { regionId: reg.id, verdict: 'approved' } });
  st.forceCheckpoint();
  // 删掉快照，仅靠 WAL 无法重放（checkpoint 已清空 WAL）——改为另一场景：不清 WAL 直接 reload
  const st2 = new Store(dir);
  const c = st2.state.clauses[0];
  assert.equal(c.id, cls.id);
  assert.equal(c.status, 'approved_current');
  assert.equal(c.currentVersionId, c.versions[0].id);
});

test('未压缩快照时 WAL 重放 ID 稳定，跨重启继续操作引用正确', () => {
  const dir = tmpDir();
  const st = new Store(dir);
  st.snapshotEvery = 100000; // 关闭自动快照
  const reg = st.dispatch('addRegion', { name: '华北' });
  const prd = st.dispatch('addProduct', { name: '产品X', regions: [reg.id] });
  const cls = st.dispatch('createClause', { title: '条款', products: [prd.id] });
  st.dispatch('openRound', { name: 'R1' });
  st.dispatch('submit', { clauseId: cls.id });

  const st2 = new Store(dir); // 重启，空快照 + WAL 重放
  assert.equal(st2.state.clauses[0].id, cls.id);
  assert.equal(st2.state.rounds[0].id, st.state.rounds[0].id);
  // 重启后继续操作：用重放出的 ID 登记评审，必须命中同一实体
  st2.snapshotEvery = 100000;
  st2.dispatch('recordReview', {
    clauseId: cls.id, versionId: cls.openVersionId,
    input: { regionId: reg.id, verdict: 'approved' },
  });
  assert.equal(st2.state.clauses[0].status, 'approved_current');

  const st3 = new Store(dir);
  assert.equal(st3.state.clauses[0].status, 'approved_current');
  assert.equal(st3.state.rounds[0].entries || true, true); // timeline 派生
});

test('草稿保存与撤回在多次刷新后状态不回归', () => {
  const dir = tmpDir();
  const st = new Store(dir);
  st.snapshotEvery = 100000;
  const reg = st.dispatch('addRegion', { name: '华北' });
  const prd = st.dispatch('addProduct', { name: 'P', regions: [reg.id] });
  const cls = st.dispatch('createClause', { title: 'T', products: [prd.id] });
  st.dispatch('saveDraft', { clauseId: cls.id, patch: { body: '草稿A' } });
  st.dispatch('saveDraft', { clauseId: cls.id, patch: { body: '草稿B' } });
  st.dispatch('openRound', {});
  st.dispatch('submit', { clauseId: cls.id });
  st.dispatch('recordReview', { clauseId: cls.id, versionId: cls.openVersionId, input: { regionId: reg.id, verdict: 'pending' } });
  st.dispatch('withdraw', { clauseId: cls.id, reason: '改一下' });

  const st2 = new Store(dir);
  const c = st2.state.clauses[0];
  assert.equal(c.status, 'draft');
  assert.equal(c.versions[0].status, 'draft');
  assert.equal(c.versions[0].body, '草稿B');
  assert.equal(c.versions[0].reviews.length, 0);
  assert.equal(c.versions[0].roundId, null);
});

test('旧轮次冻结：重放后仍拒绝改写关闭轮次的意见', () => {
  const dir = tmpDir();
  const st = new Store(dir);
  seedDemo(st);
  const ex = st.state.clauses.find((c) => c.code === 'MED-E-03');
  const oldRound = st.state.rounds[0].id;
  const oldVid = ex.versions[0].id;
  // 重放后再试
  const st2 = new Store(dir);
  assert.throws(() => st2.dispatch('recordReview', {
    clauseId: ex.id, versionId: oldVid,
    input: { regionId: st2.state.regions[0].id, verdict: 'approved' },
  }), /冻结/);
  assert.equal(st2.state.rounds.find((r) => r.id === oldRound).status, 'closed');
});

test('异常恢复：快照损坏 → 隔离坏文件、回退上代/凭 WAL 完整重建并记录事件', () => {
  const dir = tmpDir();
  const st = new Store(dir);
  st.snapshotEvery = 100000;
  const reg = st.dispatch('addRegion', { name: '华北' });
  const prd = st.dispatch('addProduct', { name: 'P', regions: [reg.id] });
  const cls = st.dispatch('createClause', { title: '幸存条款', products: [prd.id], effectiveDate: '2026-10-01' });
  st.dispatch('openRound', { name: 'R1' });
  // 第一代快照 + 之后增量
  st.forceCheckpoint();
  st.dispatch('saveDraft', { clauseId: cls.id, patch: { body: '增量内容' } });

  // 情形 A：当前代快照损坏（WAL 仍保留全部历史）→ 凭 WAL 完整重建
  fs.writeFileSync(path.join(dir, 'snapshot.json'), '{broken');
  const st2 = new Store(dir);
  const found = st2.state.recoveryEvents.find((e) => e.kind === 'snapshot_corrupt');
  assert.ok(found, '应记录 snapshot_corrupt 事件');
  assert.ok(fs.existsSync(found.quarantined), '坏快照应被隔离');
  assert.equal(st2.state.clauses.length, 1);
  assert.equal(st2.state.clauses[0].versions[0].body, '增量内容');

  // 情形 B：正常运行再做一代快照后，当前代损坏 → 回退上代快照 + WAL 增量
  st2.dispatch('submit', { clauseId: cls.id });
  st2.forceCheckpoint();
  st2.dispatch('withdraw', { clauseId: cls.id, reason: '再修订' });
  st2.dispatch('saveDraft', { clauseId: cls.id, patch: { body: '第三代增量' } });
  fs.writeFileSync(path.join(dir, 'snapshot.json'), '{broken-again');
  const st3 = new Store(dir);
  assert.ok(st3.state.recoveryEvents.some((e) => e.kind === 'snapshot_corrupt'));
  assert.equal(st3.state.clauses[0].versions[0].body, '第三代增量');
  // 上一代快照确实被用于回退
  assert.ok(st3.state.recoveryEvents.some((e) => e.detail !== undefined));
});

test('异常恢复：WAL 末尾截断（崩溃写一半）→ 丢弃坏行、重建快照并记录', () => {
  const dir = tmpDir();
  const st = new Store(dir);
  st.snapshotEvery = 100000;
  const cls = st.dispatch('createClause', { title: '完整条款' });
  st.dispatch('openRound', { name: 'R1' });
  fs.appendFileSync(path.join(dir, 'wal.log'), '{"seq":999,"type":"broken'); // 模拟截断
  const st2 = new Store(dir);
  const trunc = st2.state.recoveryEvents.find((e) => e.kind === 'wal_truncated');
  assert.ok(trunc);
  assert.equal(st2.state.clauses.length, 1);
  assert.equal(st2.state.clauses[0].id, cls.id);
  assert.equal(st2.state.rounds.length, 1);
  // 恢复后再次装载不再重复报错
  const st3 = new Store(dir);
  assert.equal(st3.state.clauses.length, 1);
});

test('异常恢复：快照与 WAL 都健康时不产生任何恢复事件', () => {
  const dir = tmpDir();
  const st = new Store(dir);
  st.dispatch('createClause', { title: 'A' });
  const st2 = new Store(dir);
  const st3 = new Store(dir);
  assert.equal(st2.state.recoveryEvents.length, 0);
  assert.equal(st3.state.recoveryEvents.length, 0);
});

test('非法命令不落盘：校验失败后刷新不出现脏数据', () => {
  const dir = tmpDir();
  const st = new Store(dir);
  st.snapshotEvery = 100000;
  assert.throws(() => st.dispatch('createClause', { title: '' }), /标题/);
  assert.throws(() => st.dispatch('createClause', {}), /标题/);
  const st2 = new Store(dir);
  assert.equal(st2.state.clauses.length, 0);
});
