'use strict';
// 领域模型回归：草稿保存、撤回、轮次冻结、补交、替换、冲突、发布包与回执。
const test = require('node:test');
const assert = require('node:assert');
const D = require('../src/domain');

function setupWorld() {
  const s = D.emptyState();
  const r1 = D.addRegion(s, { code: 'N', name: '华北' });
  const r2 = D.addRegion(s, { code: 'E', name: '华东' });
  const p = D.addProduct(s, { code: 'P1', name: '测试医疗险', regions: [r1.id, r2.id] });
  return { s, r1, r2, p };
}
function approveEverywhere(s, c, vOrId, world, comments = {}) {
  const v = typeof vOrId === 'string' ? c.versions.find((x) => x.id === vOrId) : vOrId;
  D.recordReview(s, c.id, v.id, { regionId: world.r1.id, verdict: 'approved', comment: comments[1] || '' });
  D.recordReview(s, c.id, v.id, { regionId: world.r2.id, verdict: 'approved', comment: comments[2] || '' });
}

test('草稿可反复保存，不产生轮次数据，不影响已通过版本', () => {
  const { s, p } = setupWorld();
  const c = D.createClause(s, { title: '条款甲', products: [p.id], body: 'v0' });
  const vid = c.openVersionId;
  D.saveDraft(s, c.id, { body: 'v1' });
  D.saveDraft(s, c.id, { body: 'v2', scope: '#门诊' });
  assert.equal(s.rounds.length, 0);
  assert.equal(s.clauses[0].versions.length, 1);
  assert.equal(s.clauses[0].versions[0].body, 'v2');
  assert.equal(s.clauses[0].openVersionId, vid);
});

test('已提交非草稿版本不能再保存草稿', () => {
  const { s, p } = setupWorld();
  const c = D.createClause(s, { title: '条款甲', products: [p.id] });
  D.openRound(s, { name: 'R1' });
  D.submitVersion(s, c.id);
  assert.throws(() => D.saveDraft(s, c.id, { body: 'x' }), /不能保存草稿/);
});

test('齐审通过后条款成为当前通过版本', () => {
  const w = setupWorld();
  const c = D.createClause(w.s, { title: '条款甲', products: [w.p.id], effectiveDate: '2026-10-01' });
  D.openRound(w.s, { name: 'R1' });
  const v = D.submitVersion(w.s, c.id);
  assert.equal(c.status, 'in_review');
  approveEverywhere(w.s, c, v, w);
  assert.equal(v.status, 'approved');
  assert.equal(c.status, 'approved_current');
  assert.equal(c.currentVersionId, v.id);
  assert.equal(c.openVersionId, null);
});

test('pending 不算地区结论，未齐审不产生最终状态', () => {
  const w = setupWorld();
  const c = D.createClause(w.s, { title: '条款甲', products: [w.p.id] });
  D.openRound(w.s, { name: 'R1' });
  const v = D.submitVersion(w.s, c.id);
  D.recordReview(w.s, c.id, v.id, { regionId: w.r1.id, verdict: 'approved' });
  D.recordReview(w.s, c.id, v.id, { regionId: w.r2.id, verdict: 'pending', comment: '复核中' });
  assert.equal(v.status, 'submitted');
  assert.equal(c.status, 'in_review');
});

test('关闭轮次后旧评审意见冻结：不能改、不能补登', () => {
  const w = setupWorld();
  const c = D.createClause(w.s, { title: '条款甲', products: [w.p.id] });
  const round = D.openRound(w.s, { name: 'R1' });
  const v = D.submitVersion(w.s, c.id);
  D.recordReview(w.s, c.id, v.id, { regionId: w.r1.id, verdict: 'returned', comment: '旧意见A' });
  D.closeRound(w.s, round.id);
  assert.throws(() => D.recordReview(w.s, c.id, v.id, { regionId: w.r1.id, verdict: 'approved' }), /冻结/);
  assert.throws(() => D.withdrawSubmission(w.s, c.id), /轮次已关闭/);
  assert.equal(v.reviews[0].comment, '旧意见A');
});

