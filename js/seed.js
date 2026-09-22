/*
 * ClauseHarbor 演示种子数据
 *
 * 固定时间线，保证冲突 / 轮次 / 回执关系在任何机器上一致：
 *
 *  T1  第1轮评审：C-001/C-003/C-004/C-005/C-006/C-008 陆续获地区结论，C-002 被湖北退回
 *  T2  第1轮关闭；发布包 PK-001（C-003 v1、C-008 v1）发布，回执封存
 *  T3  C-002 补交 v2
 *  T4  开启第2轮；四川通过 C-002 v2（湖北尚未表态 → 当前结论待审）
 *  T6  广东在第2轮对 C-003 的【旧版 v1】补了意见（替换残留）
 *  T7  C-003 以「替换」生成 v2 草稿，且生效日期早于 v1（生效倒挂）
 *  T8  发布包 PK-002 封存 C-004 v1
 *  T9  定义「医疗必需」内容更新（晚于 C-004 通过时间、晚于 PK-002 封存时间）
 *  另有 C-007 草稿引用了不存在的定义、地区未覆盖
 */
(function (global) {
  'use strict';
  var CH = global.CH || (typeof require === 'function' ? require('./engine.js') : global.CH);

  var T = {
    t0: '2026-09-01T09:00:00.000Z',
    t1: '2026-09-03T10:00:00.000Z',
    t1b: '2026-09-03T11:00:00.000Z',
    t1c: '2026-09-03T14:00:00.000Z',
    t2: '2026-09-05T09:30:00.000Z',
    t3: '2026-09-08T09:00:00.000Z',
    t4: '2026-09-10T09:00:00.000Z',
    t5: '2026-09-10T10:00:00.000Z',
    t6: '2026-09-11T15:00:00.000Z',
    t7: '2026-09-12T09:00:00.000Z',
    t8: '2026-09-13T16:00:00.000Z',
    t9: '2026-09-15T10:30:00.000Z'
  };

  function buildSeed() {
    var db = CH.createDB();
    db.meta.createdAt = T.t0;
    function ctx(at, actor) { return { now: at, actor: actor || '产品法务' }; }

    /* ---------- 定义 ---------- */
    var dAccident = CH.upsertDefinition(db, { term: '意外事故', content: '外来的、突发的、非本意的、非疾病的客观事件直接致使身体受到伤害。' }, ctx(T.t0));
    var dWaiting = CH.upsertDefinition(db, { term: '等待期', content: '保险合同生效（或复效）之日起的一段连续期间，该期间内发生的保险事故保险人不承担给付责任。' }, ctx(T.t0));
    var dPreExist = CH.upsertDefinition(db, { term: '既往症', content: '投保人在投保前已知或应当知道的有关疾病或症状，以病历记载及通常医学判断为准。' }, ctx(T.t0));
    var dMedicalNeed = CH.upsertDefinition(db, { term: '医疗必需', content: '根据患者病情，由医师开具的、符合诊疗规范且为治疗所必需的医疗服务与药品。' }, ctx(T.t0));

    /* ---------- 产品与地区 ---------- */
    var p1 = CH.upsertProduct(db, { code: 'PA-100', name: '安康综合意外险', regions: ['BJ', 'SH', 'GD'] }, ctx(T.t0));
    var p2 = CH.upsertProduct(db, { code: 'HM-200', name: '蜀心安住院医疗险', regions: ['SC', 'HB'] }, ctx(T.t0));
    var p3 = CH.upsertProduct(db, { code: 'CI-300', name: '湾区长期重疾险', regions: ['GD', 'SH'] }, ctx(T.t0));

    /* ---------- 条款 ---------- */
    var c1 = CH.createClause(db, {
      code: 'CL-ACC-01', title: '人身意外身故/伤残给付条款', owner: '林岚',
      regions: ['BJ', 'SH', 'GD'], productIds: [p1.id],
      effectiveDate: '2026-10-01',
      definitionRefs: [dAccident.id],
      coverage: [{ label: '意外身故', stance: 'cover' }, { label: '意外伤残', stance: 'cover' }, { label: '猝死', stance: 'exclude' }],
      content: '被保险人因意外事故导致身故或伤残的，保险人按伤残等级对应比例给付保险金；猝死不属于意外事故，不承担给付责任。'
    }, ctx(T.t0));

    var c2 = CH.createClause(db, {
      code: 'CL-MED-02', title: '医疗费用补偿条款', owner: '周慎',
      regions: ['SC', 'HB'], productIds: [p2.id],
      effectiveDate: '2026-10-15',
      definitionRefs: [dMedicalNeed.id],
      coverage: [{ label: '住院医疗费用', stance: 'cover' }, { label: '门诊费用', stance: 'exclude' }],
      content: '对被保险人在等待期后因疾病或意外住院发生的、符合医疗必需定义的合理医疗费用，在扣除免赔额后按比例补偿。'
    }, ctx(T.t0));

    var c3 = CH.createClause(db, {
      code: 'CL-WAI-03', title: '等待期与免责条款', owner: '林岚',
      regions: ['GD', 'SH'], productIds: [p3.id],
      effectiveDate: '2026-07-01',
      definitionRefs: [dWaiting.id, dPreExist.id],
      coverage: [{ label: '等待期内出险', stance: 'exclude' }, { label: '既往症治疗', stance: 'exclude' }],
      content: '疾病医疗等待期 30 天；等待期内确诊或发生症状的疾病，以及既往症及其并发症导致的治疗费用，保险人不承担责任。'
    }, ctx(T.t0));

    var c4 = CH.createClause(db, {
      code: 'CL-CRI-04', title: '重大疾病确诊给付条款', owner: '许知遥',
      regions: ['GD', 'SH'], productIds: [p3.id],
      effectiveDate: '2026-11-01',
      definitionRefs: [dMedicalNeed.id],
      coverage: [{ label: '合同列明重大疾病', stance: 'cover' }, { label: '轻症先行赔付', stance: 'cover' }],
      content: '被保险人在等待期后经专科医生首次确诊合同列明重大疾病的，保险人按基本保额给付；轻症按 30% 先行给付。'
    }, ctx(T.t0));

    var c5 = CH.createClause(db, {
      code: 'CL-HALF-05', title: '高原反应特别约定', owner: '周慎',
      regions: ['SC', 'HB'], productIds: [p2.id],
      effectiveDate: '2026-10-15',
      definitionRefs: [],
      coverage: [{ label: '高原反应医疗', stance: 'exclude' }],
      content: '被保险人在海拔 3000 米以上地区因高原反应发生的医疗费用，不属于本合同保障范围。'
    }, ctx(T.t0));

    var c6 = CH.createClause(db, {
      code: 'CL-RES-06', title: '紧急救援费用条款', owner: '周慎',
      regions: ['SC'], productIds: [p2.id],
      effectiveDate: '2026-10-15',
      definitionRefs: [],
      coverage: [{ label: '高原反应医疗', stance: 'cover' }, { label: '紧急转运', stance: 'cover' }],
      content: '被保险人在旅行期间遭遇意外或突发急性病，保险人承担紧急救援及转运费用，含高原反应现场处置。'
    }, ctx(T.t0));

    var c7 = CH.createClause(db, {
      code: 'CL-SPO-07', title: '高风险运动除外条款（草稿）', owner: '许知遥',
      regions: ['GD'], productIds: [p3.id],
      effectiveDate: '2026-12-01',
      definitionRefs: ['D-999'],
      coverage: [{ label: '高风险户外运动', stance: 'exclude' }],
      content: '待补充：潜水、攀岩、跳伞等高风险运动的除外边界，需先确认「高风险运动」定义。'
    }, ctx(T.t0));

    var c8 = CH.createClause(db, {
      code: 'CL-GEN-08', title: '通用释义与释义效力条款', owner: '林岚',
      regions: ['BJ', 'SH', 'GD', 'SC', 'HB'], productIds: [p1.id, p2.id, p3.id],
      effectiveDate: '2026-07-01',
      definitionRefs: [dAccident.id, dWaiting.id, dPreExist.id, dMedicalNeed.id],
      coverage: [],
      content: '本条款集中约定各产品共用术语的释义与适用顺序；专门约定与通用释义不一致的，以专门约定为准。'
    }, ctx(T.t0));

    /* ---------- 第1轮评审 ---------- */
    CH.createRound(db, { name: '第1轮 · 秋季条款评审' }, ctx(T.t0));

    [c1, c2, c3, c4, c5, c6, c8].forEach(function (c) {
      CH.submitForReview(db, c.id, ctx(T.t1));
    });

    function verdict(clause, region, v, comment, at, reviewer) {
      CH.recordVerdict(db, { clauseId: clause.id, versionId: clause.currentVersionId, region: region, verdict: v, comment: comment, reviewer: reviewer }, ctx(at));
    }

    // C-001 全部通过
    verdict(c1, 'BJ', 'approved', '责任表述清楚，定义引用一致。', T.t1, '北京 · 高敏');
    verdict(c1, 'SH', 'approved', '同意，生效日期无冲突。', T.t1b, '上海 · 陈舟');
    verdict(c1, 'GD', 'approved', '通过。', T.t1c, '广东 · 黄黎');

    // C-002 四川通过、湖北退回（v1）
    verdict(c2, 'SC', 'approved', '补偿比例与免赔额表述完整。', T.t1, '四川 · 唐越');
    verdict(c2, 'HB', 'returned', '「医疗必需」引用缺少与本地医保目录的衔接说明，请补交后再审。', T.t1c, '湖北 · 郑岩');

    // C-003 全部通过
    verdict(c3, 'GD', 'approved', '等待期与既往症免责无异议。', T.t1, '广东 · 黄黎');
    verdict(c3, 'SH', 'approved', '通过。', T.t1b, '上海 · 陈舟');

    // C-004 全部通过
    verdict(c4, 'GD', 'approved', '轻症先行赔付比例确认。', T.t1, '广东 · 黄黎');
    verdict(c4, 'SH', 'approved', '同意，留意「医疗必需」定义后续更新。', T.t1b, '上海 · 陈舟');

    // C-005 四川通过、湖北退回
    verdict(c5, 'SC', 'approved', '高原反应除外可接受。', T.t1, '四川 · 唐越');
    verdict(c5, 'HB', 'returned', '与紧急救援条款对高原反应的表述互相矛盾，必须统一。', T.t1c, '湖北 · 郑岩');

    // C-006 四川通过（湖北因条款未覆盖湖北，缺意见 → 地区缺口）
    verdict(c6, 'SC', 'approved', '救援费用范围明确。', T.t1, '四川 · 唐越');

    // C-008 五地全部通过
    ['BJ', 'SH', 'GD', 'SC', 'HB'].forEach(function (rg, i) {
      verdict(c8, rg, 'approved', '通用释义无异议。', T.t1, ['北京 · 高敏', '上海 · 陈舟', '广东 · 黄黎', '四川 · 唐越', '湖北 · 郑岩'][i]);
    });

    CH.closeRound(db, db.rounds[0].id, ctx(T.t2));

    /* ---------- 发布 PK-001 ---------- */
    var sealed1 = CH.sealPackage(db, {
      name: '2026 夏季存量包 · PK-001',
      productScope: '全产品通用',
      clauseIds: [c3.id, c8.id]
    }, ctx(T.t2));
    CH.releasePackage(db, sealed1.pkg.id, ctx(T.t2, '发布同事 · 何帆'));

    /* ---------- C-002 补交 v2 ---------- */
    CH.followUpVersion(db, c2.id, {
      kind: 'resubmit',
      content: '对被保险人在等待期后因疾病或意外住院发生的、符合医疗必需定义的合理医疗费用，在扣除免赔额后按比例补偿；医保目录外费用按另行约定的清单执行，并附湖北医保衔接说明（附件二）。'
    }, ctx(T.t3, '周慎'));
    CH.submitForReview(db, c2.id, ctx(T.t3, '周慎'));

    /* ---------- 第2轮 ---------- */
    CH.createRound(db, { name: '第2轮 · 补交与替换复核' }, ctx(T.t4));
    verdict2(c2, 'SC', 'approved', 'v2 补充材料完整，四川维持通过。', T.t5, '四川 · 唐越');
    // 湖北对 v2 尚未表态 → 当前版本结论缺失（旧 v1 的退回结论停留在第1轮，仅作历史）

    // 替换残留：广东在 v2 尚未出现时，先对 C-003【旧版 v1】在第2轮补了一条意见
    CH.recordVerdict(db, {
      clauseId: c3.id, versionId: c3.versions[0].id, region: 'GD',
      verdict: 'approved', comment: '补充确认：v1 条款在广东的备案文号已拿到。', reviewer: '广东 · 黄黎'
    }, ctx(T.t6));

    /* ---------- C-003 替换 v2（草稿，生效倒挂） ---------- */
    CH.followUpVersion(db, c3.id, {
      kind: 'replacement',
      effectiveDate: '2026-06-01', // 早于 v1 的 2026-07-01
      content: '疾病医疗等待期由 30 天调整为 60 天；既往症认定增加「近两年用药记录」标准。（法务草案，生效日期待重定）'
    }, ctx(T.t7, '林岚'));

    /* ---------- 发布 PK-002（封存后定义变更） ---------- */
    var sealed2 = CH.sealPackage(db, {
      name: '2026 秋季重疾包 · PK-002',
      productScope: p3.name,
      clauseIds: [c4.id]
    }, ctx(T.t8, '许知遥'));

    // T9：医疗必需定义更新 —— 晚于 C-004 第1轮通过时间，也晚于 PK-002 封存时间
    CH.upsertDefinition(db, {
      id: dMedicalNeed.id,
      term: '医疗必需',
      content: '根据患者病情，由医师开具的、符合诊疗规范且为治疗所必需的医疗服务与药品；合理性同时参照治疗地医保目录及临床路径。'
    }, ctx(T.t9, '定义管理组'));

    function verdict2(clause, region, v, comment, at, reviewer) {
      CH.recordVerdict(db, { clauseId: clause.id, versionId: clause.currentVersionId, region: region, verdict: v, comment: comment, reviewer: reviewer }, ctx(at));
    }

    db.meta.lastSavedAt = T.t9;
    return db;
  }

  var Seed = { buildSeed: buildSeed, TIMELINE: T };
  if (typeof module !== 'undefined' && module.exports) module.exports = Seed;
  global.CHSeed = Seed;
})(typeof window !== 'undefined' ? window : globalThis);
