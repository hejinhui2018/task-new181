'use strict';
// 演示种子：多产品、多地区、两轮评审（旧轮冻结）、冲突、发布包与隔离区。
function seedDemo(store) {
  const d = (type, args) => store.dispatch(type, args);

  // ---- 地区 ----
  const nc = d('addRegion', { code: 'NC', name: '华北区' });
  const ec = d('addRegion', { code: 'EC', name: '华东区' });
  const sc = d('addRegion', { code: 'SC', name: '华南区' });

  // ---- 产品 ----
  const med = d('addProduct', { code: 'MED-01', name: '安康百万医疗险', regions: [nc.id, ec.id, sc.id] });
  const ci = d('addProduct', { code: 'CI-02', name: '颐养终身重疾险', regions: [nc.id, ec.id] });

  // ---- 定义库 ----
  d('addDefinition', { code: 'WAIT_PERIOD', title: '等待期', text: '自合同生效日起 30 天（含第 30 日）为等待期。' });
  d('addDefinition', { code: 'MEDICAL_NECESSITY', title: '医疗必需', text: '指临床诊疗所必需、符合医学通行标准且由合规医疗机构提供的医疗服务。' });
  d('addDefinition', { code: 'LIABILITY_EXEMPT', title: '责任免除', text: '合同载明的、保险人不承担给付保险金责任的情形。' });

  // ============ 第 1 轮 ============
  d('openRound', { name: '2026 年第 1 轮（基线版）' });

  // 1) 等待期条款：三区通过
  const cWait = d('createClause', {
    code: 'MED-W-01', title: '等待期条款', scope: '适用于疾病医疗报销责任 #等待期',
    effectiveDate: '2026-10-01', products: [med.id],
    body: '自合同生效日起 30 天为等待期，等待期内发生的疾病不属于保险责任。',
    definitionRefs: ['WAIT_PERIOD'],
  });
  d('submit', { clauseId: cWait.id });
  const vWait = store.state.clauses.find((x) => x.id === cWait.id).openVersionId;
  d('recordReview', { clauseId: cWait.id, versionId: vWait, input: { regionId: nc.id, verdict: 'approved', reviewer: '周敏', comment: '表述清晰，同意。' } });
  d('recordReview', { clauseId: cWait.id, versionId: vWait, input: { regionId: ec.id, verdict: 'approved', reviewer: '陈岚', comment: '同意。' } });
  d('recordReview', { clauseId: cWait.id, versionId: vWait, input: { regionId: sc.id, verdict: 'approved', reviewer: '何竞', comment: '同意备案。' } });

  // 2) 医疗必需条款：三区通过
  const cMed = d('createClause', {
    code: 'MED-M-02', title: '医疗必需认定条款', scope: '报销范围认定 #医疗必需',
    effectiveDate: '2026-10-01', products: [med.id],
    body: '保险责任范围内的医疗费用以“医疗必需”为给付前提，认定标准依据本合同释义。',
    definitionRefs: ['MEDICAL_NECESSITY'],
  });
  d('submit', { clauseId: cMed.id });
  const vMed = store.state.clauses.find((x) => x.id === cMed.id).openVersionId;
  d('recordReview', { clauseId: cMed.id, versionId: vMed, input: { regionId: nc.id, verdict: 'approved', reviewer: '周敏', comment: '同意。' } });
  d('recordReview', { clauseId: cMed.id, versionId: vMed, input: { regionId: ec.id, verdict: 'approved', reviewer: '陈岚', comment: '同意。' } });
  d('recordReview', { clauseId: cMed.id, versionId: vMed, input: { regionId: sc.id, verdict: 'waived', reviewer: '何竞', comment: '沿用总公司表述，免审。' } });

  // 3) 责任免除条款：华南退回 → 第 1 轮冻结该结论
  const cEx = d('createClause', {
    code: 'MED-E-03', title: '责任免除条款', scope: '列明除外责任 #责任免除',
    effectiveDate: '2026-10-01', products: [med.id],
    body: '因既往症、整形手术、非医疗必需项目产生的费用，保险人不承担给付责任。',
    definitionRefs: ['LIABILITY_EXEMPT'],
  });
  d('submit', { clauseId: cEx.id });
  const vEx1 = store.state.clauses.find((x) => x.id === cEx.id).openVersionId;
  d('recordReview', { clauseId: cEx.id, versionId: vEx1, input: { regionId: nc.id, verdict: 'approved', reviewer: '周敏', comment: '同意。' } });
  d('recordReview', { clauseId: cEx.id, versionId: vEx1, input: { regionId: ec.id, verdict: 'approved', reviewer: '陈岚', comment: '同意。' } });
  d('recordReview', { clauseId: cEx.id, versionId: vEx1, input: { regionId: sc.id, verdict: 'returned', reviewer: '何竞', comment: '【旧轮意见】既往症界定与华南现行指引冲突，请补充客观判定标准。' } });

  // 4) 重疾保险金条款：两区通过（基线版）
  const cCi = d('createClause', {
    code: 'CI-P-01', title: '重大疾病保险金条款', scope: '重疾给付 #重疾给付',
    effectiveDate: '2026-10-15', products: [ci.id],
    body: '被保险人于等待期后经确诊初次患本合同所列重大疾病，按基本保额给付重大疾病保险金。',
    definitionRefs: ['WAIT_PERIOD'],
  });
  d('submit', { clauseId: cCi.id });
  const vCi1 = store.state.clauses.find((x) => x.id === cCi.id).openVersionId;
  d('recordReview', { clauseId: cCi.id, versionId: vCi1, input: { regionId: nc.id, verdict: 'approved', reviewer: '周敏', comment: '同意。' } });
  d('recordReview', { clauseId: cCi.id, versionId: vCi1, input: { regionId: ec.id, verdict: 'approved', reviewer: '陈岚', comment: '同意。' } });

  // 5) 住院医疗责任条款：通过（第 2 轮新条款将与其产生责任范围矛盾）
  const cHos = d('createClause', {
    code: 'MED-H-04', title: '住院医疗保险责任条款', scope: '承保住院与门诊 #住院医疗 #门诊',
    effectiveDate: '2026-10-01', products: [med.id],
    body: '保险人承担被保险人住院期间及住院前后门急诊的医疗费用。',
    definitionRefs: ['MEDICAL_NECESSITY'],
  });
  d('submit', { clauseId: cHos.id });
  const vHos = store.state.clauses.find((x) => x.id === cHos.id).openVersionId;
  d('recordReview', { clauseId: cHos.id, versionId: vHos, input: { regionId: nc.id, verdict: 'approved', reviewer: '周敏', comment: '同意。' } });
  d('recordReview', { clauseId: cHos.id, versionId: vHos, input: { regionId: ec.id, verdict: 'approved', reviewer: '陈岚', comment: '同意。' } });
  d('recordReview', { clauseId: cHos.id, versionId: vHos, input: { regionId: sc.id, verdict: 'approved', reviewer: '何竞', comment: '同意。' } });

  d('closeRound', { roundId: store.state.rounds[0].id });

  // ---- 第 1 轮后：组装基线发布包并移交 ----
  const pkg = d('createPackage', {
    name: '医疗险 10.1 基线发布包',
    handoffTo: '发布同事·林舟',
    clauseIds: [cWait.id, cMed.id, cHos.id],
  });
  d('handoffPackage', { packageId: pkg.id, input: { to: '发布同事·林舟' } });

  // ============ 第 2 轮（当前开放） ============
  d('openRound', { name: '2026 年第 2 轮（修订版）' });

  // 3a) 责任免除补交：旧版本/旧意见冻结，新版本进入新一轮
  d('resubmit', {
    clauseId: cEx.id,
    patch: {
      body: '既往症指保单生效前已患或已有明显症状的疾病，判定以病历与检查报告为据；整形手术及非医疗必需项目费用亦在免除之列。术语：{{DEF:LIABILITY_EXEMPT=保险人对部分情形不承担责任的约定}}',
    },
  });
  const vEx2 = store.state.clauses.find((x) => x.id === cEx.id).openVersionId;
  d('recordReview', { clauseId: cEx.id, versionId: vEx2, input: { regionId: nc.id, verdict: 'approved', reviewer: '周敏', comment: '【新一轮】补充标准可接受。' } });
  d('recordReview', { clauseId: cEx.id, versionId: vEx2, input: { regionId: sc.id, verdict: 'pending', reviewer: '何竞', comment: '【新一轮】复核中。' } });

  // 4a) 重疾条款替换：旧版 superseded 冻结，新版在审
  d('replace', { clauseId: cCi.id, patch: { body: '被保险人经确诊初次患本合同所列重大疾病，按基本保额的 120% 给付保险金（本次修订提高给付比例）。' } });

  // 6) 新条款：引用了不存在的定义（冲突），且生效日期与产品内其它条款不一致；仍是草稿外提交状态
  const cNew = d('createClause', {
    code: 'MED-O-05', title: '院外特药费用条款（草案）', scope: '院外药品报销 #特药',
    effectiveDate: '2026-12-01', products: [med.id],
    body: '保险人承担指定药品清单内院外购药费用，具体清单另行公告。',
    definitionRefs: ['SPECIAL_DRUG_LIST'],
  });
  d('submit', { clauseId: cNew.id });
  const vNew = store.state.clauses.find((x) => x.id === cNew.id).openVersionId;
  d('recordReview', { clauseId: cNew.id, versionId: vNew, input: { regionId: nc.id, verdict: 'approved', reviewer: '周敏', comment: '方向同意，但特药清单定义缺失。' } });

  // 7) 新条款与已通过的住院条款责任范围矛盾：#门诊 vs #-门诊
  const cOpd = d('createClause', {
    code: 'MED-O-06', title: '门诊责任限额特别约定（草案）', scope: '普通门诊不予赔付 #-门诊',
    effectiveDate: '2026-10-01', products: [med.id],
    body: '普通门急诊费用不属于本产品报销范围，仅住院前后门急诊按主条款执行。',
    definitionRefs: [],
  });
  d('saveDraft', { clauseId: cOpd.id, patch: { body: cOpd.body } }); // 演示草稿保存不触发评审

  // 8) 纯草稿：续保条款，从未提交 → 隔离区
  d('createClause', {
    code: 'MED-R-07', title: '连续续保条款（草稿）', scope: '续保 #续保',
    effectiveDate: '', products: [med.id],
    body: '本产品为一年期非保证续保产品……（草稿待补充）',
    definitionRefs: [],
  });

  store.forceCheckpoint();
  return store.state;
}

module.exports = { seedDemo };
