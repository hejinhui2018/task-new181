'use strict';
/* ClauseHarbor 前端：原生 JS 单页，状态全部从 /api/state 派生，刷新即一致。 */

const VIEWS = [
  { key: 'dashboard', name: '总览', ico: '▤' },
  { key: 'clauses', name: '条款库', ico: '§' },
  { key: 'review', name: '评审轮次', ico: '⏱' },
  { key: 'conflicts', name: '冲突与准备度', ico: '⚠' },
  { key: 'release', name: '发布中心', ico: '📦' },
  { key: 'base', name: '定义 / 产品 / 地区', ico: '▦' },
  { key: 'system', name: '系统与恢复', ico: '🛠' },
];

const CLAUSE_STATUS = {
  draft: ['草稿', 'gray'], in_review: ['评审中', 'blue'], approved_current: ['当前通过', 'green'],
  returned: ['已退回', 'amber'], replaced: ['已替换', 'violet'], withdrawn: ['已撤回', 'gray'],
};
const VER_STATUS = {
  draft: ['草稿', 'gray'], submitted: ['已提交', 'blue'], returned: ['退回待补交', 'amber'],
  resubmitted: ['补交在审', 'blue'], approved: ['已通过', 'green'],
  rejected: ['已拒绝', 'red'], superseded: ['已被替换', 'violet'],
};
const VERDICT = {
  missing: ['缺评审', 'gray', 'v-missing'], pending: ['待结论', 'amber', 'v-pending'],
  approved: ['通过', 'green', 'v-approved'], returned: ['退回', 'amber', 'v-returned'],
  rejected: ['拒绝', 'red', 'v-rejected'], waived: ['免审', 'violet', 'v-waived'],
};
const READINESS = {
  ready: ['可发布', 'green'], ready_with_warnings: ['可发布（有提示）', 'green'],
  in_review: ['评审中', 'blue'], not_ready: ['未就绪', 'gray'],
};

let V = null;
const ui = { tab: 'dashboard', selectedRoundId: null, pkgSel: new Set(), clauseFilter: 'all' };

// ---------- 基础工具 ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function badge(map, key) {
  const m = map[key] || [key, 'gray'];
  return `<span class="badge ${m[1]} dot">${m[0]}</span>`;
}
function plainBadge(text, cls = 'gray') { return `<span class="badge ${cls}">${esc(text)}</span>`; }
function byId(arr, id) { return (arr || []).find((x) => x.id === id); }
function productName(id) { const p = byId(V.products, id); return p ? p.name : '?'; }
function regionName(id) { const r = byId(V.regions, id); return r ? r.name : '?'; }
function fmtDate(s) { return s ? esc(s) : '<span class="muted">—</span>'; }
function fmtTime(s) { return s ? esc(s.replace('T', ' ').slice(0, 16)) : ''; }

async function api(type, args) {
  const res = await fetch('/api/dispatch', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, args: args || {} }),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(j.error);
  V = j.view;
  return j.result;
}
async function apiPost(path, body) {
  const res = await fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : '{}',
  });
  return res.json();
}
async function refresh() {
  const j = await (await fetch('/api/state')).json();
  V = j;
  render();
}
function toast(msg, kind = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  $('#toastRoot').appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; }, 2800);
  setTimeout(() => t.remove(), 3200);
}

// ---------- 模态 ----------
function modal({ title, html, wide, mount, actions }) {
  const root = $('#modalRoot');
  root.innerHTML = `<div class="modal-mask">
    <div class="modal ${wide ? 'wide' : ''}">
      <div class="modal-hd"><h3>${esc(title)}</h3><button class="modal-x" data-act="closeModal">✕</button></div>
      <div class="modal-bd">${html}</div>
      <div class="modal-ft" id="modalActions"></div>
    </div></div>`;
  const bd = $('.modal-bd', root);
  const ft = $('#modalActions', root);
  if (mount) mount(bd);
  for (const a of actions || []) {
    const b = document.createElement('button');
    b.className = 'btn ' + (a.cls || '');
    b.textContent = a.label;
    b.onclick = () => a.onClick(bd);
    ft.appendChild(b);
  }
  const cancel = document.createElement('button');
  cancel.className = 'btn ghost';
  cancel.textContent = '关闭';
  cancel.onclick = closeModal;
  ft.prepend(cancel);
}
function closeModal() { $('#modalRoot').innerHTML = ''; }

// ---------- 渲染入口 ----------
function render() {
  // 导航
  $('#nav').innerHTML = VIEWS.map((vw) => {
    const badges = [];
    if (vw.key === 'review' && V.openRoundId) badges.push(`<span class="nav-badge">进行中</span>`);
    if (vw.key === 'conflicts' && V.conflicts.length) badges.push(`<span class="nav-badge">${V.conflicts.length}</span>`);
    if (vw.key === 'release' && V.quarantine.length) badges.push(`<span class="nav-badge">隔离 ${V.quarantine.length}</span>`);
    return `<button class="nav-item ${ui.tab === vw.key ? 'active' : ''}" data-act="goto" data-tab="${vw.key}">
      <span class="nav-ico">${vw.ico}</span>${vw.name}${badges.join('')}</button>`;
  }).join('');

  // 当前轮次状态
  const openRound = byId(V.rounds, V.openRoundId);
  $('#roundPill').innerHTML = openRound
    ? `当前轮次<br><b>${esc(openRound.name)}</b><br><span style="color:#7e8ca3">开启于 ${fmtTime(openRound.openedAt)}</span>`
    : `当前无开放轮次<br><span style="color:#7e8ca3">评审轮次均已关闭</span>`;

  const vw = VIEWS.find((x) => x.key === ui.tab);
  $('#viewTitle').textContent = vw.name;
  $('#viewSub').textContent = ({
    dashboard: '条款审核与发布交付的全局态势',
    clauses: '维护条款、版本、定义引用与产品归属',
    review: '按评审轮次查看地区意见；旧轮次结论冻结，不可覆盖',
    conflicts: '定义、责任范围、生效日期与地区覆盖的交叉核对',
    release: '通过条款组装发布包，未通过或缺依赖内容进入隔离区',
    base: '术语定义、销售产品与地区覆盖范围',
    system: '操作审计、异常恢复记录与故障演练',
  })[ui.tab] || '';

  $('#content').innerHTML = renderers[ui.tab]();
  (postRender[ui.tab] || (() => {}))();
}

// ================= 总览 =================
const renderers = {};
const postRender = {};

