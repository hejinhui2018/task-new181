/* 持久化测试：WAL 提交、崩溃恢复链、草稿通道、回执防篡改、备份导入 */
const test = require('node:test');
const assert = require('node:assert');
const CH = require('../js/engine.js');
const CHStore = require('../js/store.js');
const seed = require('../js/seed.js');

class MemStorage {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
  get length() { return this.m.size; }
  key(i) { return [...this.m.keys()][i] || null; }
  _set(k, v) { this.m.set(k, v); }
}

const K = CHStore.KEYS;
const ctx = actor => ({ now: '2026-09-20T08:00:00.000Z', actor: actor || '测试法务' });
const fresh = () => { const s = CHStore.makeStore(new MemStorage()); s.init(() => seed.buildSeed()); return s; };
// 模拟刷新：同一底层存储上新建 store 实例
const refresh = storage => { const s = CHStore.makeStore(storage); const booted = s.init(() => seed.buildSeed()); return { store: s, notes: booted.recovery }; };

test('正常提交后刷新，数据完整保留', () => {
  const storage = new MemStorage();
  const s = CHStore.makeStore(storage);
  s.init(() => seed.buildSeed());
  const before = s.db();
  const c1 = before.clauses.find(c => c.code === 'CL-ACC-01');
  s.commit('补交', db => CH.followUpVersion(db, c1.id, { kind: 'resubmit', content: '修订', effectiveDate: '2026-11-01' }, ctx()));
  assert.equal(storage.getItem(K.wal), null, '提交完成后 WAL 已清理');

  const { store: s2 } = refresh(storage);
  const after = s2.db();
  const c1b = after.clauses.find(c => c.code === 'CL-ACC-01');
  assert.equal(c1b.versions.length, 2);
  assert.equal(c1b.currentVersionId, c1b.versions[1].id);
  // 发布回执随刷新保持对应
  const pk = after.packages.find(p => p.status === 'released');
  assert.ok(s2.verifyPackageReceipt(pk).ok);
});

test('崩溃在 WAL 写入后：重启自动前滚到新状态并留恢复提示', () => {
  const storage = new MemStorage();
  const s = CHStore.makeStore(storage);
  s.init(() => seed.buildSeed());
  s.setFault('wal');
  assert.throws(() => s.commit('新建定义X', db => CH.upsertDefinition(db, { term: '定义X', content: 'x' }, ctx())));
  assert.ok(storage.getItem(K.wal), 'WAL 已落盘');

  const { store: s2, notes } = refresh(storage);
  assert.ok(s2.db().definitions.some(d => d.term === '定义X'), 'WAL 前滚生效');
  assert.equal(storage.getItem(K.wal), null, '前滚后 WAL 清理');
  assert.ok(notes.some(n => /WAL 前滚/.test(n.text)));
});

test('崩溃在备份后主库切换前：重启前滚，不丢事务', () => {
  const storage = new MemStorage();
  const s = CHStore.makeStore(storage);
  s.init(() => seed.buildSeed());
  s.setFault('backup');
  assert.throws(() => s.commit('新建定义Y', db => CH.upsertDefinition(db, { term: '定义Y', content: 'y' }, ctx())));
  const { store: s2 } = refresh(storage);
  assert.ok(s2.db().definitions.some(d => d.term === '定义Y'));
});

test('崩溃在主库切换后清 WAL 前：重启识别一致状态，仅清理 WAL', () => {
  const storage = new MemStorage();
  const s = CHStore.makeStore(storage);
  s.init(() => seed.buildSeed());
  s.setFault('commit');
  assert.throws(() => s.commit('新建定义Z', db => CH.upsertDefinition(db, { term: '定义Z', content: 'z' }, ctx())));
  assert.ok(storage.getItem(K.wal));
  const { store: s2, notes } = refresh(storage);
  assert.ok(s2.db().definitions.some(d => d.term === '定义Z'));
  assert.equal(storage.getItem(K.wal), null);
  assert.ok(notes.every(n => !/前滚/.test(n.text)), '状态一致时无需前滚');
});

