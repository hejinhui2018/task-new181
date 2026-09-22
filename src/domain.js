'use strict';
// ClauseHarbor 领域模型：纯函数 + store 状态机，无文件/网络依赖，便于测试。

// ---------- 工具 ----------
function defaultId(prefix) {
  return prefix + '_' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}
function defaultNow() { return new Date().toISOString(); }
// 可注入运行时：持久化层在执行命令时记录每次 id/时间取值，重放时按序回放，
// 保证重放生成的实体 ID 与首次执行完全一致（命令间靠 ID 引用）。
let runtime = { id: defaultId, now: defaultNow };
function uid(prefix) { return runtime.id(prefix); }
function nowIso() { return runtime.now(); }
function withRuntime(idFn, nowFn, fn) {
  const prev = runtime;
  runtime = { id: idFn, now: nowFn };
  try { return fn(); } finally { runtime = prev; }
}
function clone(o) { return JSON.parse(JSON.stringify(o)); }

// ---------- 常量 ----------
const CLAUSE_STATUSES = ['draft', 'in_review', 'approved_current', 'returned', 'replaced', 'withdrawn'];
// 条款版本生命周期：draft -> submitted ->（同一轮）returned/resubmitted/approved/rejected/superseded
const VERSION_STATUS = {
  DRAFT: 'draft', SUBMITTED: 'submitted', RETURNED: 'returned',
  RESUBMITTED: 'resubmitted', APPROVED: 'approved', REJECTED: 'rejected', SUPERSEDED: 'superseded',
};
const ROUND_STATUS = { OPEN: 'open', CLOSED: 'closed' };
const VERDICTS = ['pending', 'approved', 'returned', 'rejected', 'waived'];

function emptyState() {
  return {
    meta: { app: 'ClauseHarbor', version: 1, createdAt: nowIso() },
    definitions: [],          // {id, code, title, text}
    products: [],             // {id, name, code, regions:[regionId]}
    regions: [],              // {id, name, code}
    clauses: [],              // 条款主对象，见 createClause
    rounds: [],               // {id, name, openedAt, closedAt, status}
    packages: [],             // 发布包
    audit: [],                // 业务审计日志（区别于存储层 WAL）
    recoveryEvents: [],       // 异常恢复记录
  };
}

// ---------- 基础数据 ----------
function addDefinition(s, d) {
  if (!d || !d.code || !d.text) throw httpErr(400, '定义缺少 code 或 text');
  if (s.definitions.some((x) => x.code === d.code)) throw httpErr(409, `定义 ${d.code} 已存在`);
  const rec = { id: uid('def'), code: d.code, title: d.title || d.code, text: d.text, createdAt: nowIso() };
  s.definitions.push(rec);
  return rec;
}
function updateDefinition(s, id, patch) {
  const d = mustFind(s.definitions, id, '定义');
  if (patch.text !== undefined) d.text = patch.text;
  if (patch.title !== undefined) d.title = patch.title;
  return d;
}
function addRegion(s, r) {
  if (!r || !r.name) throw httpErr(400, '地区缺少名称');
  const rec = { id: uid('reg'), code: r.code || '', name: r.name, createdAt: nowIso() };
  s.regions.push(rec);
  return rec;
}
function addProduct(s, p) {
  if (!p || !p.name) throw httpErr(400, '产品缺少名称');
  const regions = (p.regions || []).filter((rid) => s.regions.some((r) => r.id === rid));
  const rec = { id: uid('prd'), code: p.code || '', name: p.name, regions, createdAt: nowIso() };
  s.products.push(rec);
  return rec;
}
function updateProductCoverage(s, id, regionIds) {
  const p = mustFind(s.products, id, '产品');
  p.regions = (regionIds || []).filter((rid) => s.regions.some((r) => r.id === rid));
  return p;
}