renderers.dashboard = () => {
  const approved = V.clauses.filter((c) => c.status === 'approved_current').length;
  const inReview = V.clauses.filter((c) => c.status === 'in_review').length;
  const returned = V.clauses.filter((c) => c.status === 'returned').length;
  const drafts = V.clauses.filter((c) => c.status === 'draft').length;
  const errors = V.conflicts.filter((i) => i.severity === 'error').length;
  const warns = V.conflicts.filter((i) => i.severity === 'warning').length;
  const handed = V.packages.filter((p) => p.status === 'handed_off').length;

  const recent = V.timeline.length ? V.timeline[V.timeline.length - 1] : null;
  const recentEntries = recent ? recent.entries.slice(-6).reverse() : [];

  return `
  <div class="grid k4">
    <div class="card stat accent"><div class="num">${V.clauses.length}</div><div class="lbl">条款总数</div><div class="sub">通过 ${approved} · 评审中 ${inReview} · 草稿 ${drafts}</div></div>
    <div class="card stat ${returned ? 'amber' : 'green'}"><div class="num">${approved}</div><div class="lbl">当前通过条款</div><div class="sub">${returned ? `另有 ${returned} 条被退回待补交` : '无退回件'}</div></div>
    <div class="card stat ${errors ? 'red' : (warns ? 'amber' : 'green')}"><div class="num">${errors}/${warns}</div><div class="lbl">阻断冲突 / 提示</div><div class="sub">error 级问题未消除前不能发布</div></div>
    <div class="card stat green"><div class="num">${handed}</div><div class="lbl">已移交发布包</div><div class="sub">共 ${V.packages.length} 个包 · 隔离区 ${V.quarantine.length} 条</div></div>
  </div>

  <div class="grid k2">
    <div class="card">
      <div class="card-hd"><h2>最近轮次动态</h2><span class="hint">${recent ? esc(recent.name) : ''}</span></div>
      <div class="card-bd">
        ${recentEntries.length ? recentEntries.map((e) => `
          <div class="review-line">
            <span class="badge ${e.frozen ? 'gray' : 'blue'}">${e.frozen ? '冻结' : '在审'}</span>
            <span><b>${esc(e.clauseTitle)}</b> <span class="muted">v${e.versionIndex} · ${VER_STATUS[e.status][0]}</span></span>
            <span class="muted" style="margin-left:auto">${e.reviews.length} 条地区意见</span>
          </div>`).join('') : '<div class="empty">暂无评审活动</div>'}
      </div>
    </div>
    <div class="card">
      <div class="card-hd"><h2>阻断冲突与隔离区</h2></div>
      <div class="card-bd">
        ${V.conflicts.filter((i) => i.severity === 'error').slice(0, 4).map((i) => `
          <div class="issue error"><div><div>${esc(i.message)}</div><div class="itype">${esc(i.clauseTitle)} · ${i.type}</div></div></div>`).join('') ||
          '<p class="muted">当前无阻断级冲突。</p>'}
        <div class="section-title" style="margin-top:12px">隔离区（${V.quarantine.length}）</div>
        ${V.quarantine.slice(0, 4).map((q) => `<div class="review-line">
          <span>${badge(CLAUSE_STATUS, q.status)}</span><b>${esc(q.title)}</b>
          <span class="muted" style="margin-left:auto">${q.reasons[0] ? esc(q.reasons[0].text).slice(0, 26) : ''}</span></div>`).join('') || '<p class="muted">无隔离内容。</p>'}
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-hd"><h2>发布包回执</h2><span class="hint">回执为移交时版本快照，刷新与后续轮次不改变其对应关系</span></div>
    <div class="card-bd flush">
      ${V.packages.length ? `<table><thead><tr><th>发布包</th><th>状态</th><th>条款数</th><th>生效日</th><th>回执号</th><th>漂移</th></tr></thead><tbody>
      ${V.packages.map((p) => `<tr class="clickable" data-act="goto" data-tab="release"><td><b>${esc(p.name)}</b></td>
        <td>${p.status === 'handed_off' ? plainBadge('已移交', 'green') : plainBadge('已组装', 'blue')}</td>
        <td>${p.items.length}</td><td>${fmtDate(p.effectiveDate)}</td>
        <td class="mono">${p.receiptNo ? esc(p.receiptNo) : '—'}</td>
        <td>${p.receipt.drift.length ? plainBadge(`${p.receipt.drift.length} 项后续变更`, 'amber') : '<span class="muted">一致</span>'}</td></tr>`).join('')}
      </tbody></table>` : '<div class="empty"><div class="big">📦</div>还没有发布包</div>'}
    </div>
  </div>`;
};

// ================= 条款库 =================
renderers.clauses = () => {
  const filters = [['all', '全部'], ['draft', '草稿'], ['in_review', '评审中'], ['returned', '已退回'], ['approved_current', '已通过']];
  let list = V.clauses;
  if (ui.clauseFilter !== 'all') list = list.filter((c) => c.status === ui.clauseFilter);
  return `
  <div class="filter-bar">
    ${filters.map(([k, n]) => `<button class="btn sm ${ui.clauseFilter === k ? 'primary' : ''}" data-act="filterClause" data-f="${k}">${n}</button>`).join('')}
    <span style="flex:1"></span>
    <button class="btn primary" data-act="newClause">＋ 新建条款</button>
  </div>
  <div class="card"><div class="card-bd flush">
    ${list.length ? `<table><thead><tr><th>编号 / 标题</th><th>状态</th><th>关联产品</th><th>生效日</th><th>版本</th><th>引用定义</th><th></th></tr></thead><tbody>
    ${list.map((c) => {
      const cv = byId(c.versions, c.currentVersionId);
      const ov = byId(c.versions, c.openVersionId);
      const refs = cv ? cv.definitionRefs : (ov ? ov.definitionRefs : []);
      return `<tr>
        <td><div><b>${esc(c.title)}</b></div><div class="muted mono">${esc(c.code || '—')}</div></td>
        <td>${badge(CLAUSE_STATUS, c.status)}</td>
        <td>${c.products.map(productName).map(esc).join('、') || '<span class="muted">未关联</span>'}</td>
        <td>${fmtDate(c.effectiveDate)}</td>
        <td><span class="mono">v${cv ? cv.index : (ov ? ov.index : '—')}${c.versions.length > 1 ? ` / ${c.versions.length}` : ''}</span></td>
        <td>${(refs || []).map((r) => {
          const ok = V.definitions.some((d) => d.code === r);
          return `<span class="code-tag" style="${ok ? '' : 'background:var(--red-soft);color:var(--red)'}">${esc(r)}</span>`;
        }).join(' ') || '<span class="muted">—</span>'}</td>
        <td style="text-align:right"><button class="btn sm" data-act="openClause" data-id="${c.id}">查看</button></td>
      </tr>`;
    }).join('')}</tbody></table>` : '<div class="empty"><div class="big">§</div>没有匹配的条款，点击右上角新建</div>'}
  </div></div>`;
};
postRender.clauses = () => {};