test('WAL 损坏：忽略未完成事务，主库保持可用', () => {
  const storage = new MemStorage();
  const s = CHStore.makeStore(storage);
  s.init(() => seed.buildSeed());
  storage._set(K.wal, '{这不是合法JSON');
  const { store: s2, notes } = refresh(storage);
  assert.equal(s2.db().clauses.length, seed.buildSeed().clauses.length);
  assert.ok(notes.some(n => /日志损坏/.test(n.text)));
});

test('主库损坏且备份可用：回滚到上一版备份', () => {
  const storage = new MemStorage();
  const s = CHStore.makeStore(storage);
  s.init(() => seed.buildSeed());
  // 一次成功提交：备份停留在提交前（种子）状态
  s.commit('加定义W', db => CH.upsertDefinition(db, { term: '定义W', content: 'w' }, ctx()));
  assert.ok(s.db().definitions.some(d => d.term === '定义W'));
  // 主库损坏
  storage._set(K.db, '###corrupt###');
  const { store: s2, notes } = refresh(storage);
  assert.ok(!s2.db().definitions.some(d => d.term === '定义W'), '已回滚到备份');
  assert.equal(s2.db().clauses.length, seed.buildSeed().clauses.length);
  assert.ok(notes.some(n => /回滚/.test(n.text)));
});

test('表单草稿走独立通道：事务失败不丢草稿', () => {
  const storage = new MemStorage();
  const s = CHStore.makeStore(storage);
  s.init(() => seed.buildSeed());
  const c1 = s.db().clauses[0].id;
  s.saveFormDraft(c1, { title: '填了一半', content: '草稿正文' });
  s.setFault('wal');
  assert.throws(() => s.commit('失败事务', db => CH.upsertDefinition(db, { term: '炸', content: 'b' }, ctx())));
  const s2 = CHStore.makeStore(storage);
  s2.init(() => seed.buildSeed());
  const d = s2.getFormDraft(c1);
  assert.equal(d.patch.title, '填了一半');
  assert.equal(s2.listFormDrafts().length, 1);
  s2.clearFormDraft(c1);
  assert.equal(s2.getFormDraft(c1), null);
});

test('回执防篡改：改动封存正文或回执指纹都会校验失败', () => {
  const storage = new MemStorage();
  const s = CHStore.makeStore(storage);
  s.init(() => seed.buildSeed());
  const pk = s.db().packages.find(p => p.status === 'released');

  const ok1 = s.verifyPackageReceipt(pk);
  assert.ok(ok1.ok, '原始回执校验一致');

  // 篡改条目快照
  const tampered1 = JSON.parse(JSON.stringify(pk));
  tampered1.entries[0].contentSnapshot = '被改过的正文';
  assert.equal(s.verifyPackageReceipt(tampered1).ok, false);

  // 篡改回执指纹
  const tampered2 = JSON.parse(JSON.stringify(pk));
  tampered2.receipt.fingerprint = 'fnv32-deadbeef';
  assert.equal(s.verifyPackageReceipt(tampered2).ok, false);
});

test('备份导入：校验和不一致时拒绝', () => {
  const s = fresh();
  const good = s.exportJSON();
  assert.doesNotThrow(() => s.importJSON(good));
  const parsed = JSON.parse(good);
  parsed.db.definitions[0].content = '偷偷改掉';
  assert.throws(() => s.importJSON(JSON.stringify(parsed)), /校验和不一致/);
});

test('审计日志随每次写操作追加，刷新后仍可追溯', () => {
  const storage = new MemStorage();
  const s = CHStore.makeStore(storage);
  s.init(() => seed.buildSeed());
  const n0 = s.db().audit.length;
  s.commit('补交流程', db => {
    const c = db.clauses[0];
    CH.followUpVersion(db, c.id, { kind: 'resubmit', content: 'x', effectiveDate: '2026-12-01' }, ctx());
  });
  assert.ok(s.db().audit.length > n0);
  const { store: s2 } = refresh(storage);
  assert.ok(s2.db().audit.some(a => /补交/.test(a.detail)));
});
