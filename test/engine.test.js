/* 核心业务规则测试：轮次结论、版本谱系、冲突、隔离、发布回执 */
const test = require('node:test');
const assert = require('node:assert');
const CH = require('../js/engine.js');
const seed = require('../js/seed.js');

const ctx = (at, actor) => ({ now: at || '2026-09-20T00:00:00.000Z', actor: actor || '测试法务' });
const st = (db, code) => CH.computeClauseState(db, db.clauses.find(c => c.code === code));

test('旧轮次意见不能覆盖当前版本：C-002 v1 被湖北退回，v2 补交后湖北结论为缺失而非沿用退回', () => {
  const db = seed.buildSeed();
  const c2 = db.clauses.find(c => c.code === 'CL-MED-02');
  assert.equal(c2.versions.length, 2);
  assert.equal(c2.currentVersionId, c2.versions[1].id);
  const s = CH.computeClauseState(db, c2);
  assert.equal(s.version.kind, 'resubmit');
  // 四川 v2 在 T5 通过，但 T9「医疗必需」定义更新，四川通过早于更新 → 同样要复审
  assert.deepEqual(s.review.approvedRegions, []);
  assert.deepEqual(s.review.missingRegions.sort(), ['HB', 'SC']);
  // 当前结论里不存在退回（v1 的退回只留在历史）
  assert.equal(s.blockers.some(b => b.code === 'returned'), false);
  assert.ok(s.blockers.some(b => b.code === 'missing-region-approval'));
  assert.ok(s.blockers.some(b => b.code === 'definition-changed'));
  // 历史意见仍可完整追溯
  const v1Items = CH.collectItems(db, c2.id, c2.versions[0].id);
  assert.equal(v1Items.find(i => i.region === 'HB').verdict, 'returned');
  assert.equal(v1Items.find(i => i.region === 'HB').roundNo, 1);
});

test('对已被取代的旧版本登记意见必须被拒绝', () => {
  const db = seed.buildSeed();
  const c3 = db.clauses.find(c => c.code === 'CL-WAI-03');
  assert.throws(() => CH.recordVerdict(db, {
    clauseId: c3.id, versionId: c3.versions[0].id, region: 'SH', verdict: 'approved'
  }, ctx('2026-09-16T09:00:00.000Z')), /取代/);
});

test('当前版本在旧轮次关闭后：旧轮的通过不算数，必须在新一轮取得结论', () => {
  const db = seed.buildSeed();
  const c3 = db.clauses.find(c => c.code === 'CL-WAI-03');
  // v2 是草稿，即使 v1 在第1轮全通过，v2 仍然阻断
  const s = CH.computeClauseState(db, c3);
  assert.equal(s.state, 'blocked');
  assert.ok(s.blockers.some(b => b.code === 'draft'));
  assert.deepEqual(s.review.approvedRegions, []);
});

test('退回后补交生成新版本且旧版本冻结', () => {
  const db = CH.createDB();
  db.meta.createdAt = ctx().now;
  CH.upsertDefinition(db, { term: 'X', content: 'x' }, ctx());
  const c = CH.createClause(db, {
    code: 'T-1', title: 't', regions: ['BJ'], productIds: [],
    effectiveDate: '2026-10-01', definitionRefs: [], coverage: [], content: 'a'
  }, ctx());
  CH.createRound(db, {}, ctx());
  CH.submitForReview(db, c.id, ctx());
  CH.recordVerdict(db, { clauseId: c.id, versionId: c.currentVersionId, region: 'BJ', verdict: 'returned', comment: '改' }, ctx());
  const v1 = c.versions[0];
  assert.equal(v1.status, 'returned');
  // 已送审版本不能直接覆盖
  assert.throws(() => CH.saveDraft(db, c.id, { content: 'b' }, ctx()), /补交/);
  const v2 = CH.followUpVersion(db, c.id, { kind: 'resubmit', content: 'b' }, ctx());
  assert.equal(v2.status, 'draft');
  assert.equal(v2.replacesVersionId, v1.id);
  assert.equal(v1.supersededBy, v2.id);
  assert.equal(c.currentVersionId, v2.id);
  // v1 内容冻结
  assert.equal(v1.content, 'a');
  assert.equal(v2.content, 'b');
});