// 条款编辑表单（新建/草稿编辑/补交/替换共用）
function clauseFormHtml(c, opts = {}) {
  const v = c && c.openVersionId ? byId(c.versions, c.openVersionId) : null;
  const val = (field, dflt = '') => c ? (c[field] || dflt) : dflt;
  const body = c && v ? v.body : '';
  const refs = c && v ? v.definitionRefs : [];
  return `
  <div class="form-grid">
    <div class="form-row"><label>条款标题 *</label><input name="title" value="${esc(val('title'))}" ${opts.readonlyHeader ? 'disabled' : ''}></div>
    <div class="form-row"><label>条款编号</label><input name="code" value="${esc(val('code'))}" ${opts.readonlyHeader ? 'disabled' : ''}></div>
    <div class="form-row"><label>生效日期</label><input type="date" name="effectiveDate" value="${esc(val('effectiveDate'))}"></div>
    <div class="form-row"><label>关联产品</label>
      <div class="check-pills">${V.products.map((p) => `<label class="check-pill ${c && c.products.includes(p.id) ? 'on' : ''}">
        <input type="checkbox" name="products" value="${p.id}" ${c && c.products.includes(p.id) ? 'checked' : ''} style="display:none">${esc(p.name)}</label>`).join('')}</div>
    </div>
  </div>
  <div class="form-row"><label>责任范围 <span class="help">用 #责任项 表示承保、#-责任项 表示排除，用于责任矛盾核对</span></label>
    <input name="scope" value="${esc(val('scope'))}"></div>
  <div class="form-row"><label>引用定义 <span class="help">勾选术语库定义；也可输入自定义编码（缺定义会报冲突）</span></label>
    <div class="check-pills" id="refPills">
      ${V.definitions.map((d) => `<label class="check-pill ${refs.includes(d.code) ? 'on' : ''}">
        <input type="checkbox" name="refs" value="${esc(d.code)}" ${refs.includes(d.code) ? 'checked' : ''} style="display:none">${esc(d.code)}</label>`).join('')}
    </div>
    <div style="margin-top:7px"><input type="text" id="refCustom" list="defList" placeholder="添加自定义定义编码后回车">
      <datalist id="defList">${V.definitions.map((d) => `<option value="${esc(d.code)}">`).join('')}</datalist></div>
    <div id="refExtra" style="margin-top:6px">${refs.filter((r) => !V.definitions.some((d) => d.code === r)).map((r) =>
      `<span class="code-tag" style="background:var(--red-soft);color:var(--red);margin-right:5px">${esc(r)} <a data-act="removeRef" data-r="${esc(r)}" style="cursor:pointer">✕</a></span>`).join('')}</div>
  </div>
  <div class="form-row"><label>条款正文</label><textarea name="body" style="min-height:120px">${esc(body)}</textarea></div>`;
}
function readClauseForm(root, baseRefs = []) {
  const q = (n) => root.querySelector(`[name="${n}"]`);
  const custom = [...root.querySelectorAll('#refExtra .code-tag')].map((e) => e.textContent.trim().replace(' ✕', ''));
  return {
    title: q('title').value.trim(),
    code: q('code').value.trim(),
    effectiveDate: q('effectiveDate').value,
    scope: q('scope').value.trim(),
    products: [...root.querySelectorAll('[name=products]:checked')].map((e) => e.value),
    definitionRefs: [...new Set([...root.querySelectorAll('[name=refs]:checked').map((e) => e.value), ...custom])],
    body: q('body').value,
  };
}
function bindRefPills(root) {
  // 多选/单选标签全部走原生 label>input 行为 + CSS :has(input:checked) 高亮，无需手动同步。
  const inp = $('#refCustom', root);
  if (inp) inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && inp.value.trim()) {
      e.preventDefault();
      const code = inp.value.trim();
      const box = $('#refExtra', root);
      if (!box.textContent.includes(code)) {
        const s = document.createElement('span');
        s.className = 'code-tag';
        s.style.cssText = 'background:var(--red-soft);color:var(--red);margin-right:5px';
        s.innerHTML = `${esc(code)} <a style="cursor:pointer" data-act="removeRef" data-r="${esc(code)}">✕</a>`;
        box.appendChild(s);
      }
      inp.value = '';
    }
  });
}

function openClauseModal(c) {
  const cv = byId(c.versions, c.currentVersionId);
  const ov = byId(c.versions, c.openVersionId);
  const row = V.readiness.find((r) => r.clauseId === c.id);
  const openRound = byId(V.rounds, V.openRoundId);
  const versionsHtml = c.versions.map((v) => {
    const round = byId(V.rounds, v.roundId);
    const cls = v.id === c.currentVersionId ? 'current' : (v.id === c.openVersionId ? 'open' : (v.status === 'superseded' ? 'superseded' : ''));
    return `<span class="ver-chip ${cls}" data-act="pickVersion" data-cid="${c.id}" data-vid="${v.id}" title="${round ? esc(round.name) : '未提交'}">
      v${v.index} ${VER_STATUS[v.status][0]}${round ? ' · ' + esc(round.name.replace(/^2026 年/, '')) : ''}</span>`;
  }).join('');

  const shownVersion = window.__pickVid && byId(c.versions, window.__pickVid) ? byId(c.versions, window.__pickVid) : (cv || ov);
  const shownRound = byId(V.rounds, shownVersion && shownVersion.roundId);

  const actions = [];
  if (ov && ov.status === 'draft') {
    actions.push({ label: '编辑并保存草稿', cls: 'primary', onClick: (bd) => editDraft(c) });
    if (openRound) actions.push({ label: '提交到当前轮次', cls: '', onClick: () => doSubmit(c.id, 'submit') });
  }
  if (ov && (ov.status === 'submitted' || ov.status === 'resubmitted') && openRound && ov.roundId === openRound.id) {
    actions.push({ label: '撤回到草稿', cls: 'danger', onClick: () => withdraw(c.id) });
  }
  if (ov && (ov.status === 'returned' || ov.status === 'rejected') && openRound) {
    actions.push({ label: '修改并补交（新版本）', cls: 'primary', onClick: () => resubmit(c) });
  }
  if (c.status === 'approved_current' && !ov && openRound) {
    actions.push({ label: '发起替换（新版本进当前轮）', cls: 'primary', onClick: () => replaceClause(c) });
  }

  modal({
    title: c.title, wide: true,
    html: `
    <div class="kv">
      <dt>编号</dt><dd class="mono">${esc(c.code || '—')}</dd>
      <dt>状态</dt><dd>${badge(CLAUSE_STATUS, c.status)}</dd>
      <dt>关联产品</dt><dd>${c.products.map(productName).map(esc).join('、') || '—'}（需地区：${row ? row.requiredRegions.map(regionName).map(esc).join('、') : '—'}）</dd>
      <dt>生效日期</dt><dd>${fmtDate(c.effectiveDate)}</dd>
      <dt>责任范围</dt><dd>${esc(c.scope || '—')}</dd>
    </div>
    <div class="form-row" style="margin-top:12px"><label>版本谱系（旧版本与旧轮次意见永久保留）</label><div class="version-strip">${versionsHtml}</div></div>
    <div class="form-row"><label>${shownVersion ? `v${shownVersion.index} 正文 ${shownRound ? '· ' + esc(shownRound.name) : ''} ${shownVersion && shownVersion.status === 'superseded' ? '· 已被替换（冻结）' : ''}` : '正文'}</label>
      <div class="clause-body">${esc(shownVersion ? shownVersion.body : '')}</div></div>
    <div class="form-row"><label>地区意见 ${shownRound && shownRound.status === 'closed' ? '<span class="frozen-tag">该轮已关闭，结论冻结</span>' : ''}</label>
      ${shownVersion && shownVersion.reviews.length ? shownVersion.reviews.map((rv) => `
        <div class="review-line"><span style="min-width:70px">${esc(regionName(rv.regionId))}</span>
          <span style="min-width:56px">${badge(VERDICT, rv.verdict)}</span>
          <span class="muted">${esc(rv.comment || '')} ${rv.reviewer ? '· ' + esc(rv.reviewer) : ''} · ${fmtTime(rv.at)}</span></div>`).join('') : '<p class="muted">暂无地区意见</p>'}
    </div>
    ${row && row.issues.length ? `<div class="form-row"><label>本条款冲突</label>${row.issues.map((i) =>
      `<div class="issue ${i.severity}"><div><div>${esc(i.message)}</div><div class="itype">${i.type}</div></div></div>`).join('')}</div>` : ''}
    ${actions.length ? '' : '<p class="muted">当前状态下没有可执行操作（需要开放轮次或等待评审）。</p>'}`,
    actions,
  });
}