test('退回后补交生成新版本，旧版本与旧轮意见永久保留；通过后旧版 superseded', () => {
  const w = setupWorld();
  const c = D.createClause(w.s, { title: '条款甲', products: [w.p.id] });
  const r1 = D.openRound(w.s, { name: 'R1' });
  const v1 = D.submitVersion(w.s, c.id);
  D.recordReview(w.s, c.id, v1.id, { regionId: w.r1.id, verdict: 'returned', comment: '旧轮：需补定义' });
  D.recordReview(w.s, c.id, v1.id, { regionId: w.r2.id, verdict: 'approved' });
  D.closeRound(w.s, r1.id);
  assert.equal(v1.status, 'returned');
  assert.equal(c.status, 'returned');
  const frozenComment = v1.reviews[0].comment;

  const r2 = D.openRound(w.s, { name: 'R2' });
  const v2 = D.submitVersion(w.s, c.id, { body: '修订后正文' }); // 补交
  assert.equal(v2.id === v1.id, false);
  assert.equal(v2.status, 'resubmitted');
  assert.equal(v2.roundId, r2.id);
  assert.equal(v2.reviews.length, 0);
  // 旧版本未被覆盖
  assert.equal(v1.status, 'returned');
  assert.equal(v1.roundId, r1.id);
  assert.equal(v1.reviews[0].comment, frozenComment);
  // 不能在旧版本上补登意见
  assert.throws(() => D.recordReview(w.s, c.id, v1.id, { regionId: w.r2.id, verdict: 'approved' }), /冻结|已冻结/);

  approveEverywhere(w.s, c, v2, w);
  assert.equal(v2.status, 'approved');
  assert.equal(c.currentVersionId, v2.id);
  assert.equal(v1.status, 'superseded');
  assert.equal(v1.reviews[0].comment, frozenComment); // 历史意见仍在
  // 时间线里两轮都能看到
  const tl = D.roundTimeline(w.s);
  assert.equal(tl.length, 2);
  assert.equal(tl[0].entries.length, 1);
  assert.equal(tl[0].entries[0].frozen, true);
});

test('撤回只清除当前在途意见，关闭轮次后不允许撤回', () => {
  const w = setupWorld();
  const c = D.createClause(w.s, { title: '条款甲', products: [w.p.id] });
  D.openRound(w.s, { name: 'R1' });
  const v = D.submitVersion(w.s, c.id);
  D.recordReview(w.s, c.id, v.id, { regionId: w.r1.id, verdict: 'pending', comment: '临时' });
  D.withdrawSubmission(w.s, c.id, '内部修订');
  assert.equal(v.status, 'draft');
  assert.equal(v.roundId, null);
  assert.equal(v.reviews.length, 0);
  assert.equal(c.status, 'draft');
});

test('替换已通过条款：在审时旧版仍生效；替换件被退回旧版恢复；再替换通过旧版 superseded', () => {
  const w = setupWorld();
  const c = D.createClause(w.s, { title: '条款甲', products: [w.p.id], effectiveDate: '2026-10-01' });
  D.openRound(w.s, { name: 'R1' });
  const v1 = D.submitVersion(w.s, c.id);
  approveEverywhere(w.s, c, v1, w);
  D.closeRound(w.s, w.s.rounds[0].id);

  D.openRound(w.s, { name: 'R2' });
  const v2 = D.replaceApproved(w.s, c.id, { body: '新版120%给付' });
  assert.equal(v2.supersedesVersionId, v1.id);
  assert.equal(c.status, 'in_review');
  // 替换件在审期间：旧版仍可作为发布依据（状态仍为 approved）
  assert.equal(v1.status, 'approved');

  D.recordReview(w.s, c.id, v2.id, { regionId: w.r1.id, verdict: 'returned', comment: '比例存疑' });
  D.recordReview(w.s, c.id, v2.id, { regionId: w.r2.id, verdict: 'approved' });
  assert.equal(v2.status, 'returned');
  assert.equal(c.currentVersionId, v1.id);          // 旧版恢复
  assert.equal(c.status, 'approved_current');
  assert.equal(v1.status, 'approved');

  const v3 = D.submitVersion(w.s, c.id, { body: '再修订110%' }); // 退回件补交
  approveEverywhere(w.s, c, v3, w);
  assert.equal(c.currentVersionId, v3.id);
  assert.equal(v1.status, 'superseded');
  assert.equal(v2.status, 'returned'); // 被退回的中间版本与其意见作为历史冻结保留
});

test('冲突：缺失定义为 error、生效日期不一致为 warning、责任互斥识别', () => {
  const w = setupWorld();
  D.addDefinition(w.s, { code: 'OK_DEF', text: '存在的定义' });
  D.openRound(w.s, { name: 'R1' });
  const c1 = D.createClause(w.s, { title: '条款甲', products: [w.p.id], effectiveDate: '2026-10-01', scope: '#门诊', definitionRefs: ['MISSING'] });
  D.submitVersion(w.s, c1.id);
  D.recordReview(w.s, c1.id, c1.openVersionId, { regionId: w.r1.id, verdict: 'approved' });
  D.recordReview(w.s, c1.id, c1.openVersionId, { regionId: w.r2.id, verdict: 'approved' });
  // 已通过但缺定义
  assert.equal(c1.status, 'approved_current');
  const issues1 = D.detectConflicts(w.s);
  assert.ok(issues1.some((i) => i.type === 'missing_definition' && i.severity === 'error'));
  assert.ok(D.quarantineReasons(w.s, c1).some((r) => r.code === 'missing_definition'));

  const c2 = D.createClause(w.s, { title: '条款乙', products: [w.p.id], effectiveDate: '2026-12-01', scope: '#-门诊' });
  D.submitVersion(w.s, c2.id);
  // c2 未通过（无意见）→ 与已通过 c1 的责任矛盾：c2 是草稿/在途方时级别为 warning
  const issues2 = D.detectConflicts(w.s);
  assert.ok(issues2.some((i) => i.type === 'scope_conflict'));
  // 生效日期（仅 c1 为非草稿候选通过、c2 在途也算非草稿）
  assert.ok(issues2.some((i) => i.type === 'effective_date_mismatch'));

  // c2 齐审通过后，矛盾升级为 error
  approveEverywhere(w.s, c2, c2.openVersionId, w);
  const issues3 = D.detectConflicts(w.s);
  const scope = issues3.filter((i) => i.type === 'scope_conflict');
  assert.ok(scope.some((i) => i.severity === 'error'));
});