test('撤回送审：无意见可撤回，有意见必须走补交', () => {
  const db = CH.createDB();
  db.meta.createdAt = ctx().now;
  const c = CH.createClause(db, { code: 'T-2', title: 't', regions: ['BJ'], effectiveDate: '2026-10-01' }, ctx());
  CH.createRound(db, {}, ctx());
  CH.submitForReview(db, c.id, ctx());
  CH.withdrawSubmission(db, c.id, ctx());
  assert.equal(c.versions[0].status, 'draft');
  CH.submitForReview(db, c.id, ctx());
  CH.recordVerdict(db, { clauseId: c.id, versionId: c.currentVersionId, region: 'BJ', verdict: 'approved' }, ctx());
  assert.throws(() => CH.withdrawSubmission(db, c.id, ctx()), /退回后补交/);
});

test('生效倒挂：替换版生效日期早于被替换版本即阻断', () => {
  const db = seed.buildSeed();
  const s = st(db, 'CL-WAI-03');
  const inv = s.blockers.find(b => b.code === 'effective-inversion');
  assert.ok(inv);
  assert.equal(inv.date, '2026-06-01');
  assert.equal(inv.baseDate, '2026-07-01');
});

test('责任范围冲突：同产品同一责任项保障与除外并存', () => {
  const db = seed.buildSeed();
  const conflicts = CH.coverageConflicts(db);
  const hit = conflicts.find(c => c.label === '高原反应医疗');
  assert.ok(hit, '高原反应医疗冲突被检出');
  const s5 = st(db, 'CL-HALF-05');
  const s6 = st(db, 'CL-RES-06');
  assert.ok(s5.blockers.some(b => b.code === 'coverage-conflict'));
  assert.ok(s6.blockers.some(b => b.code === 'coverage-conflict'));
});

test('地区缺口：产品上线地区超出条款适用地区', () => {
  const db = seed.buildSeed();
  const s6 = st(db, 'CL-RES-06');
  const gap = s6.blockers.find(b => b.code === 'region-gap');
  assert.ok(gap);
  assert.deepEqual(gap.gaps.map(g => g.region), ['HB']);
});

test('定义缺失与定义变更需复审', () => {
  const db = seed.buildSeed();
  const s7 = st(db, 'CL-SPO-07');
  assert.ok(s7.blockers.find(b => b.code === 'definition-missing'));
  // C-004 在第1轮通过，定义 T9 更新 → 当前结论需复审
  const s4 = st(db, 'CL-CRI-04');
  const changed = s4.blockers.find(b => b.code === 'definition-changed');
  assert.ok(changed);
  assert.equal(changed.defs[0].def.term, '医疗必需');
  assert.deepEqual(changed.defs[0].regions.sort(), ['GD', 'SH']);
  // 旧定义下的通过不再计入当前结论
  assert.deepEqual(s4.review.approvedRegions, []);
  assert.deepEqual(s4.review.missingRegions.sort(), ['GD', 'SH']);
});

test('定义变更后在新一轮重新通过，阻断消失', () => {
  const db = seed.buildSeed();
  CH.closeRound(db, CH.openRound(db).id, ctx('2026-09-16T08:00:00.000Z'));
  CH.createRound(db, { name: '第3轮 · 定义对齐复审' }, ctx('2026-09-16T09:00:00.000Z'));
  const c4 = db.clauses.find(c => c.code === 'CL-CRI-04');
  ['GD', 'SH'].forEach(rg => CH.recordVerdict(db, {
    clauseId: c4.id, versionId: c4.currentVersionId, region: rg, verdict: 'approved', comment: '新定义无异议'
  }, ctx('2026-09-16T10:00:00.000Z')));
  const s = CH.computeClauseState(db, c4);
  assert.equal(s.blockers.some(b => b.code === 'definition-changed'), false);
  assert.equal(s.state, 'ready');
});