function editDraft(c) {
  modal({
    title: `编辑草稿 · ${c.title}`,
    html: clauseFormHtml(c),
    mount: bindRefPills,
    actions: [{
      label: '保存草稿', cls: 'primary',
      onClick: async (bd) => {
        const patch = readClauseForm(bd);
        try { await api('saveDraft', { clauseId: c.id, patch }); toast('草稿已保存（未进入任何评审轮次）', 'ok'); closeModal(); render(); }
        catch (e) { toast(e.message, 'err'); }
      },
    }],
  });
}
async function doSubmit(clauseId, type, patch) {
  try { await api(type, { clauseId, patch: patch || {} }); toast('已提交到当前开放轮次', 'ok'); closeModal(); render(); }
  catch (e) { toast(e.message, 'err'); }
}
async function withdraw(clauseId) {
  modal({
    title: '撤回到草稿',
    html: '<div class="form-row"><label>撤回原因（可选）</label><textarea name="reason" placeholder="例如：发现定义引用有误，需内部修订"></textarea></div><div class="muted">撤回仅作用于当前开放轮次的在途版本；已关闭轮次的历史意见不会被删除。</div>',
    actions: [{
      label: '确认撤回', cls: 'danger',
      onClick: async (bd) => {
        try { await api('withdraw', { clauseId, reason: bd.querySelector('[name=reason]').value }); toast('已撤回为草稿', 'ok'); closeModal(); render(); }
        catch (e) { toast(e.message, 'err'); }
      },
    }],
  });
}
function resubmit(c) {
  modal({
    title: `补交 · ${c.title}`,
    html: `<div class="issue warning" style="margin-bottom:12px"><div>补交将<b>新建一个版本</b>进入当前轮次；被退回的旧版本与旧轮次地区意见原样冻结保留，不会被覆盖。</div></div>` + clauseFormHtml(c),
    mount: bindRefPills,
    actions: [{
      label: '补交新版本', cls: 'primary',
      onClick: async (bd) => {
        const patch = readClauseForm(bd);
        try { await api('resubmit', { clauseId: c.id, patch }); toast('已补交为新版本，进入当前轮次', 'ok'); closeModal(); render(); }
        catch (e) { toast(e.message, 'err'); }
      },
    }],
  });
}
function replaceClause(c) {
  modal({
    title: `发起替换 · ${c.title}`,
    html: `<div class="issue warning" style="margin-bottom:12px"><div>替换会基于当前通过版本<b>新建版本</b>提交当前轮次。评审通过前旧版本仍是生效版本；若替换件被退回/拒绝/撤回，旧版本自动恢复为当前版本。</div></div>` + clauseFormHtml(c, { readonlyHeader: false }),
    mount: bindRefPills,
    actions: [{
      label: '提交替换版本', cls: 'primary',
      onClick: async (bd) => {
        const patch = readClauseForm(bd);
        try { await api('replace', { clauseId: c.id, patch }); toast('替换版本已进入当前轮次', 'ok'); closeModal(); render(); }
        catch (e) { toast(e.message, 'err'); }
      },
    }],
  });
}

// ================= 评审轮次 =================
renderers.review = () => {
  if (!V.rounds.length) return '<div class="empty"><div class="big">⏱</div>还没有评审轮次<button class="btn primary" style="margin-top:14px" data-act="openRound">开启第 1 轮</button></div>';
  if (!ui.selectedRoundId) ui.selectedRoundId = V.rounds[V.rounds.length - 1].id;
  const round = byId(V.rounds, ui.selectedRoundId) || V.rounds[0];
  const tl = V.timeline.find((t) => t.id === round.id);
  return `
  <div class="round-tabs">
    ${V.rounds.map((r) => `<button class="round-tab ${r.id === round.id ? 'active' : ''}" data-act="pickRound" data-id="${r.id}">
      ${esc(r.name)} ${r.status === 'open' ? '<span class="badge blue dot" style="margin-left:5px">开放中</span>' : '<span class="badge gray" style="margin-left:5px">已冻结</span>'}</button>`).join('')}
    <span style="flex:1"></span>
    ${V.openRoundId ? '' : '<button class="btn primary sm" data-act="openRound">开启新一轮</button>'}
    ${round.status === 'open' ? '<button class="btn sm danger" data-act="closeRound" data-id="'+round.id+'">关闭本轮（冻结结论）</button>' : ''}
  </div>
  <div class="card">
    <div class="card-hd"><h2>${esc(round.name)}</h2>
      <span class="hint">${round.status === 'open' ? `开放中，开启于 ${fmtTime(round.openedAt)}` : `已关闭于 ${fmtTime(round.closedAt)}，全部结论冻结`}</span></div>
    <div class="card-bd">
      ${tl.entries.length ? tl.entries.map((e) => renderTimelineEntry(e, round)).join('') : '<div class="empty">本轮暂无提交</div>'}
    </div>
  </div>`;
};