test('草稿条款的问题不阻断已通过条款发布', () => {
  const w = setupWorld();
  D.openRound(w.s, { name: 'R1' });
  const c1 = D.createClause(w.s, { title: '条款甲', products: [w.p.id], effectiveDate: '2026-10-01' });
  D.submitVersion(w.s, c1.id);
  approveEverywhere(w.s, c1, c1.openVersionId, w);
  D.createClause(w.s, { title: '草稿乙', products: [w.p.id], effectiveDate: '2027-01-01', definitionRefs: ['GHOST'] });
  const reasons = D.quarantineReasons(w.s, c1);
  assert.deepEqual(reasons, []);
});

test('发布包：合格条款入包并冻结回执快照；混选时不合格的进 rejected；移交后改版产生漂移提示但回执不变', () => {
  const w = setupWorld();
  D.openRound(w.s, { name: 'R1' });
  const c1 = D.createClause(w.s, { title: '条款甲', products: [w.p.id], effectiveDate: '2026-10-01' });
  D.submitVersion(w.s, c1.id);
  approveEverywhere(w.s, c1, c1.openVersionId, w);
  const c2 = D.createClause(w.s, { title: '条款乙（草稿）', products: [w.p.id], effectiveDate: '2026-10-01' });

  const pkg = D.createPackage(w.s, { name: '包1', clauseIds: [c1.id, c2.id], handoffTo: '林舟' });
  assert.equal(pkg.items.length, 1);
  assert.equal(pkg.rejected.length, 1);
  assert.equal(pkg.rejected[0].clauseId, c2.id);

  D.handoffPackage(w.s, pkg.id, { to: '林舟' });
  assert.match(pkg.receiptNo, /^RCPT-/);
  const snapshotBody = pkg.items[0].body;

  // 新一轮替换条款甲
  D.closeRound(w.s, w.s.rounds[0].id);
  D.openRound(w.s, { name: 'R2' });
  D.replaceApproved(w.s, c1.id, { body: '全新正文' });
  // 回执快照未变
  assert.equal(pkg.items[0].body, snapshotBody);
  const st = D.packageReceiptStatus(w.s, pkg);
  assert.equal(st.drift.length, 1);
  assert.match(st.drift[0].reason, /新版本/);
});

test('发布包拒绝零合格与生效日期不一致', () => {
  const w = setupWorld();
  D.openRound(w.s, { name: 'R1' });
  const draft = D.createClause(w.s, { title: '草稿', products: [w.p.id] });
  assert.throws(() => D.createPackage(w.s, { clauseIds: [draft.id] }), /全部留在隔离区|至少包含/);

  const c1 = D.createClause(w.s, { title: '条款甲', products: [w.p.id], effectiveDate: '2026-10-01' });
  D.submitVersion(w.s, c1.id); approveEverywhere(w.s, c1, c1.openVersionId, w);
  // 加一个只有单地区的产品/条款凑第二个通过件，日期不同
  const p2 = D.addProduct(w.s, { name: '另一产品', regions: [w.r1.id] });
  const c2 = D.createClause(w.s, { title: '条款丙', products: [p2.id], effectiveDate: '2026-11-11' });
  D.submitVersion(w.s, c2.id);
  D.recordReview(w.s, c2.id, c2.openVersionId, { regionId: w.r1.id, verdict: 'approved' });
  assert.throws(() => D.createPackage(w.s, { clauseIds: [c1.id, c2.id] }), /生效日期不一致/);
});

test('地区覆盖：产品未配地区、条款缺地区结论都会被诊断', () => {
  const s = D.emptyState();
  const p0 = D.addProduct(s, { name: '无地区产品' });
  const c = D.createClause(s, { title: '条款', products: [p0.id] });
  const issues = D.detectConflicts(s);
  assert.ok(issues.some((i) => i.type === 'region_gap'));
});