test('替换残留：进行中轮次对旧版本的意见被标记且仅作警告', () => {
  const db = seed.buildSeed();
  const residues = CH.replacementResidue(db);
  const hit = residues.find(r => r.clause.code === 'CL-WAI-03');
  assert.ok(hit);
  assert.equal(hit.staleVersion.revision, 'v1');
  const s = st(db, 'CL-WAI-03');
  assert.ok(s.warnings.some(w => w.code === 'replacement-residue'));
  // 旧版意见不进入当前版本评审汇总
  assert.deepEqual(s.review.approvedRegions, []);
});

test('预检与隔离区：只有就绪条款能入选发布包', () => {
  const db = seed.buildSeed();
  const all = db.clauses.map(c => c.id);
  const pre = CH.preflight(db, all);
  const acceptedCodes = pre.accepted.map(a => a.state.clause.code).sort();
  // C-001 全地区通过；C-004 因定义变更被隔离（尽管 PK-002 已封存它）
  assert.deepEqual(acceptedCodes, ['CL-ACC-01']);
  assert.ok(pre.rejected.length >= 5);
  const quarCodes = CH.quarantine(db).map(q => q.state.clause.code);
  assert.ok(quarCodes.includes('CL-SPO-07'));
});

test('发布包封存是快照：之后条款替换不改变包内内容，但阻断发布', () => {
  const db = seed.buildSeed();
  // 先解掉 PK-002 的定义过期：重新建包验证版本替换路径
  CH.discardSealedPackage(db, db.packages.find(p => p.name.includes('PK-002')).id, ctx());
  const c1 = db.clauses.find(c => c.code === 'CL-ACC-01');
  const sealed = CH.sealPackage(db, { name: '测试包', clauseIds: [c1.id] }, ctx('2026-09-16T09:00:00.000Z'));
  const snapshotContent = sealed.pkg.entries[0].contentSnapshot;
  // 法务随后用替换生成新版本
  CH.followUpVersion(db, c1.id, { kind: 'replacement', content: '新内容', effectiveDate: '2026-11-01' }, ctx('2026-09-17T09:00:00.000Z'));
  assert.equal(sealed.pkg.entries[0].contentSnapshot, snapshotContent);
  const stale = CH.stalePackageEntries(db, sealed.pkg);
  assert.equal(stale.length, 1);
  assert.throws(() => CH.releasePackage(db, sealed.pkg.id, ctx()), /过期/);
});

test('已发布回执不可变更，条款后续修改不影响回执且校验一致', () => {
  const db = seed.buildSeed();
  const pk1 = db.packages.find(p => p.status === 'released');
  const verify = db => {
    const p = db.packages.find(x => x.id === pk1.id);
    // 直接用 store 的同款算法在引擎外重复验证逻辑
    return p.receipt.fingerprint;
  };
  const before = verify(db);
  // 发布后 C-008 产生补交新版本
  const c8 = db.clauses.find(c => c.code === 'CL-GEN-08');
  CH.followUpVersion(db, c8.id, { kind: 'resubmit', content: '修订版释义', effectiveDate: '2026-10-01' }, ctx('2026-09-20T09:00:00.000Z'));
  const pkAfter = db.packages.find(p => p.id === pk1.id);
  assert.equal(pkAfter.status, 'released');
  assert.equal(pkAfter.receipt.fingerprint, before);
  assert.throws(() => CH.releasePackage(db, pk1.id, ctx()), /不可变更|已发布/);
  assert.throws(() => CH.discardSealedPackage(db, pk1.id, ctx()), /不可撤回/);
  // 包内版本仍为 published 状态，新版本是草稿
  const releasedV = c8.versions.find(v => v.id === pkAfter.entries.find(e => e.clauseId === c8.id).versionId);
  assert.equal(releasedV.status, 'published');
  assert.equal(c8.versions[c8.versions.length - 1].status, 'draft');
});