function renderTimelineEntry(e, round) {
  const c = byId(V.clauses, e.clauseId);
  const row = V.readiness.find((r) => r.clauseId === c.id);
  // 仅开放轮 + 该条款当前在途版本可登记意见；已通过归档或被补交/替换接管的版本不显示入口
  const canReview = round.status === 'open' && c.openVersionId === e.versionId;
  const reviewCells = row ? row.regions.map((rg) => {
    const rv = e.reviews.find((x) => x.regionId === rg.regionId);
    const current = rv ? rv.verdict : 'missing';
    return `<div style="margin-bottom:6px"><b style="display:inline-block;min-width:64px">${esc(rg.regionName)}</b>
      ${badge(VERDICT, current)}
      ${rv && rv.comment ? `<div class="muted" style="padding:2px 0 0 66px">${esc(rv.comment)}${rv.reviewer ? ' · ' + esc(rv.reviewer) : ''}</div>` : ''}
      ${canReview ? `<button class="btn sm" style="margin-left:8px" data-act="reviewForm" data-cid="${c.id}" data-vid="${e.versionId}" data-rid="${rg.regionId}">${rv ? '修改' : '登记意见'}</button>` : ''}
    </div>`;
  }).join('') : '';
  const resubOf = (e.supersedesVersionId || e.resubmitsVersionId)
    ? `<span class="tag-mini">${e.supersedesVersionId ? '替换' : '补交'} v${(byId(c.versions, e.supersedesVersionId || e.resubmitsVersionId) || {}).index || '?'}</span>` : '';
  return `
  <div class="tl-entry st-${e.status}">
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <b>${esc(e.clauseTitle)}</b> ${resubOf}
      <span class="muted mono">v${e.versionIndex}</span>
      ${badge(VER_STATUS, e.status)}
      <span class="muted">${e.submittedAt ? '提交于 ' + fmtTime(e.submittedAt) : ''} ${e.decidedAt ? '· 结论于 ' + fmtTime(e.decidedAt) : ''}</span>
      <button class="btn sm" style="margin-left:auto" data-act="openClause" data-id="${c.id}">条款详情</button>
    </div>
    <div style="margin:8px 0 0 4px">${reviewCells}</div>
    ${round.status === 'closed' ? `<div class="tl-frozen">🔒 本轮已关闭：以上 ${e.reviews.length} 条地区意见为冻结历史结论，新版本须在后续轮次提交，不能覆盖本记录。</div>` : ''}
  </div>`;
}

function reviewForm(cid, vid, rid) {
  const c = byId(V.clauses, cid);
  const v = byId(c.versions, vid);
  const existing = v.reviews.find((x) => x.regionId === rid);
  modal({
    title: `登记地区意见 · ${c.title} v${v.index}`,
    html: `
    <div class="kv" style="margin-bottom:12px"><dt>地区</dt><dd>${esc(regionName(rid))}</dd><dt>轮次</dt><dd>${esc(byId(V.rounds, v.roundId).name)}</dd></div>
    <div class="form-row"><label>结论</label>
      <div class="check-pills">${Object.entries(VERDICT).filter(([k]) => k !== 'missing').map(([k, m]) =>
        `<label class="check-pill ${existing && existing.verdict === k ? 'on' : ''}"><input type="radio" name="verdict" value="${k}" style="display:none" ${existing && existing.verdict === k ? 'checked' : ''}>${m[0]}</label>`).join('')}</div>
    </div>
    <div class="form-row"><label>评审人</label><input name="reviewer" value="${esc(existing ? existing.reviewer : '')}"></div>
    <div class="form-row"><label>意见正文 <span class="help">新一轮结论不会改动旧轮次记录</span></label><textarea name="comment">${esc(existing ? existing.comment : '')}</textarea></div>`,
    actions: [{
      label: '保存意见', cls: 'primary',
      onClick: async (bd) => {
        const verdict = bd.querySelector('[name=verdict]:checked');
        if (!verdict) return toast('请选择结论', 'err');
        try {
          await api('recordReview', {
            clauseId: cid, versionId: vid,
            input: { regionId: rid, verdict: verdict.value, reviewer: bd.querySelector('[name=reviewer]').value, comment: bd.querySelector('[name=comment]').value },
          });
          toast('意见已登记，条款状态已自动复核', 'ok'); closeModal(); render();
        } catch (e2) { toast(e2.message, 'err'); }
      },
    }],
  });
}

// ================= 冲突与准备度 =================
renderers.conflicts = () => {
  const regions = V.regions;
  return `
  <div class="grid k2">
    <div class="card">
      <div class="card-hd"><h2>交叉核对结果</h2><span class="hint">定义引用 / 责任范围 / 生效日期 / 地区覆盖</span></div>
      <div class="card-bd">
        ${V.conflicts.length ? V.conflicts.map((i) => `
          <div class="issue ${i.severity}">
            <div style="flex:1"><div><b>${i.severity === 'error' ? '阻断' : '提示'}</b> · ${esc(i.message)}</div>
            <div class="itype">${i.type} · 条款：<a data-act="openClauseFromId" data-id="${i.clauseId}" style="cursor:pointer">${esc(i.clauseTitle)}</a></div></div>
            <button class="btn sm" data-act="openClauseFromId" data-id="${i.clauseId}">处理</button>
          </div>`).join('') : '<div class="empty">没有发现冲突 🎉</div>'}
      </div>
    </div>
    <div class="card">
      <div class="card-hd"><h2>图例与规则</h2></div>
      <div class="card-bd" style="font-size:12.5px">
        <p><b>阻断（红）</b>：引用定义缺失、非草稿条款间责任范围互斥。未消除不能进发布包。</p>
        <p><b>提示（黄）</b>：定义内联文本漂移、生效日期不一致、地区评审缺口、草稿阶段的潜在矛盾。</p>
        <p>责任标签语法：正文/责任范围中 <code class="code-tag">#门诊</code> 表示承保，<code class="code-tag">#-门诊</code> 表示排除。</p>
        <p>生效日期核对仅统计已提交/已通过条款，草稿不影响基线日期。</p>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-hd"><h2>生效准备度矩阵</h2><span class="hint">行＝条款，列＝产品所需地区，地区结论按当前候选版本取数</span></div>
    <div class="card-bd flush">
      <table class="matrix"><thead><tr><th class="clause-cell">条款</th><th>状态</th>${regions.map((r) => `<th>${esc(r.name)}</th>`).join('')}<th>生效日</th><th>准备度</th></tr></thead>
      <tbody>${V.readiness.map((row) => `<tr class="clickable" data-act="openClause" data-id="${row.clauseId}">
        <td class="clause-cell"><b>${esc(row.title)}</b><div class="muted mono">${esc(row.code || '')}</div></td>
        <td>${badge(CLAUSE_STATUS, row.status)}</td>
        ${regions.map((r) => {
          const cell = row.regions.find((x) => x.regionId === r.id);
          if (!cell) return '<td class="muted verdict-cell">·</td>';
          const [txt, , cls] = VERDICT[cell.verdict];
          return `<td class="verdict-cell ${cls}" title="${esc(cell.comment)}">${txt}</td>`;
        }).join('')}
        <td>${fmtDate(row.effectiveDate)}</td>
        <td>${badge(READINESS, row.readiness)}</td>
      </tr>`).join('')}</tbody></table>
    </div>
  </div>`;
};