// ---------- 条款与版本 ----------
function createClause(s, c) {
  if (!c || !c.title) throw httpErr(400, '条款缺少标题');
  const products = (c.products || []).filter((id) => s.products.some((p) => p.id === id));
  const rec = {
    id: uid('cls'),
    code: c.code || '',
    title: c.title,
    scope: c.scope || '',                    // 责任范围文本
    effectiveDate: c.effectiveDate || '',   // ISO yyyy-mm-dd
    products,
    currentVersionId: null,                 // 当前生效版本（approved）
    openVersionId: null,                    // 在途版本（draft/submitted...）
    status: 'draft',
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  const v = makeVersion(rec, { body: c.body || '', definitionRefs: c.definitionRefs || [] });
  v.status = VERSION_STATUS.DRAFT;
  rec.openVersionId = v.id;
  rec.versions = [v];
  s.clauses.push(rec);
  return rec;
}

function makeVersion(clause, init) {
  return {
    id: uid('ver'),
    clauseId: clause.id,
    index: (clause.versions ? clause.versions.length : 0) + 1,
    status: VERSION_STATUS.DRAFT,
    body: init.body || '',
    definitionRefs: init.definitionRefs || [],   // [definitionCode]
    supersedesVersionId: init.supersedesVersionId || null,
    roundId: null,                               // 提交时所在轮次
    submittedAt: null,
    decidedAt: null,
    reviews: [],   // {regionId, verdict, comment, reviewer, at, roundId(=version.roundId)}
  };
}

function getClause(s, id) { return mustFind(s.clauses, id, '条款'); }
function findVersion(clause, vid) {
  const v = clause.versions.find((x) => x.id === vid);
  if (!v) throw httpErr(404, '版本不存在');
  return v;
}
function openVersion(s, clauseId) {
  const c = getClause(s, clauseId);
  if (c.openVersionId) {
    const v = findVersion(c, c.openVersionId);
    if (v.status === VERSION_STATUS.DRAFT) return v;
  }
  throw httpErr(409, '当前没有可编辑的草稿版本');
}

// 草稿保存：仅 draft 版本可改，可反复保存，不影响任何轮次结论
function saveDraft(s, clauseId, patch) {
  const c = getClause(s, clauseId);
  let v;
  if (c.openVersionId) {
    v = findVersion(c, c.openVersionId);
    if (v.status !== VERSION_STATUS.DRAFT) throw httpErr(409, `在途版本状态为 ${v.status}，不能保存草稿`);
  } else {
    v = makeVersion(c, {});
    c.versions.push(v);
    c.openVersionId = v.id;
  }
  if (patch.body !== undefined) v.body = patch.body;
  if (patch.definitionRefs !== undefined) {
    v.definitionRefs = patch.definitionRefs.filter((x) => typeof x === 'string');
  }
  applyClauseHeaderPatch(s, c, patch);
  c.updatedAt = nowIso();
  touch(c);
  return v;
}

function applyClauseHeaderPatch(s, c, patch) {
  if (patch.title !== undefined) c.title = patch.title;
  if (patch.scope !== undefined) c.scope = patch.scope;
  if (patch.effectiveDate !== undefined) c.effectiveDate = patch.effectiveDate;
  if (patch.code !== undefined) c.code = patch.code;
  if (patch.products !== undefined) {
    c.products = patch.products.filter((id) => s.products.some((p) => p.id === id));
  }
}

function touch(c) { c.updatedAt = nowIso(); }

// 撤回：提交后轮次尚未关闭前，可撤回；撤回后版本回到 draft，轮次地区结论冻结保留
function withdrawSubmission(s, clauseId, reason) {
  const c = getClause(s, clauseId);
  const v = findVersion(c, c.openVersionId);
  if (![VERSION_STATUS.SUBMITTED, VERSION_STATUS.RESUBMITTED].includes(v.status)) {
    throw httpErr(409, '只有已提交（在途）的版本可以撤回');
  }
  const round = mustFind(s.rounds, v.roundId, '轮次');
  if (round.status !== ROUND_STATUS.OPEN) throw httpErr(409, '轮次已关闭，不能撤回');
  v.status = VERSION_STATUS.DRAFT;
  v.submittedAt = null;
  v.roundId = null;
  v.reviews = []; // 撤回清掉本轮进行中意见；已关闭轮次的历史意见在旧版本上冻结
  if (v.supersedesVersionId && !c.currentVersionId) {
    const old = c.versions.find((x) => x.id === v.supersedesVersionId);
    if (old && old.status === VERSION_STATUS.APPROVED) c.currentVersionId = old.id;
  }
  c.status = c.currentVersionId ? 'approved_current' : 'draft';
  touch(c);
  audit(s, 'withdraw', { clauseId: c.id, versionId: v.id, reason: reason || '' });
  return v;
}

// ---------- 轮次 ----------
function openRound(s, info) {
  if (s.rounds.some((r) => r.status === ROUND_STATUS.OPEN)) {
    throw httpErr(409, '已有开放中的评审轮次，请先关闭');
  }
  const n = s.rounds.length + 1;
  const r = {
    id: uid('rnd'),
    name: (info && info.name) || `第 ${n} 轮`,
    status: ROUND_STATUS.OPEN,
    openedAt: nowIso(),
    closedAt: null,
  };
  s.rounds.push(r);
  return r;
}
function closeRound(s, roundId) {
  const r = mustFind(s.rounds, roundId, '轮次');
  if (r.status !== ROUND_STATUS.OPEN) throw httpErr(409, '轮次已关闭');
  r.status = ROUND_STATUS.CLOSED;
  r.closedAt = nowIso();
  // 轮次关闭：仍在 submitted/resubmitted 且没有结论的提交保留在途状态，结论不再可改；
  // 地区评审意见随之冻结（review 记录已带 at/roundId，API 层拒绝改写）。
  audit(s, 'close_round', { roundId: r.id });
  return r;
}
function currentOpenRound(s) { return s.rounds.find((r) => r.status === ROUND_STATUS.OPEN) || null; }

// 提交/补交/替换
// initial  —— 首次提交草稿
// resubmit —— 退回（returned）后补交：基于旧版本新建版本进入当前轮；旧版本与其轮次意见冻结
// replace  —— 替换一条“已通过”的旧条款（见 replaceApproved）
function submitVersion(s, clauseId, patch = {}) {
  const c = getClause(s, clauseId);
  const round = currentOpenRound(s);
  if (!round) throw httpErr(409, '没有开放的评审轮次');
  let v;
  let isResubmit = false;
  if (c.openVersionId) {
    const cur = findVersion(c, c.openVersionId);
    if (cur.status === VERSION_STATUS.RETURNED || cur.status === VERSION_STATUS.REJECTED) {
      // 补交（退回或拒绝后）：旧版本连同旧轮次地区意见原样冻结，另起新版本承载新一轮结论
      v = makeVersion(c, { body: cur.body, definitionRefs: clone(cur.definitionRefs) });
      v.resubmitsVersionId = cur.id;
      c.versions.push(v);
      c.openVersionId = v.id;
      isResubmit = true;
    } else if (cur.status === VERSION_STATUS.DRAFT) {
      v = cur;
    } else {
      throw httpErr(409, `版本状态 ${cur.status} 不可提交`);
    }
  } else {
    v = makeVersion(c, {});
    c.versions.push(v);
    c.openVersionId = v.id;
  }
  // 允许提交时一并保存草稿改动
  if (patch.body !== undefined) v.body = patch.body;
  if (patch.definitionRefs !== undefined) v.definitionRefs = patch.definitionRefs;
  applyClauseHeaderPatch(s, c, patch);

  v.status = isResubmit ? VERSION_STATUS.RESUBMITTED : VERSION_STATUS.SUBMITTED;
  v.roundId = round.id;
  v.submittedAt = nowIso();
  v.reviews = [];
  if (!c.currentVersionId) c.status = 'in_review'; // 替换件在审时，条款仍为 approved_current
  touch(c);
  audit(s, isResubmit ? 'resubmit' : 'submit', { clauseId: c.id, versionId: v.id, roundId: round.id });
  return v;
}

// 替换：为一个已通过的条款另起新版本（supersedes），旧版本进入 superseded 但结论冻结
function replaceApproved(s, clauseId, patch = {}) {
  const c = getClause(s, clauseId);
  if (c.status !== 'approved_current' || !c.currentVersionId) {
    throw httpErr(409, '只有已通过的条款可以发起替换');
  }
  if (c.openVersionId) throw httpErr(409, '已有在途版本，不能重复发起替换');
  const round = currentOpenRound(s);
  if (!round) throw httpErr(409, '没有开放的评审轮次');
  const old = findVersion(c, c.currentVersionId);
  const nv = makeVersion(c, {
    body: patch.body !== undefined ? patch.body : old.body,
    definitionRefs: patch.definitionRefs || clone(old.definitionRefs),
    supersedesVersionId: old.id,
  });
  c.versions.push(nv);
  nv.status = VERSION_STATUS.SUBMITTED;
  nv.roundId = round.id;
  nv.submittedAt = nowIso();
  applyClauseHeaderPatch(s, c, patch);
  c.openVersionId = nv.id;
  c.currentVersionId = null;
  c.status = 'in_review';
  touch(c);
  audit(s, 'replace', { clauseId: c.id, oldVersionId: old.id, newVersionId: nv.id, roundId: round.id });
  return nv;
}

// 地区评审：只允许在开放轮次内、对提交到该轮的版本写入；旧轮次一律拒绝（冻结）
function recordReview(s, clauseId, versionId, input) {
  const c = getClause(s, clauseId);
  const v = findVersion(c, versionId);
  const round = v.roundId ? s.rounds.find((r) => r.id === v.roundId) : null;
  if (!round) throw httpErr(409, '该版本未提交到任何轮次');
  if (round.status !== ROUND_STATUS.OPEN) throw httpErr(409, `轮次 ${round.name} 已关闭，结论冻结，不能修改旧评审意见`);
  if (round.id !== (currentOpenRound(s) || {}).id) throw httpErr(409, '版本不属于当前开放轮次');
  if (![VERSION_STATUS.SUBMITTED, VERSION_STATUS.RESUBMITTED, VERSION_STATUS.RETURNED, VERSION_STATUS.REJECTED].includes(v.status)) {
    throw httpErr(409, `版本状态为 ${v.status}，不能登记评审意见`);
  }
  // 已被补交/替换新版本接管的旧版本立即冻结（即便当前轮仍开放）
  if (c.openVersionId !== v.id && (v.status === VERSION_STATUS.RETURNED || v.status === VERSION_STATUS.REJECTED)) {
    throw httpErr(409, '该版本已被补交/替换的新版本接管，旧版本结论冻结，请在最新版本上登记意见');
  }
  const region = mustFind(s.regions, input.regionId, '地区');
  if (!VERDICTS.includes(input.verdict)) throw httpErr(400, '无效结论');
  const existing = v.reviews.find((r) => r.regionId === region.id);
  const rec = existing || { regionId: region.id };
  rec.verdict = input.verdict;
  rec.comment = input.comment || '';
  rec.reviewer = input.reviewer || '';
  rec.at = nowIso();
  rec.roundId = round.id;
  if (!existing) v.reviews.push(rec);
  touch(c);
  reconcileVersionStatus(s, c, v);
  return rec;
}

// 依据地区意见推导版本/条款状态（不触碰其它轮次的旧版本）
function reconcileVersionStatus(s, c, v) {
  if (![VERSION_STATUS.SUBMITTED, VERSION_STATUS.RESUBMITTED, VERSION_STATUS.RETURNED, VERSION_STATUS.REJECTED].includes(v.status)) return;
  // 已有更新的补交/替换版本接管时，旧版本立即冻结（同一开放轮内也不能再写旧版本）
  if (c.openVersionId && c.openVersionId !== v.id &&
      (v.status === VERSION_STATUS.RETURNED || v.status === VERSION_STATUS.REJECTED)) return;
  const required = requiredRegionsForClause(s, c);
  const byRegion = new Map(v.reviews.map((r) => [r.regionId, r]));
  // pending 表示地区尚未给最终结论，按未回复处理
  const have = required.filter((rid) => {
    const rv = byRegion.get(rid);
    return rv && rv.verdict !== 'pending';
  });
  if (have.length < required.length) return; // 尚未齐审
  const verdicts = required.map((rid) => byRegion.get(rid).verdict);
  if (verdicts.every((x) => x === 'approved' || x === 'waived')) {
    v.status = VERSION_STATUS.APPROVED;
    v.decidedAt = nowIso();
    // 新版本通过：旧 current / 被替换版 / 补交前的退回版 一律归档，其历史轮次与意见原样保留
    const oldId = c.currentVersionId || v.supersedesVersionId || v.resubmitsVersionId;
    if (oldId && oldId !== v.id) {
      const old = c.versions.find((x) => x.id === oldId);
      if (old && old.status !== VERSION_STATUS.SUPERSEDED) old.status = VERSION_STATUS.SUPERSEDED;
    }
    c.currentVersionId = v.id;
    c.openVersionId = null;
    c.status = 'approved_current';
    audit(s, 'approve', { clauseId: c.id, versionId: v.id });
  } else if (verdicts.some((x) => x === 'rejected')) {
    v.status = VERSION_STATUS.REJECTED;
    v.decidedAt = nowIso();
    restoreReplacedVersion(s, c, v);
    c.status = c.currentVersionId ? 'approved_current' : 'returned';
    c.openVersionId = v.id; // 保留为在途，允许改后补交（resubmit）
    audit(s, 'reject', { clauseId: c.id, versionId: v.id });
  } else {
    // 有退回意见但无拒绝：退回，可补交
    v.status = VERSION_STATUS.RETURNED;
    v.decidedAt = nowIso();
    restoreReplacedVersion(s, c, v);
    c.status = c.currentVersionId ? 'approved_current' : 'returned';
    c.openVersionId = v.id;
    audit(s, 'return', { clauseId: c.id, versionId: v.id });
  }
}

// 替换件未通过：旧版本恢复为当前生效版本（旧版本上的历史轮次与意见从未改动）
function restoreReplacedVersion(s, c, v) {
  if (v.supersedesVersionId && !c.currentVersionId) {
    const old = c.versions.find((x) => x.id === v.supersedesVersionId);
    if (old && old.status === VERSION_STATUS.APPROVED) {
      c.currentVersionId = old.id;
      audit(s, 'restore_after_failed_replace', { clauseId: c.id, versionId: old.id });
    }
  }
}

function requiredRegionsForClause(s, c) {
  const set = new Set();
  for (const pid of c.products) {
    const p = s.products.find((x) => x.id === pid);
    if (p) p.regions.forEach((r) => set.add(r));
  }
  return [...set];
}

// ---------- 冲突检测 ----------
// 以条款“当前候选文本”为准：已通过取 currentVersion，在途取 openVersion（用于审核中预警）；
// 调用方可指定 onlyApproved 只看发布相关结论。
function clauseCandidateVersion(c) {
  if (c.currentVersionId) return c.versions.find((v) => v.id === c.currentVersionId) || null;
  if (c.openVersionId) return c.versions.find((v) => v.id === c.openVersionId) || null;
  return null;
}

function detectConflicts(s) {
  const issues = [];
  const defCodes = new Set(s.definitions.map((d) => d.code));
  const draftish = (c) => {
    const v = clauseCandidateVersion(c);
    return !v || v.status === VERSION_STATUS.DRAFT;
  };

  // 1) 定义引用：引用不存在的定义（草稿阶段仅预警，提交/通过后为发布阻断）
  for (const c of s.clauses) {
    for (const v of c.versions) {
      const relevant = v.id === c.currentVersionId || v.id === c.openVersionId;
      if (!relevant) continue;
      for (const ref of v.definitionRefs || []) {
        if (!defCodes.has(ref)) {
          issues.push(mkIssue('missing_definition', v.status === VERSION_STATUS.DRAFT ? 'warning' : 'error', c, v,
            `引用了不存在的定义「${ref}」${v.status === VERSION_STATUS.DRAFT ? '（草稿阶段预警）' : ''}`, { definition: ref }));
        }
      }
    }
  }

  // 2) 定义版本漂移：同一产品组合下，两个生效条款引用同名定义但……定义是全局的，
  //    这里检测：被引用的定义文本与条款正文内联出现的旧定义不一致标记（正文内 {{DEF:code=...}}）
  for (const c of s.clauses) {
    const v = clauseCandidateVersion(c);
    if (!v || !v.body) continue;
    const re = /\{\{DEF:([A-Za-z0-9_.-]+)=([^}]*)\}\}/g;
    let m;
    while ((m = re.exec(v.body)) !== null) {
      const [, code, inlineText] = m;
      const def = s.definitions.find((d) => d.code === code);
      if (def && def.text.trim() !== inlineText.trim()) {
        issues.push(mkIssue('definition_drift', 'warning', c, v,
          `定义「${code}」条款内联文本与术语库当前版本不一致`, { definition: code }));
      }
    }
  }

  // 3) 生效日期矛盾：同一产品下各非草稿候选条款生效日期不一致。
  //    以多数日期为基准，只把“异日条款”标为冲突方，避免已通过条款被在途异日条款拖入隔离。
  const byProduct = new Map();
  for (const c of s.clauses) {
    const v = clauseCandidateVersion(c);
    if (!v || !c.effectiveDate || v.status === VERSION_STATUS.DRAFT) continue;
    for (const pid of c.products) {
      if (!byProduct.has(pid)) byProduct.set(pid, []);
      byProduct.get(pid).push({ c, date: c.effectiveDate, status: c.status });
    }
  }
  for (const [pid, items] of byProduct) {
    const dates = new Set(items.map((i) => i.date));
    if (dates.size > 1) {
      const p = s.products.find((x) => x.id === pid);
      const freq = new Map();
      items.forEach((i) => freq.set(i.date, (freq.get(i.date) || 0) + 1));
      const mode = [...freq.entries()].sort((a, b) => b[1] - a[1])[0][0];
      for (const i of items) {
        if (i.date === mode && i.status === 'approved_current') continue; // 基准方不报
        issues.push(mkIssue('effective_date_mismatch', 'warning', i.c, clauseCandidateVersion(i.c),
          `产品「${p ? p.name : pid}」下条款生效日期不一致：本条为 ${i.date}，同产品多数为 ${mode}`,
          { productId: pid, dates: [...dates], expected: mode }));
      }
    }
  }

  // 4) 责任范围矛盾：同产品下两条生效条款 scope 关键项互斥（简单规则：A 含“不含/除外”关键词指向 B 的责任项）
  //    采用 scopeTags：scope 中以 #tag 形式标注责任项，含 -tag 表示排除
  const scopeTagsByProduct = new Map();
  for (const c of s.clauses) {
    const v = clauseCandidateVersion(c);
    if (!v) continue;
    const tags = parseScopeTags(c.scope);
    for (const pid of c.products) {
      if (!scopeTagsByProduct.has(pid)) scopeTagsByProduct.set(pid, []);
      scopeTagsByProduct.get(pid).push({ c, tags });
    }
  }
  for (const [pid, arr] of scopeTagsByProduct) {
    const positive = new Map(); // tag -> clause
    for (const { c, tags } of arr) {
      for (const t of tags) {
        if (!t.neg) {
          if (!positive.has(t.name)) positive.set(t.name, c);
        }
      }
    }
    for (const { c, tags } of arr) {
      for (const t of tags) {
        if (t.neg && positive.has(t.name)) {
          const other = positive.get(t.name);
          if (other.id !== c.id) {
            const sev = draftish(c) || draftish(other) ? 'warning' : 'error';
            issues.push(mkIssue('scope_conflict', sev, c, clauseCandidateVersion(c),
              `责任范围与同产品条款「${other.title}」矛盾：一方承保 #${t.name}，一方排除${sev === 'warning' ? '（含草稿条款，提交后将阻断发布）' : ''}`,
              { productId: pid, tag: t.name, otherClauseId: other.id }));
          }
        }
      }
    }
  }

  // 5) 地区覆盖缺口：条款覆盖产品所需地区缺少评审 / 产品没有地区
  for (const c of s.clauses) {
    for (const pid of c.products) {
      const p = s.products.find((x) => x.id === pid);
      if (!p) continue;
      if (p.regions.length === 0) {
        issues.push(mkIssue('region_gap', 'warning', c, clauseCandidateVersion(c),
          `产品「${p.name}」未配置覆盖地区`, { productId: pid }));
        continue;
      }
    }
    const required = requiredRegionsForClause(s, c);
    const v = clauseCandidateVersion(c);
    if (v && v.roundId) {
      const have = new Set(v.reviews.map((r) => r.verdict === 'pending' ? null : r.regionId).filter(Boolean));
      for (const rid of required) {
        if (!have.has(rid)) {
          const reg = s.regions.find((r) => r.id === rid);
          issues.push(mkIssue('region_review_missing', 'warning', c, v,
            `缺少地区「${reg ? reg.name : rid}」的评审结论`, { regionId: rid }));
        }
      }
    }
  }

  // 去重
  const seen = new Set();
  return issues.filter((i) => {
    const k = `${i.type}|${i.clauseId}|${i.versionId || ''}|${JSON.stringify(i.context)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function parseScopeTags(scope) {
  const tags = [];
  const re = /#(-?)([A-Za-z0-9_一-龥]+)/g;
  let m;
  while ((m = re.exec(scope || '')) !== null) {
    tags.push({ neg: m[1] === '-', name: m[2] });
  }
  return tags;
}

// 派生视图中的 issue id 必须确定性（同状态多次构建结果一致），不能用 uid()
function mkIssue(type, severity, clause, version, message, context = {}) {
  return {
    id: [type, clause ? clause.id : '-', version ? version.id : '-', JSON.stringify(context)].join('|'),
    type, severity, message, context,
    clauseId: clause ? clause.id : null,
    clauseTitle: clause ? clause.title : '',
    versionId: version ? version.id : null,
  };
}

// ---------- 生效准备度 ----------
function readiness(s) {
  const conflicts = detectConflicts(s);
  const rows = s.clauses.map((c) => {
    const required = requiredRegionsForClause(s, c);
    const v = clauseCandidateVersion(c);
    const reviewMap = v ? new Map(v.reviews.map((r) => [r.regionId, r])) : new Map();
    const regions = required.map((rid) => {
      const reg = s.regions.find((r) => r.id === rid);
      const rv = reviewMap.get(rid);
      return {
        regionId: rid,
        regionName: reg ? reg.name : rid,
        verdict: rv ? rv.verdict : 'missing',
        comment: rv ? rv.comment : '',
        roundId: rv ? rv.roundId : null,
      };
    });
    const myIssues = conflicts.filter((i) => i.clauseId === c.id);
    let level = 'not_ready';
    if (c.status === 'approved_current' && !myIssues.some((i) => i.severity === 'error') &&
        regions.every((r) => r.verdict === 'approved' || r.verdict === 'waived')) {
      level = myIssues.some((i) => i.severity === 'warning') ? 'ready_with_warnings' : 'ready';
    } else if (c.status === 'in_review' || c.status === 'returned') {
      level = 'in_review';
    }
    return {
      clauseId: c.id, title: c.title, code: c.code, status: c.status,
      effectiveDate: c.effectiveDate,
      currentVersionId: c.currentVersionId, openVersionId: c.openVersionId,
      products: c.products, requiredRegions: required, regions,
      issues: myIssues, readiness: level,
    };
  });
  return { rows, conflicts };
}

// ---------- 发布包 ----------
// 通过的条款（approved_current、无 error 冲突、依赖地区齐审）才能进发布包；
// 未通过或缺依赖的内容进隔离区并给出原因。
// 隔离原因：未通过、error 级冲突、地区未齐审；warning 级问题单独返回供界面提示
function quarantineReasons(s, c) {
  const reasons = [];
  if (c.status !== 'approved_current' || !c.currentVersionId) {
    reasons.push({ code: 'not_approved', text: `条款状态为 ${c.status}，未取得当前生效版本` });
  }
  const r = readiness(s);
  const row = r.rows.find((x) => x.clauseId === c.id);
  if (row) {
    for (const i of row.issues) {
      if (i.severity === 'error') reasons.push({ code: i.type, text: i.message });
    }
    const bad = row.regions.filter((x) => x.verdict !== 'approved' && x.verdict !== 'waived');
    if (bad.length) {
      const names = bad.map((m) => `「${m.regionName}」${m.verdict === 'missing' ? '缺评审' : m.verdict}`).join('、');
      reasons.push({ code: 'region_review_missing', text: `地区结论未齐：${names}` });
    }
  }
  return reasons;
}

function warningReasons(s, c) {
  const r = readiness(s);
  const row = r.rows.find((x) => x.clauseId === c.id);
  return row ? row.issues.filter((i) => i.severity === 'warning').map((i) => ({ code: i.type, text: i.message })) : [];
}

function quarantineList(s) {
  return s.clauses
    .filter((c) => quarantineReasons(s, c).length > 0)
    .map((c) => ({ clauseId: c.id, title: c.title, status: c.status, reasons: quarantineReasons(s, c), warnings: warningReasons(s, c) }));
}

function releaseCandidates(s) {
  return s.clauses
    .filter((c) => quarantineReasons(s, c).length === 0)
    .map((c) => ({ clauseId: c.id, title: c.title, status: c.status, warnings: warningReasons(s, c) }));
}

function createPackage(s, input = {}) {
  const ids = input.clauseIds || [];
  if (ids.length === 0) throw httpErr(400, '发布包至少包含一条条款');
  const accepted = [];
  const rejected = [];
  for (const id of ids) {
    const c = s.clauses.find((x) => x.id === id);
    if (!c) { rejected.push({ clauseId: id, title: '(已删除?)', reasons: [{ code: 'missing', text: '条款不存在' }] }); continue; }
    const reasons = quarantineReasons(s, c);
    if (reasons.length) rejected.push({ clauseId: c.id, title: c.title, reasons });
    else accepted.push(c);
  }
  if (accepted.length === 0) throw httpErr(409, '没有可发布的条款，全部留在隔离区');

  // 生效日期同包必须一致（同日生效），否则也算冲突
  const dates = new Set(accepted.map((c) => c.effectiveDate).filter(Boolean));
  if (dates.size > 1) {
    for (const c of accepted) {
      rejected.push({ clauseId: c.id, title: c.title, reasons: [{ code: 'effective_date_mismatch', text: `同包生效日期不一致：${[...dates].join(' / ')}` }] });
    }
    accepted.length = 0;
    throw httpErr(409, `包内条款生效日期不一致（${[...dates].join(' / ')}），已全部留在隔离区`);
  }

  const pkg = {
    id: uid('pkg'),
    name: input.name || `发布包 ${s.packages.length + 1}`,
    createdAt: nowIso(),
    status: 'assembled',
    effectiveDate: [...dates][0] || '',
    // 回执快照：冻结版本指针与文本，刷新/后续轮次改动不影响回执对应关系
    items: accepted.map((c) => {
      const v = c.versions.find((x) => x.id === c.currentVersionId);
      return {
        clauseId: c.id, code: c.code, title: c.title,
        versionId: v.id, versionIndex: v.index,
        body: v.body, scope: c.scope,
        definitionRefs: clone(v.definitionRefs),
        effectiveDate: c.effectiveDate,
        products: clone(c.products),
        regions: requiredRegionsForClause(s, c),
        reviews: clone(v.reviews),
        approvedRoundId: v.roundId,
      };
    }),
    rejected: rejected,
    handoffAt: null,
    handoffTo: input.handoffTo || '',
    receiptNo: null,
  };
  s.packages.push(pkg);
  audit(s, 'package_create', { packageId: pkg.id, accepted: pkg.items.length, rejected: rejected.length });
  return pkg;
}

function handoffPackage(s, pkgId, input = {}) {
  const pkg = mustFind(s.packages, pkgId, '发布包');
  if (pkg.status === 'handed_off') throw httpErr(409, '发布包已移交');
  pkg.status = 'handed_off';
  pkg.handoffAt = nowIso();
  pkg.handoffTo = input.to || pkg.handoffTo || '发布同事';
  pkg.receiptNo = 'RCPT-' + pkg.id.slice(-6).toUpperCase() + '-' + pkg.handoffAt.slice(0, 10).replace(/-/g, '');
  audit(s, 'package_handoff', { packageId: pkg.id, receiptNo: pkg.receiptNo });
  return pkg;
}

// 移交后校验：包内条款是否出现新版本/状态变化（回执仍指向旧快照，标记 drift）
function packageReceiptStatus(s, pkg) {
  let drift = [];
  if (pkg.status === 'handed_off') {
    for (const it of pkg.items) {
      const c = s.clauses.find((x) => x.id === it.clauseId);
      if (!c) { drift.push({ clauseId: it.clauseId, reason: '条款已删除' }); continue; }
      if (c.currentVersionId !== it.versionId) {
        drift.push({ clauseId: it.clauseId, reason: '条款已有新版本，回执仍指向发布时快照' });
      }
    }
  }
  return { receiptNo: pkg.receiptNo, status: pkg.status, drift };
}

// ---------- 审计与工具 ----------
function audit(s, action, detail) {
  s.audit.push({ id: uid('aud'), at: nowIso(), action, detail });
  if (s.audit.length > 2000) s.audit = s.audit.slice(-2000);
}
function mustFind(arr, id, label) {
  const x = arr.find((e) => e.id === id);
  if (!x) throw httpErr(404, `${label}不存在`);
  return x;
}
function httpErr(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// 派生：轮次视图（每个版本在各轮的结论，旧轮冻结展示）
function roundTimeline(s) {
  return s.rounds.map((r) => {
    const entries = [];
    for (const c of s.clauses) {
      for (const v of c.versions) {
        if (v.roundId === r.id || v.reviews.some((rv) => rv.roundId === r.id)) {
          entries.push({
            clauseId: c.id, clauseTitle: c.title, versionId: v.id, versionIndex: v.index,
            status: v.status, submittedAt: v.submittedAt, decidedAt: v.decidedAt,
            reviews: clone(v.reviews.filter((rv) => rv.roundId === r.id || rv.roundId == null)),
            frozen: r.status === ROUND_STATUS.CLOSED,
            supersedesVersionId: v.supersedesVersionId,
            resubmitsVersionId: v.resubmitsVersionId || null,
          });
        }
      }
    }
    return { id: r.id, name: r.name, status: r.status, openedAt: r.openedAt, closedAt: r.closedAt, entries };
  });
}

module.exports = {
  uid, nowIso, clone, withRuntime, defaultId, defaultNow, emptyState, httpErr,
  CLAUSE_STATUSES, VERSION_STATUS, ROUND_STATUS,
  addDefinition, updateDefinition, addRegion, addProduct, updateProductCoverage,
  createClause, saveDraft, submitVersion, replaceApproved, withdrawSubmission,
  openRound, closeRound, currentOpenRound, recordReview, requiredRegionsForClause,
  detectConflicts, readiness, quarantineList, quarantineReasons, releaseCandidates,
  createPackage, handoffPackage, packageReceiptStatus, roundTimeline,
};

// ---------- 命令分发（首次执行 + 重放共用） ----------
// 命令格式：{cmd: 'createClause', args: {...}}
// 首次执行时捕获函数内部所有 uid()/nowIso() 调用值，随日志一起持久化；
// 重放时按序回放，保证实体 ID、时间戳与首次完全一致。
const COMMAND_HANDLERS = {
  addDefinition: (s, a) => addDefinition(s, a),
  updateDefinition: (s, a) => updateDefinition(s, a.id, a.patch),
  addRegion: (s, a) => addRegion(s, a),
  addProduct: (s, a) => addProduct(s, a),
  updateProductCoverage: (s, a) => updateProductCoverage(s, a.id, a.regionIds),
  createClause: (s, a) => createClause(s, a),
  saveDraft: (s, a) => saveDraft(s, a.clauseId, a.patch),
  submit: (s, a) => submitVersion(s, a.clauseId, a.patch || {}),
  resubmit: (s, a) => submitVersion(s, a.clauseId, a.patch || {}),
  replace: (s, a) => replaceApproved(s, a.clauseId, a.patch || {}),
  withdraw: (s, a) => withdrawSubmission(s, a.clauseId, a.reason),
  openRound: (s, a) => openRound(s, a || {}),
  closeRound: (s, a) => closeRound(s, a.roundId),
  recordReview: (s, a) => recordReview(s, a.clauseId, a.versionId, a.input),
  createPackage: (s, a) => createPackage(s, a),
  handoffPackage: (s, a) => handoffPackage(s, a.packageId, a.input || {}),
};

function replayCommand(s, type, args) {
  const h = COMMAND_HANDLERS[type];
  if (!h) throw httpErr(400, `未知命令 ${type}`);
  return h(s, args || {});
}

// 执行一条命令并返回 {result, captured}，captured 用于写入 WAL
function executeCommand(s, type, args) {
  const captured = { ids: [], nows: [] };
  const result = withRuntime(
    (prefix) => { const v = defaultId(prefix); captured.ids.push(v); return v; },
    () => { const v = defaultNow(); captured.nows.push(v); return v; },
    () => replayCommand(s, type, args)
  );
  return { result, captured };
}

// 以捕获序列重放（索引自动推进）
function replayWithCaptured(s, entries) {
  for (const e of entries) {
    let ii = 0, ni = 0;
    withRuntime(
      () => e.captured.ids[ii++],
      () => e.captured.nows[ni++],
      () => replayCommand(s, e.type, e.args)
    );
  }
}

module.exports.executeCommand = executeCommand;
module.exports.replayWithCaptured = replayWithCaptured;
module.exports.replayCommand = replayCommand;