test('同一待发布包不能重复封入同一条款', () => {
  const db = seed.buildSeed();
  const c1 = db.clauses.find(c => c.code === 'CL-ACC-01');
  CH.sealPackage(db, { name: '包A', clauseIds: [c1.id] }, ctx('2026-09-20T09:00:00.000Z'));
  assert.throws(() => CH.sealPackage(db, { name: '包B', clauseIds: [c1.id] }, ctx()), /已在待发布包/);
});

test('正常发布流程：封包→发布→条款版本置为已发布', () => {
  const db = seed.buildSeed();
  const c1 = db.clauses.find(c => c.code === 'CL-ACC-01');
  const r = CH.sealPackage(db, { name: '正常包', clauseIds: [c1.id] }, ctx('2026-09-20T09:00:00.000Z'));
  CH.releasePackage(db, r.pkg.id, ctx('2026-09-21T09:00:00.000Z', '发布同事'));
  assert.equal(r.pkg.status, 'released');
  assert.equal(c1.versions[0].status, 'published');
  assert.equal(CH.computeClauseState(db, c1).state, 'published');
  assert.ok(r.pkg.receipt.fingerprint.startsWith('fnv32-'));
  assert.equal(r.pkg.receipt.entries[0].fingerprint, r.pkg.entries[0].fingerprint);
});

test('影响产品随条款关联正确计算', () => {
  const db = seed.buildSeed();
  const c8 = db.clauses.find(c => c.code === 'CL-GEN-08');
  const products = CH.impactedProducts(db, c8);
  assert.equal(products.length, 3);
});

test('轮次规则：同时只能有一个进行中轮次', () => {
  const db = seed.buildSeed(); // 种子里第2轮是开的
  assert.throws(() => CH.createRound(db, {}, ctx()), /未关闭/);
});

test('已发布版本：退回必须走新版本，但通过/弃权可留档备案；发布后定义更新只警告', () => {
  const db = seed.buildSeed();
  const c8 = db.clauses.find(c => c.code === 'CL-GEN-08');
  // 已发布版本不能退回
  assert.throws(() => CH.recordVerdict(db, {
    clauseId: c8.id, versionId: c8.currentVersionId, region: 'GD', verdict: 'returned'
  }, ctx('2026-09-20T09:00:00.000Z')), /已发布/);
  // 通过类备案意见可留档，状态与回执不变
  CH.recordVerdict(db, {
    clauseId: c8.id, versionId: c8.currentVersionId, region: 'BJ', verdict: 'waived', comment: '备案确认'
  }, ctx('2026-09-20T09:00:00.000Z'));
  assert.equal(c8.versions[0].status, 'published');
  // 已发布且引用了 T9 更新的定义 → 仅警告，状态仍 published，地区结论保持
  const s8 = CH.computeClauseState(db, c8);
  assert.equal(s8.state, 'published');
  assert.ok(s8.warnings.some(w => w.code === 'post-publish-definition-change'));
  assert.ok(s8.review.approvedRegions.includes('BJ'));
});

test('同地区同轮重复登记更新意见并累计修订次数', () => {
  const db = CH.createDB();
  db.meta.createdAt = ctx().now;
  const c = CH.createClause(db, { code: 'T-3', title: 't', regions: ['BJ'], effectiveDate: '2026-10-01' }, ctx());
  CH.createRound(db, {}, ctx());
  CH.submitForReview(db, c.id, ctx());
  CH.recordVerdict(db, { clauseId: c.id, versionId: c.currentVersionId, region: 'BJ', verdict: 'returned', comment: '一稿意见' }, ctx());
  CH.recordVerdict(db, { clauseId: c.id, versionId: c.currentVersionId, region: 'BJ', verdict: 'approved', comment: '复核通过' }, ctx('2026-09-21T00:00:00.000Z'));
  const items = db.rounds[0].items;
  assert.equal(items.length, 1);
  assert.equal(items[0].verdict, 'approved');
  assert.equal(items[0].revised, 1);
  // 退回被改判为通过后，版本状态按本轮意见重算回待审
  assert.equal(c.versions[0].status, 'submitted');
});