// ================= 发布中心 =================
renderers.release = () => {
  const cands = V.releaseCandidates;
  cands.forEach((c) => { if (!ui.pkgSel.has(c.clauseId) && V.packages.length === 0) {/* 默认不全选 */} });
  return `
  <div class="grid k2">
    <div class="card">
      <div class="card-hd"><h2>可发布条款（${cands.length}）</h2>
        <button class="btn sm" data-act="toggleAllCands">全选/清空</button></div>
      <div class="card-bd flush">
        ${cands.length ? `<table><tbody>${cands.map((c) => `
          <tr><td style="width:34px"><input type="checkbox" data-act="selCand" data-id="${c.clauseId}" ${ui.pkgSel.has(c.clauseId) ? 'checked' : ''}></td>
          <td><b>${esc(c.title)}</b>${c.warnings.length ? `<div class="muted" style="font-size:12px">提示：${esc(c.warnings[0].message).slice(0, 40)}…</div>` : ''}</td>
          <td><button class="btn sm" data-act="openClause" data-id="${c.clauseId}">查看</button></td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">没有满足发布条件的条款</div>'}
        <div style="padding:14px 18px;display:flex;gap:9px;align-items:center">
          <input type="text" id="pkgName" placeholder="发布包名称，如：医疗险 10.1 修订包" style="flex:1">
          <input type="text" id="pkgTo" placeholder="移交对象，如：发布同事·林舟" style="width:200px">
          <button class="btn primary" data-act="createPkg">组装发布包</button>
        </div>
      </div>
    </div>

    <div class="card quar">
      <div class="card-hd"><h2>隔离区（${V.quarantine.length}）</h2><span class="hint">未通过或缺依赖，不能进入发布包</span></div>
      <div class="card-bd flush">
        ${V.quarantine.length ? `<table><tbody>${V.quarantine.map((q) => `
          <tr><td><b>${esc(q.title)}</b> ${badge(CLAUSE_STATUS, q.status)}
            <ul class="reason-list">${q.reasons.map((r) => `<li>${esc(r.text)}</li>`).join('')}</ul>
            ${q.warnings.length ? `<div class="muted" style="font-size:12px;margin-top:3px">另有提示：${q.warnings.length} 条（不阻断）</div>` : ''}
          </td><td style="text-align:right"><button class="btn sm" data-act="openClause" data-id="${q.clauseId}">去处理</button></td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">隔离区为空，所有条款均已就绪</div>'}
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-hd"><h2>发布包与回执</h2><span class="hint">回执冻结发布时的版本、正文与地区意见；条款后续改版只产生漂移提示，不改动回执</span></div>
    <div class="card-bd">
      ${V.packages.length ? V.packages.map(renderPackage).join('') : '<div class="empty"><div class="big">📦</div>暂无发布包</div>'}
    </div>
  </div>`;
};

function renderPackage(p) {
  return `
  <div class="receipt" style="margin-bottom:14px">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <b style="font-size:15px">${esc(p.name)}</b>
      ${p.status === 'handed_off' ? plainBadge('已移交', 'green') : plainBadge('已组装', 'blue')}
      <span class="muted">生效日 ${fmtDate(p.effectiveDate)} · ${p.items.length} 条 · 组装于 ${fmtTime(p.createdAt)}</span>
      <span style="flex:1"></span>
      ${p.status === 'handed_off'
        ? `<span class="rcpt-no">${esc(p.receiptNo)}</span>`
        : `<button class="btn primary sm" data-act="handoffPkg" data-id="${p.id}">移交发布同事</button>`}
    </div>
    ${p.handoffTo ? `<div class="muted" style="margin-top:5px">接收方：${esc(p.handoffTo)} · 移交时间：${fmtTime(p.handoffAt)}</div>` : ''}
    <table style="margin-top:10px"><thead><tr><th>条款</th><th>版本快照</th><th>引用定义</th><th>地区意见快照</th><th>通过轮次</th></tr></thead><tbody>
      ${p.items.map((it) => `<tr><td><b>${esc(it.title)}</b><div class="muted mono">${esc(it.code || '')}</div></td>
        <td class="mono">v${it.versionIndex}</td>
        <td>${it.definitionRefs.map((r) => `<span class="code-tag">${esc(r)}</span>`).join(' ') || '—'}</td>
        <td>${it.regions.map((rid) => {
          const rv = it.reviews.find((x) => x.regionId === rid);
          return `<span class="verdict-cell ${rv ? VERDICT[rv.verdict][2] : 'v-missing'}">${esc(regionName(rid))}·${rv ? VERDICT[rv.verdict][0] : '缺'}</span>`;
        }).join('，')}</td>
        <td class="muted">${esc(((byId(V.rounds, it.approvedRoundId) || {}).name) || '—')}</td></tr>`).join('')}
    </tbody></table>
    ${p.receipt.drift.length ? `<div class="drift-note">⚠ 回执后变更（回执内容不变，仅提示交付侧注意）：<br>${p.receipt.drift.map((d) => `· ${esc(byId(V.clauses, d.clauseId) ? byId(V.clauses, d.clauseId).title : d.clauseId)}：${esc(d.reason)}`).join('<br>')}</div>` : ''}
    ${p.rejected.length ? `<div class="drift-note" style="background:var(--red-soft);color:var(--red)">组装时被拦下 ${p.rejected.length} 条，已留在隔离区：${p.rejected.map((r) => esc(r.title)).join('、')}</div>` : ''}
  </div>`;
}

// ================= 基础数据 =================
renderers.base = () => `
  <div class="grid k3">
    <div class="card">
      <div class="card-hd"><h2>术语 / 定义库（${V.definitions.length}）</h2></div>
      <div class="card-bd flush">
        ${V.definitions.length ? `<table><tbody>${V.definitions.map((d) => `
          <tr><td><b class="code-tag">${esc(d.code)}</b> <b>${esc(d.title)}</b>
            <div class="muted" style="font-size:12.5px;margin-top:3px">${esc(d.text)}</div>
            <button class="btn sm" style="margin-top:6px" data-act="editDef" data-id="${d.id}">编辑文本</button></td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">暂无定义</div>'}
        <div style="padding:14px 18px">
          <button class="btn primary sm" data-act="newDef">＋ 新增定义</button>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="card-hd"><h2>地区（${V.regions.length}）</h2></div>
      <div class="card-bd flush">
        ${V.regions.length ? `<table><tbody>${V.regions.map((r) => `
          <tr><td><b>${esc(r.name)}</b> <span class="muted mono">${esc(r.code)}</span></td></tr>`).join('')}</tbody></table>` : '<div class="empty">暂无地区</div>'}
        <div style="padding:14px 18px">
          <input type="text" id="newRegionName" placeholder="地区名称，如：西南区" style="margin-bottom:7px">
          <input type="text" id="newRegionCode" placeholder="代码（可选），如 SW" style="margin-bottom:9px">
          <button class="btn primary sm" data-act="newRegion">＋ 新增地区</button>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="card-hd"><h2>产品与地区覆盖（${V.products.length}）</h2></div>
      <div class="card-bd flush">
        ${V.products.length ? `<table><tbody>${V.products.map((p) => `
          <tr><td><b>${esc(p.name)}</b> <span class="muted mono">${esc(p.code)}</span>
            <div style="margin-top:6px">${V.regions.map((r) => `<span class="badge ${p.regions.includes(r.id) ? 'green' : 'gray'}" style="margin:0 5px 5px 0">${esc(r.name)}${p.regions.includes(r.id) ? ' ✓' : ''}</span>`).join('')}</div>
            <button class="btn sm" data-act="editProduct" data-id="${p.id}">调整覆盖地区</button></td></tr>`).join('')}</tbody></table>` : '<div class="empty">暂无产品，请先新增地区</div>'}
        <div style="padding:14px 18px">
          <button class="btn primary sm" data-act="newProduct" ${V.regions.length ? '' : 'disabled'}>＋ 新增产品</button>
        </div>
      </div>
    </div>
  </div>`;

// ================= 系统与恢复 =================
renderers.system = () => `
  <div class="grid k3">
    <div class="card stat"><div class="num">${V.appliedSeq}</div><div class="lbl">已持久化命令序号 (WAL seq)</div></div>
    <div class="card stat ${V.recoveryEvents.length ? 'amber' : 'green'}"><div class="num">${V.recoveryEvents.length}</div><div class="lbl">异常恢复事件</div></div>
    <div class="card stat"><div class="num">${V.audit.length}</div><div class="lbl">近 200 条业务审计</div></div>
  </div>
  <div class="card">
    <div class="card-hd"><h2>持久化与异常恢复演练</h2><span class="hint">所有写操作先追加 WAL 再提交内存；快照 tmp+rename 原子落盘</span></div>
    <div class="card-bd">
      <p class="muted">下列操作可验证“刷新后仍对应”：注入故障 → 重新装载（等价重启）→ 查看恢复事件与数据一致性。</p>
      <div style="display:flex;gap:9px;flex-wrap:wrap">
        <button class="btn" data-act="checkpoint">立即生成快照并压缩 WAL</button>
        <button class="btn danger" data-act="fault" data-kind="corrupt_snapshot">注入：快照损坏</button>
        <button class="btn danger" data-act="fault" data-kind="truncate_wal">注入：WAL 末尾截断</button>
        <button class="btn primary" data-act="reload">重新装载（模拟重启恢复）</button>
      </div>
    </div>
  </div>
  <div class="grid k2">
    <div class="card"><div class="card-hd"><h2>异常恢复记录</h2></div><div class="card-bd flush">
      ${V.recoveryEvents.length ? `<ul class="syslog" style="margin:0;padding:12px 18px;list-style:none">
        ${V.recoveryEvents.slice().reverse().map((e) => `<li><b>${esc(e.kind)}</b> · ${fmtTime(e.at)}<div class="muted">${esc(e.detail || '')}</div>${e.quarantined ? `<div class="muted">坏文件已隔离：${esc(e.quarantined)}</div>` : ''}</li>`).join('')}
      </ul>` : '<div class="empty">未发生过异常恢复</div>'}
    </div></div>
    <div class="card"><div class="card-hd"><h2>业务审计（最近操作）</h2></div><div class="card-bd flush">
      ${V.audit.length ? `<ul class="syslog" style="margin:0;padding:12px 18px;list-style:none;max-height:420px;overflow-y:auto">
        ${V.audit.slice(0, 80).map((a) => `<li><b>${esc(a.action)}</b> · ${fmtTime(a.at)}<div class="muted">${esc(JSON.stringify(a.detail))}</div></li>`).join('')}
      </ul>` : '<div class="empty">暂无审计记录</div>'}
    </div></div>
  </div>`;

// ---------- 全局事件 ----------
document.addEventListener('click', async (ev) => {
  const t = ev.target.closest('[data-act]');
  if (!t) return;
  const act = t.dataset.act;
  const id = t.dataset.id;
  try {
    switch (act) {
      case 'goto': ui.tab = t.dataset.tab; window.__pickVid = null; render(); break;
      case 'closeModal': closeModal(); break;
      case 'filterClause': ui.clauseFilter = t.dataset.f; render(); break;
      case 'pickRound': ui.selectedRoundId = id; render(); break;
      case 'newClause': newClauseModal(); break;
      case 'openClause': window.__pickVid = null; openClauseModal(byId(V.clauses, id)); break;
      case 'openClauseFromId': openClauseModal(byId(V.clauses, id)); break;
      case 'pickVersion': window.__pickVid = t.dataset.vid; openClauseModal(byId(V.clauses, t.dataset.cid)); break;
      case 'reviewForm': reviewForm(t.dataset.cid, t.dataset.vid, t.dataset.rid); break;
      case 'removeRef': t.remove(); break;
      case 'selCand': if (t.checked) ui.pkgSel.add(id); else ui.pkgSel.delete(id); break;
      case 'toggleAllCands': {
        if (ui.pkgSel.size === V.releaseCandidates.length) ui.pkgSel.clear();
        else V.releaseCandidates.forEach((c) => ui.pkgSel.add(c.clauseId));
        render(); break;
      }
      case 'createPkg': await doCreatePkg(); break;
      case 'handoffPkg': await doHandoff(id, t); break;
      case 'openRound': await doOpenRound(t); break;
      case 'closeRound': await doCloseRound(id); break;
      case 'newDef': defModal(); break;
      case 'editDef': defModal(byId(V.definitions, id)); break;
      case 'newRegion': await doNewRegion(); break;
      case 'newProduct': productModal(); break;
      case 'editProduct': productModal(byId(V.products, id)); break;
      case 'checkpoint': await apiPost('/api/checkpoint'); toast('快照已生成', 'ok'); break;
      case 'fault': { const j = await apiPost('/api/debug/fault', { kind: t.dataset.kind }); toast(j.hint || '故障已注入', ''); break; }
      case 'reload': { const j = await apiPost('/api/reload'); V = j.view; toast('已重新装载，恢复流程完成', 'ok'); render(); break; }
    }
  } catch (e) { toast(e.message || String(e), 'err'); }
});

// ---------- 动作实现 ----------
function newClauseModal() {
  if (!V.products.length) return toast('请先在「定义/产品/地区」中建立产品', 'err');
  modal({
    title: '新建条款',
    html: clauseFormHtml(null),
    mount: bindRefPills,
    actions: [{
      label: '创建（草稿）', cls: 'primary',
      onClick: async (bd) => {
        const data = readClauseForm(bd);
        if (!data.title) return toast('请填写标题', 'err');
        try { await api('createClause', data); toast('条款草稿已创建', 'ok'); closeModal(); render(); }
        catch (e) { toast(e.message, 'err'); }
      },
    }],
  });
}

async function doCreatePkg() {
  const ids = [...ui.pkgSel];
  if (!ids.length) return toast('请至少勾选一条可发布条款', 'err');
  const name = $('#pkgName').value.trim();
  const to = $('#pkgTo').value.trim();
  try {
    const pkg = await api('createPackage', { clauseIds: ids, name: name || undefined, handoffTo: to || undefined });
    ui.pkgSel.clear();
    toast(`发布包已组装（${pkg.items.length} 条，${pkg.rejected.length} 条被拦在隔离区）`, 'ok');
    render();
  } catch (e) { toast(e.message, 'err'); }
}
async function doHandoff(id, btn) {
  const to = prompt('移交给哪位发布同事？', '发布同事·林舟');
  if (to === null) return;
  await api('handoffPackage', { packageId: id, input: { to } });
  toast('已移交，回执号已生成', 'ok');
  render();
}
async function doOpenRound(btn) {
  const name = prompt('新一轮名称（留空自动编号）', `2026 年第 ${V.rounds.length + 1} 轮`);
  if (name === null) return;
  await api('openRound', { name: name || undefined });
  ui.selectedRoundId = V.openRoundId;
  toast('新评审轮次已开启', 'ok');
  render();
}
async function doCloseRound(id) {
  if (!confirm('关闭本轮后所有地区结论立即冻结，只能在新一轮提交新版本。确认关闭？')) return;
  await api('closeRound', { roundId: id });
  toast('轮次已关闭，结论冻结', 'ok');
  render();
}

function defModal(d) {
  modal({
    title: d ? '编辑定义' : '新增定义',
    html: `<div class="form-row"><label>定义编码 *</label><input id="defCode" value="${esc(d ? d.code : '')}" ${d ? 'disabled' : ''} placeholder="如 WAIT_PERIOD"></div>
      <div class="form-row"><label>名称</label><input id="defTitle" value="${esc(d ? d.title : '')}"></div>
      <div class="form-row"><label>定义文本</label><textarea id="defText" style="min-height:90px">${esc(d ? d.text : '')}</textarea></div>`,
    actions: [{
      label: d ? '保存' : '新增', cls: 'primary',
      onClick: async () => {
        const code = $('#defCode').value.trim(), title = $('#defTitle').value.trim(), text = $('#defText').value.trim();
        if (!code || !text) return toast('编码与文本必填', 'err');
        try {
          if (d) await api('updateDefinition', { id: d.id, patch: { title, text } });
          else await api('addDefinition', { code, title: title || code, text });
          toast('已保存', 'ok'); closeModal(); render();
        } catch (e) { toast(e.message, 'err'); }
      },
    }],
  });
}
async function doNewRegion() {
  const name = $('#newRegionName').value.trim();
  if (!name) return toast('地区名称必填', 'err');
  await api('addRegion', { name, code: $('#newRegionCode').value.trim() });
  toast('地区已新增', 'ok'); render();
}
function productModal(p) {
  modal({
    title: p ? '调整产品覆盖地区' : '新增产品',
    html: `<div class="form-row"><label>产品名称 *</label><input id="prdName" value="${esc(p ? p.name : '')}" ${p ? 'disabled' : ''}></div>
      <div class="form-row"><label>产品代码</label><input id="prdCode" value="${esc(p ? p.code : '')}" ${p ? 'disabled' : ''}></div>
      <div class="form-row"><label>覆盖地区（条款将按这些地区要求齐审）</label>
        <div class="check-pills" id="prdRegions">${V.regions.map((r) =>
          `<label class="check-pill"><input type="checkbox" value="${r.id}" style="display:none" ${p && p.regions.includes(r.id) ? 'checked' : ''}>${esc(r.name)}</label>`).join('')}</div></div>`,
    actions: [{
      label: p ? '保存覆盖' : '新增产品', cls: 'primary',
      onClick: async (bd) => {
        const rids = [...bd.querySelectorAll('#prdRegions input:checked')].map((e) => e.value);
        try {
          if (p) await api('updateProductCoverage', { id: p.id, regionIds: rids });
          else {
            const name = $('#prdName').value.trim();
            if (!name) return toast('产品名称必填', 'err');
            await api('addProduct', { name, code: $('#prdCode').value.trim(), regions: rids });
          }
          toast('已保存', 'ok'); closeModal(); render();
        } catch (e) { toast(e.message, 'err'); }
      },
    }],
  });
}

// ---------- 启动 ----------
$('#btnRefresh').onclick = () => refresh().then(() => toast('已从服务端重新加载'));
$('#btnSeed').onclick = async () => {
  if (V.clauses.length && !confirm('载入演示数据会追加到当前数据（建议空工作台使用）。继续？')) return;
  const j = await apiPost('/api/seed');
  if (j.ok) { V = j.view; toast('演示数据已载入：两轮评审、冲突、发布包与隔离区', 'ok'); render(); }
  else toast(j.error || '载入失败', 'err');
};

refresh().catch((e) => { $('#content').innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`; });
