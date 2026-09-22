/* ClauseHarbor 前端应用：视图渲染 + 动作编排（所有写操作经 Store 事务提交） */
(function () {
  'use strict';

  var store = CHStore.makeStore(localStorage, function () { return new Date().toISOString(); });

  /* ================= 基础工具 ================= */

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmt(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d)) return iso;
    return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' });
  }
  function fmtDate(iso) { return iso || '—'; }

  var REGION_NAME = CH.REGIONS;
  var REGION_ORDER = Object.keys(CH.REGIONS);

  function toast(msg, kind) {
    var t = $('#toast');
    t.textContent = msg;
    t.style.background = kind === 'error' ? 'var(--crit-text)' : 'var(--ink)';
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.hidden = true; }, 2600);
  }

  function run(label, fn, okMsg) {
    try {
      store.commit(label, fn);
      if (okMsg) toast(okMsg);
      render();
      return true;
    } catch (e) {
      console.error(e);
      toast(e.message || String(e), 'error');
      return false;
    }
  }

  /* ================= 初始化 / 主题 / 导航 ================= */

  var state = {
    view: 'overview',
    filter: 'all',
    search: '',
    drawer: null,          // {type:'clause'|'new-clause'|'definition'|'product'|'new-package'|'receipt', id}
    autosaveTimer: null
  };

  function init() {
    var booted = store.init(function () { return CHSeed.buildSeed(); });
    var notes = store.consumeRecoveryNotes();
    if (notes.length) showRecovery(notes);

    if (localStorage.getItem('ch.theme') === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    $('#btn-theme').addEventListener('click', function () {
      var dark = document.documentElement.getAttribute('data-theme') === 'dark';
      if (dark) { document.documentElement.removeAttribute('data-theme'); localStorage.setItem('ch.theme', 'light'); }
      else { document.documentElement.setAttribute('data-theme', 'dark'); localStorage.setItem('ch.theme', 'dark'); }
    });

    $('#tabs').addEventListener('click', function (e) {
      var btn = e.target.closest('.tab');
      if (!btn) return;
      state.view = btn.dataset.view;
      state.drawer = null;
      render();
    });

    document.addEventListener('click', globalClick);
    document.addEventListener('input', globalInput);
    document.addEventListener('change', globalChange);
    window.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { state.drawer = null; render(); }
    });

    $('#btn-export').addEventListener('click', doExport);
    $('#file-import').addEventListener('change', doImport);
    $('#btn-reset', document).addEventListener('click', function () {
      openConfirm('重置工作台', '将清空当前全部条款、轮次与发布包，并重新载入演示数据。确定继续？', function () {
        store.resetAll(function () { return CHSeed.buildSeed(); });
        toast('已重置为演示数据');
        state.view = 'overview'; state.drawer = null;
        render();
      });
    });

    store.onChange(function () { updateSaveIndicator(); });
    updateSaveIndicator();
    render();
  }

  function showRecovery(notes) {
    var b = $('#recovery-banner');
    b.innerHTML = '<div>⚠ 上次会话异常中断，已自动恢复：' +
      notes.map(function (n) { return '<div class="small">· ' + esc(n.text || n) + '</div>'; }).join('') +
      '</div><button class="btn tiny" id="recovery-dismiss">知道了</button>';
    b.hidden = false;
    $('#recovery-dismiss').addEventListener('click', function () { b.hidden = true; });
  }

  function updateSaveIndicator() {
    var db = store.db();
    $('#save-indicator').textContent = '最近保存 ' + fmt(db.meta.lastSavedAt) + ' · 校验 ' + store.checksum(db).slice(0, 12);
  }

  function render() {
    $all('.tab').forEach(function (t) { t.classList.toggle('active', t.dataset.view === state.view); });
    var main = $('#main');
    var views = {
      overview: viewOverview, clauses: viewClauses, definitions: viewDefinitions,
      products: viewProducts, rounds: viewRounds, release: viewRelease
    };
    main.innerHTML = views[state.view]();
    bindCurrentView();
    renderDrawer();
    updateSaveIndicator();
  }

  /* ================= 通用小组件 ================= */

  function stateBadge(st) {
    var map = {
      ready: ['ready', '可发布'], blocked: ['blocked', '隔离中'],
      draft: ['draft', '草稿'], published: ['published', '已发布']
    };
    var m = map[st.state];
    // 细分当前版本送审状态
    var extra = '';
    if (st.state === 'blocked') {
      if (st.version.status === 'returned') extra = ' · 被退回';
    }
    return '<span class="badge ' + m[0] + '"><span class="dot"></span>' + m[1] + esc(extra) + '</span>';
  }

  function versionStatusBadge(v) {
    var map = {
      draft: ['draft', '草稿'], submitted: ['submitted', '待审'],
      returned: ['returned', '已退回'], published: ['published', '已发布']
    };
    var m = map[v.status] || ['', v.status];
    return '<span class="badge ' + m[0] + '"><span class="dot"></span>' + m[1] + '</span>';
  }

  function regionDots(clause, review) {
    return '<span class="region-tags">' + clause.regions.map(function (rg) {
      var it = review.byRegion[rg];
      var cls = 'miss', txt = REGION_NAME[rg];
      if (it && (it.verdict === 'approved')) cls = 'ok';
      else if (it && it.verdict === 'waived') cls = 'ok';
      else if (it && it.verdict === 'returned') cls = 'bad';
      var title = it ? (CH.VERDICTS[it.verdict] + ' · 第' + it.roundNo + '轮 · ' + esc(it.reviewer)) : '当前轮次未评审';
      return '<span class="rg ' + cls + '" title="' + title + '">' + REGION_NAME[rg] + '</span>';
    }).join('') + '</span>';
  }

  function blockerLis(st) {
    return st.blockers.map(function (b) {
      var detail = '';
      if (b.code === 'missing-region-approval') detail = '：' + b.regions.map(function (r) { return REGION_NAME[r]; }).join('、');
      if (b.code === 'returned') detail = '：' + (b.regions || []).map(function (r) { return REGION_NAME[r]; }).join('、');
      if (b.code === 'definition-missing') detail = '：引用编号 ' + b.defIds.join(', ');
      if (b.code === 'effective-inversion') detail = '：新版 ' + b.date + ' 早于旧版 ' + b.baseDate;
      if (b.code === 'region-gap') detail = '：' + b.gaps.map(function (g) { return g.product.name + ' 缺' + REGION_NAME[g.region]; }).join('；');
      if (b.code === 'coverage-conflict') detail = '：' + b.conflicts.map(function (c) {
        return c.product.name + '「' + c.label + '」与 ' +
          c.exclude.concat(c.cover).map(function (x) { return x.clause.code; }).filter(function (v, i, a) { return a.indexOf(v) === i; }).join('、') + ' 冲突';
      }).join('；');
      if (b.code === 'definition-changed') detail = '：' + b.defs.map(function (d) {
        return '「' + d.def.term + '」更新前已通过的地区（' + d.regions.map(function (r) { return REGION_NAME[r]; }).join('、') + '）需重新表态';
      }).join('；');
      return '<li><span class="ico">⛔</span><span>' + CH.BLOCKER_LABELS[b.code] + '<span class="detail">' + esc(detail) + '</span></span></li>';
    }).join('');
  }

  function warningLis(st) {
    return st.warnings.map(function (w) {
      var detail = '';
      if (w.code === 'replacement-residue') detail = '：' + esc(w.round.name) + ' 仍在评审已被取代的 ' + w.staleVersion.revision + '，该意见只留历史、不影响当前版本';
      if (w.code === 'draft-conflict') detail = '：草稿与「' + w.conflict.otherClause.code + '」就 ' + w.conflict.label + ' 立场相反';
      if (w.code === 'post-publish-definition-change') detail = '：' + w.defs.map(function (d) {
        return '「' + d.def.term + '」更新后，' + d.regions.map(function (r) { return REGION_NAME[r]; }).join('、') + ' 的发布回执仍以封存快照为准';
      }).join('；');
      return '<li><span class="ico">⚠️</span><span>' + CH.WARNING_LABELS[w.code] + '<span class="detail">' + detail + '</span></span></li>';
    }).join('');
  }

  function coverageTags(v) {
    return (v.coverage || []).map(function (c) {
      return '<span class="cover-item ' + c.stance + '">' + (c.stance === 'cover' ? '✓ 保障' : '✕ 除外') + ' · ' + esc(c.label) + '</span>';
    }).join('') || '<span class="muted small">未声明责任范围</span>';
  }

  function refChips(db, v) {
    return (v.definitionRefs || []).map(function (did) {
      var d = CH.byId(db.definitions, did);
      if (!d) return '<span class="ref-chip broken" title="引用的定义不存在">✕ 缺失定义 ' + esc(did) + '</span>';
      return '<span class="ref-chip" title="' + esc(d.content) + '">§ ' + esc(d.term) + '</span>';
    }).join('') || '<span class="muted small">无定义引用</span>';
  }

  /* ================= 视图：总览 ================= */

  function viewOverview() {
    var db = store.db();
    var o = CH.overview(db);
    var states = CH.allClauseStates(db);
    var readyIds = states.filter(function (s) { return s.state === 'ready'; }).map(function (s) { return s.clause.id; });
    var blockedIds = states.filter(function (s) { return s.state === 'blocked'; }).map(function (s) { return s.clause.id; });
    var publishedIds = states.filter(function (s) { return s.state === 'published'; }).map(function (s) { return s.clause.id; });
    var draftIds = states.filter(function (s) { return s.version.status === 'draft'; }).map(function (s) { return s.clause.id; });

    var total = o.clauses || 1;
    var seg = function (n, cls) { return n ? '<div class="seg ' + cls + '" style="flex:' + n + '" title="' + n + '"></div>' : ''; };

    var staleDefClauses = states.filter(function (s) {
      return s.blockers.some(function (b) { return b.code === 'definition-changed'; });
    });
    var postPublishDefClauses = states.filter(function (s) {
      return s.warnings.some(function (w) { return w.code === 'post-publish-definition-change'; });
    });

    var alerts = [];
    o.conflicts.forEach(function (c) {
      alerts.push({
        kind: 'crit', html: '责任范围冲突：产品 <b>' + esc(c.product.name) + '</b> 中「' + esc(c.label) + '」同时存在保障与除外 —— ' +
          c.cover.map(function (x) { return x.clause.code; }).join('、') + ' vs ' +
          c.exclude.map(function (x) { return x.clause.code; }).join('、')
      });
    });
    o.residues.forEach(function (r) {
      alerts.push({
        kind: 'warn', html: '替换残留：<b>' + r.clause.code + '</b> 的 ' + r.staleVersion.revision + ' 已被新版本取代，但「' +
          esc(r.round.name) + '」里 ' + REGION_NAME[r.item.region] + ' 的意见仍挂在旧版上（只留历史，不影响当前结论）'
      });
    });
    staleDefClauses.forEach(function (s) {
      alerts.push({ kind: 'warn', html: '<b>' + s.clause.code + '</b> 引用的定义在最近通过后被更新，当前结论需在新一轮复审' });
    });
    postPublishDefClauses.forEach(function (s) {
      alerts.push({ kind: 'warn', html: '<b>' + s.clause.code + '</b> 已发布版本引用的定义在发布后更新（回执仍有效，下一发布包需对齐）' });
    });
    db.packages.filter(function (p) { return p.status === 'sealed'; }).forEach(function (p) {
      var stale = CH.stalePackageEntries(db, p);
      if (stale.length) alerts.push({
        kind: 'crit', html: '待发布包 <b>' + esc(p.name) + '</b> 含有已被替换/依赖变更的旧版本条目，必须解散重组后才能发布'
      });
    });

    var kpi = function (cls, val, label, hint, go) {
      return '<div class="card kpi accent-' + cls + '" data-go="' + go + '" style="cursor:pointer">' +
        '<div class="kpi-value num">' + val + '</div><div class="kpi-label">' + label + '</div>' +
        (hint ? '<div class="kpi-hint">' + hint + '</div>' : '') + '</div>';
    };

    return '' +
      '<div class="view-head"><div>' +
        '<h1 class="view-title">审核交付总览</h1>' +
        '<p class="view-desc">结论只认当前版本 + 最新轮次；旧轮次意见保留为历史，退回/补交/替换一律产生新版本。</p>' +
      '</div>' +
      '<div class="inline-actions">' +
        (o.openRound
          ? '<span class="badge submitted"><span class="dot"></span>进行中：' + esc(o.openRound.name) + '</span><button class="btn" data-act="close-round" data-id="' + o.openRound.id + '">关闭本轮</button>'
          : '<button class="btn primary" data-act="new-round">开启新一轮评审</button>') +
      '</div></div>' +

      '<div class="grid cols-4">' +
        kpi('blue', o.clauses, '在管条款', o.drafts + ' 个处于草稿', 'clauses') +
        kpi('good', o.ready, '生效准备就绪', '可直接进入发布包', 'clauses:ready') +
        kpi('crit', o.blocked, '隔离区条款', '未通过或缺依赖', 'release') +
        kpi('violet', o.published, '已发布版本', o.packagesReleased + ' 个回执在手', 'release') +
      '</div>' +

      '<div class="card section-gap">' +
        '<div class="card-title">条款准备度分布 <span class="sub">按当前版本的实时结论计算</span></div>' +
        '<div class="segbar">' + seg(o.ready, 'ready') + seg(o.blocked, 'blocked') +
          seg(states.filter(function(s){return s.state!=='published'&&s.version.status==='draft';}).length, 'draft') +
          seg(o.published, 'published') + '</div>' +
        '<div class="seg-legend">' +
          '<span><span class="dot" style="background:var(--good)"></span>就绪 ' + o.ready + '</span>' +
          '<span><span class="dot" style="background:var(--crit)"></span>隔离 ' + o.blocked + '</span>' +
          '<span><span class="dot" style="background:var(--warn-dot)"></span>草稿 ' + draftIds.length + '</span>' +
          '<span><span class="dot" style="background:var(--violet)"></span>已发布 ' + o.published + '</span>' +
        '</div>' +
      '</div>' +

      (alerts.length ? '<div class="grid cols-2 section-gap">' + alerts.map(function (a) {
        return '<div class="alert ' + a.kind + '"><span>' + (a.kind === 'crit' ? '⛔' : '⚠️') + '</span><div>' + a.html + '</div></div>';
      }).join('') + '</div>' : '<div class="alert info section-gap">✅ 定义引用、责任范围与生效日期之间没有检测到互相打架。</div>') +

      '<div class="grid cols-2 section-gap">' +
        '<div class="card"><div class="card-title">隔离区清单 <span class="sub">未通过或缺依赖，不能进入发布包</span></div>' +
          quarantineMini() +
        '</div>' +
        '<div class="card"><div class="card-title">最近操作留痕 <span class="sub">刷新后仍可追溯</span></div>' + auditTail() + '</div>' +
      '</div>';
  }

  function quarantineMini(ids) {
    var db = store.db();
    var list = CH.quarantine(db);
    if (!list.length) return '<div class="empty">隔离区为空</div>';
    return '<div class="table-wrap"><table class="data"><tbody>' + list.map(function (q) {
      return '<tr class="clickable" data-open-clause="' + q.state.clause.id + '"><td style="min-width:130px"><div class="cell-title">' +
        esc(q.state.clause.code) + '</div><div class="cell-sub">' + q.state.version.revision + '</div></td>' +
        '<td><ul class="reason-list blockers">' + q.reasons.map(function (r) {
          return '<li><span class="ico">⛔</span>' + esc(r.label) + '</li>';
        }).join('') + '</ul></td></tr>';
    }).join('') + '</tbody></table></div>';
  }

  function auditTail(limit) {
    var db = store.db();
    var rows = db.audit.slice(-(limit || 12)).reverse();
    if (!rows.length) return '<div class="empty">暂无操作</div>';
    return '<div class="audit-list">' + rows.map(function (a) {
      return '<div class="audit-item"><span class="audit-time">' + fmt(a.at) + '</span>' +
        '<span><b>' + esc(a.actor) + '</b> · ' + esc(a.detail) + '</span></div>';
    }).join('') + '</div>';
  }

  /* ================= 视图：条款库 ================= */

  function viewClauses() {
    var db = store.db();
    var states = CH.allClauseStates(db);
    var f = state.filter, q = state.search.trim().toLowerCase();
    var filtered = states.filter(function (s) {
      if (f === 'ready' && s.state !== 'ready') return false;
      if (f === 'blocked' && s.state !== 'blocked') return false;
      if (f === 'published' && s.state !== 'published') return false;
      if (f === 'draft' && s.version.status !== 'draft') return false;
      if (q && (s.clause.code + ' ' + s.clause.title + ' ' + s.version.content).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var chip = function (key, n, label) {
      return '<button class="chip ' + (f === key ? 'on' : '') + '" data-filter="' + key + '">' + label + ' · ' + n + '</button>';
    };
    var counts = {
      all: states.length,
      ready: states.filter(function (s) { return s.state === 'ready'; }).length,
      blocked: states.filter(function (s) { return s.state === 'blocked'; }).length,
      draft: states.filter(function (s) { return s.version.status === 'draft'; }).length,
      published: states.filter(function (s) { return s.state === 'published'; }).length
    };

    return '<div class="view-head"><div><h1 class="view-title">条款库</h1>' +
      '<p class="view-desc">点击条款查看版本谱系、各轮次意见与影响产品；草稿可自动暂存并手动保存。</p></div>' +
      '<button class="btn primary" data-act="new-clause">＋ 新建条款</button></div>' +
      '<div class="filterbar">' +
        chip('all', counts.all, '全部') + chip('ready', counts.ready, '就绪') +
        chip('blocked', counts.blocked, '隔离中') + chip('draft', counts.draft, '草稿') +
        chip('published', counts.published, '已发布') +
        '<input class="search-input" id="clause-search" placeholder="搜索编号 / 标题 / 正文" value="' + esc(state.search) + '">' +
      '</div>' +
      '<div class="card tight"><div class="table-wrap"><table class="data"><thead><tr>' +
        '<th>条款</th><th>当前版本</th><th>地区结论（最新轮次）</th><th>影响产品</th><th>准备度 / 阻断原因</th><th></th>' +
      '</tr></thead><tbody>' +
      filtered.map(function (s) {
        return '<tr class="clickable" data-open-clause="' + s.clause.id + '">' +
          '<td style="min-width:210px"><div class="cell-title">' + esc(s.clause.title) + '</div>' +
            '<div class="code-mono">' + esc(s.clause.code) + '</div></td>' +
          '<td><div>' + s.version.revision + '（' + ({initial: '初版', resubmit: '补交', replacement: '替换'}[s.version.kind]) + '）</div>' +
            '<div class="cell-sub">生效 ' + fmtDate(s.version.effectiveDate) + '</div></td>' +
          '<td>' + regionDots(s.clause, s.review) + '</td>' +
          '<td>' + s.products.map(function (p) { return '<div class="small">' + esc(p.name) + '</div>'; }).join('') || '<span class="muted small">未关联产品</span>' + '</td>' +
          '<td style="min-width:200px">' + stateBadge(s) +
            (s.blockers.length ? '<ul class="reason-list blockers" style="margin-top:5px">' + blockerLis(s) + '</ul>' : '') +
            (s.warnings.length ? '<ul class="reason-list warnings">' + warningLis(s) + '</ul>' : '') + '</td>' +
          '<td class="num muted">v' + s.clause.versions.length + '</td>' +
        '</tr>';
      }).join('') + '</tbody></table>' + (filtered.length ? '' : '<div class="empty">没有匹配的条款</div>') + '</div></div>';
  }

  /* ================= 条款抽屉 ================= */

  function clauseDrawer(clauseId, isNew) {
    var db = store.db();
    if (isNew) return newClauseForm();
    var clause = CH.byId(db.clauses, clauseId);
    if (!clause) return '';
    var st = CH.computeClauseState(db, clause);
    var v = st.version;
    var formDraft = store.getFormDraft(clause.id);
    var showRestore = v.status === 'draft' && formDraft && formDraft.savedAt > v.createdAt;

    var refOptions = db.definitions.map(function (d) {
      return '<label class="checkbox-pill"><input type="checkbox" data-field="defref" value="' + d.id + '"' +
        (v.definitionRefs.indexOf(d.id) >= 0 ? ' checked' : '') + (editable ? '' : ' disabled') + '>§ ' + esc(d.term) + '</label>';
    }).join('');

    var regionChecks = REGION_ORDER.map(function (rg) {
      return '<label class="checkbox-pill"><input type="checkbox" data-field="region" value="' + rg + '"' +
        (clause.regions.indexOf(rg) >= 0 ? ' checked' : '') + '>' + REGION_NAME[rg] + '</label>';
    }).join('');

    var productChecks = db.products.map(function (p) {
      return '<label class="checkbox-pill"><input type="checkbox" data-field="product" value="' + p.id + '"' +
        (clause.productIds.indexOf(p.id) >= 0 ? ' checked' : '') + '>' + esc(p.name) + '</label>';
    }).join('');

    var editable = v.status === 'draft';

    return '' +
      '<div class="drawer-head"><div>' +
        '<h2 class="drawer-title">' + esc(clause.code) + ' · ' + esc(v.title) + '</h2>' +
        '<p class="drawer-sub">负责人 ' + esc(clause.owner) + ' ｜ 当前 ' + v.revision + '（' + ({initial: '初版', resubmit: '补交', replacement: '替换'}[v.kind]) + '）｜ ' + versionStatusBadge(v) +
          (v.replacesVersionId ? ' ｜ 取代 ' + CH.byId(clause.versions, v.replacesVersionId).revision : '') + '</p>' +
      '</div><button class="icon-btn" data-act="close-drawer" title="关闭">✕</button></div>' +

      (showRestore ? '<div class="alert warn section-gap"><span>📝</span><div>有自动暂存的表单草稿（' + fmt(formDraft.savedAt) + '）尚未写入。' +
        '<div class="inline-actions" style="margin-top:6px"><button class="btn tiny primary" data-act="restore-form-draft" data-id="' + clause.id + '">恢复到表单</button>' +
        '<button class="btn tiny" data-act="discard-form-draft" data-id="' + clause.id + '">丢弃暂存</button></div></div></div>' : '') +

      '<div class="card section-gap"><div class="row-between"><div class="card-title" style="margin:0">编辑区</div>' +
        (editable
          ? '<div class="inline-actions"><span class="autosave-line" id="autosave-line"></span>' +
            '<button class="btn" data-act="withdraw" data-id="' + clause.id + '" ' +
              (v.status !== 'submitted' ? 'disabled' : '') + '>撤回送审</button>' +
            '<button class="btn primary" data-act="save-draft" data-id="' + clause.id + '">保存草稿</button>' +
            '<button class="btn primary" data-act="submit" data-id="' + clause.id + '">送审</button></div>'
          : '<div class="inline-actions">' +
            '<button class="btn" data-act="followup" data-id="' + clause.id + '" data-kind="resubmit">退回后补交（新版本）</button>' +
            '<button class="btn" data-act="followup" data-id="' + clause.id + '" data-kind="replacement">替换为新版本</button></div>') +
      '</div>' +
      '<div class="field-row"><div class="field"><label>条款标题</label><input data-field="title" value="' + esc(v.title) + '"' + (editable ? '' : ' disabled') + '></div>' +
        '<div class="field" style="max-width:170px"><label>生效日期</label><input type="date" data-field="effectiveDate" value="' + esc(v.effectiveDate || '') + '"' + (editable ? '' : ' disabled') + '></div></div>' +
      '<div class="field-row"><div class="field"><label>适用地区</label><div class="checkbox-row">' + regionChecks + '</div></div></div>' +
      '<div class="field"><label>影响产品（改动将自动同步产品侧关联）</label><div class="checkbox-row">' + productChecks + '</div></div>' +
      '<div class="field"><label>引用定义</label><div class="checkbox-row">' + refOptions + '</div></div>' +
      '<div class="field"><label>责任范围（保障 / 除外立场相反应先消解）</label>' +
        '<div id="coverage-editor">' + coverageEditorRows(v, editable) + '</div>' +
        (editable ? '<button class="btn tiny" data-act="add-coverage" data-id="' + clause.id + '" style="margin-top:6px">＋ 增加责任项</button>' : '') +
      '</div>' +
      '<div class="field"><label>条款正文</label><textarea data-field="content" rows="6"' + (editable ? '' : ' disabled') + '>' + esc(v.content) + '</textarea></div>' +
      '</div>' +

      // 当前结论
      '<div class="card section-gap"><div class="card-title">当前结论 <span class="sub">只统计当前版本在最新轮次的意见</span></div>' +
        '<div style="margin-bottom:8px">' + stateBadge(st) + ' ' + regionDots(clause, st.review) + '</div>' +
        (st.blockers.length ? '<ul class="reason-list blockers">' + blockerLis(st) + '</ul>' : '<div class="small" style="color:var(--good-text)">✓ 无阻断项</div>') +
        (st.warnings.length ? '<ul class="reason-list warnings" style="margin-top:6px">' + warningLis(st) + '</ul>' : '') +
        reviewEditor(st) +
      '</div>' +

      // 引用定义快照
      '<div class="card section-gap"><div class="card-title">引用定义</div>' + refChips(db, v) +
        '<div class="small muted" style="margin-top:6px">定义内容在条款通过之后更新的，通过结论自动失效，需在新一轮复审。</div></div>' +

      // 版本时间线 + 各轮历史意见
      '<div class="card section-gap"><div class="card-title">版本谱系与历轮意见 <span class="sub">旧版本 / 旧轮次意见永久留痕，但不参与当前结论</span></div>' +
        '<div class="timeline">' + clause.versions.map(function (vv) {
          var isCurrent = vv.id === v.id;
          var items = CH.collectItems(db, clause.id, vv.id);
          return '<div class="tl-item ' + (isCurrent ? 'current' : vv.status === 'published' ? 'published' : '') + '">' +
            '<div class="tl-ver">' + vv.revision +
              '<span class="tl-kind">' + ({initial: '初版', resubmit: '补交版', replacement: '替换版'}[vv.kind]) + '</span>' +
              (isCurrent ? '<span class="badge draft"><span class="dot"></span>当前版本</span>' : '<span class="hist-tag">历史版本</span>') +
              ' ' + versionStatusBadge(vv) +
            '</div>' +
            '<div class="tl-meta">生效 ' + fmtDate(vv.effectiveDate) + ' ｜ 创建 ' + fmt(vv.createdAt) +
              (vv.replacesVersionId ? ' ｜ 取代 ' + CH.byId(clause.versions, vv.replacesVersionId).revision : '') + '</div>' +
            '<div class="tl-body">' + esc(vv.content) + '</div>' +
            (items.length ? roundGroupedItems(items, !isCurrent) : '<div class="small muted">该版本无评审意见</div>') +
          '</div>';
        }).join('') + '</div>' +
      '</div>' +

      // 影响产品 + 发布记录
      '<div class="grid cols-2 section-gap">' +
        '<div class="card"><div class="card-title">影响产品</div>' +
          (st.products.length ? st.products.map(function (p) {
            var gap = CH.difference(p.regions, clause.regions);
            return '<div class="pkg-entry"><div class="pe-head"><b>' + esc(p.name) + '</b>' +
              '<span class="code-mono">' + esc(p.code) + '</span></div>' +
              '<div class="small muted">上线 ' + p.regions.map(function (r) { return REGION_NAME[r]; }).join('、') + '</div>' +
              (gap.length ? '<div class="small" style="color:var(--crit-text)">⛔ 条款未覆盖：' + gap.map(function (r) { return REGION_NAME[r]; }).join('、') + '</div>' :
                '<div class="small" style="color:var(--good-text)">✓ 地区覆盖一致</div>') + '</div>';
          }).join('') : '<div class="empty">尚未关联产品</div>') +
        '</div>' +
        '<div class="card"><div class="card-title">发布记录</div>' +
          (st.publishedIn.length ? st.publishedIn.map(function (x) {
            var same = x.versionId === v.id;
            return '<div class="pkg-entry"><div class="pe-head"><b>' + esc(x.package.name) + '</b>' +
              (same ? '<span class="badge published"><span class="dot"></span>同版本</span>' : '<span class="badge returned"><span class="dot"></span>发布的是旧版</span>') + '</div>' +
              '<div class="small muted">回执 ' + (x.package.receipt ? x.package.receipt.fingerprint : '待发布') + '</div></div>';
          }).join('') : '<div class="empty">该条款尚未进入发布包</div>') +
        '</div>' +
      '</div>';
  }

  function coverageEditorRows(v, editable) {
    return (v.coverage || []).map(function (c, i) {
      return '<div class="field-row" data-cov-row="' + i + '">' +
        '<div class="field" style="margin:0"><input data-cov-label="' + i + '" value="' + esc(c.label) + '"' + (editable ? '' : ' disabled') + '></div>' +
        '<div class="field" style="margin:0;max-width:120px"><select data-cov-stance="' + i + '"' + (editable ? '' : ' disabled') + '>' +
          '<option value="cover"' + (c.stance === 'cover' ? ' selected' : '') + '>✓ 保障</option>' +
          '<option value="exclude"' + (c.stance === 'exclude' ? ' selected' : '') + '>✕ 除外</option></select></div>' +
        (editable ? '<button class="btn tiny danger-ghost" data-act="del-coverage" data-idx="' + i + '">删</button>' : '<span style="width:34px"></span>') +
      '</div>';
    }).join('');
  }

  function roundGroupedItems(items, historical) {
    var byRound = {};
    items.forEach(function (it) { (byRound[it.roundNo] = byRound[it.roundNo] || { name: it.roundName, items: [] }).items.push(it); });
    return Object.keys(byRound).sort(function (a, b) { return b - a; }).map(function (no) {
      var g = byRound[no];
      return '<div class="review-round ' + (historical ? 'old' : '') + '"><div class="rr-head">' +
        '<span class="rr-name">' + esc(g.name) + (historical ? ' <span class="hist-tag">历史结论 · 不覆盖当前版本</span>' : '') + '</span></div>' +
        g.items.map(function (it) {
          var vcls = it.verdict === 'approved' ? 'ok' : it.verdict === 'returned' ? 'bad' : '';
          return '<div class="review-item"><span class="ri-who"><span class="rg ' +
            (it.verdict === 'approved' ? 'ok' : it.verdict === 'returned' ? 'bad' : 'miss') + '">' + REGION_NAME[it.region] + '</span>' +
            ' <b class="' + (vcls ? 'cover-item ' + (it.verdict === 'approved' ? 'cover' : 'exclude') : '') + '">' + CH.VERDICTS[it.verdict] + '</b></span>' +
            '<span class="ri-comment">' + esc(it.comment || '（无意见）') +
              '<div class="ri-time">' + esc(it.reviewer) + ' · ' + fmt(it.at) + (it.revised ? ' · 已修订 ' + it.revised + ' 次' : '') + '</div></span></div>';
        }).join('') + '</div>';
    }).join('');
  }

  function reviewEditor(st) {
    var db = store.db();
    var round = CH.openRound(db);
    if (st.version.status === 'published') {
      if (!round) return '<div class="small muted" style="margin-top:8px">版本已发布，评审记录已封入回执；新一轮开启后可登记备案意见。</div>';
      return verdictForm(st, round, { archived: true });
    }
    if (!round) return '<div class="small muted" style="margin-top:8px">当前没有进行中的轮次；开启新一轮后可登记地区意见。</div>';
    if (st.version.status === 'draft') return '<div class="small muted" style="margin-top:8px">草稿送审后，才能在「' + esc(round.name) + '」登记意见。</div>';
    return verdictForm(st, round, {});
  }

  function verdictForm(st, round, opts) {
    return '<div class="review-round" style="margin-top:10px"><div class="rr-head"><span class="rr-name">' + esc(round.name) +
      (opts.archived ? ' · 已发布版本备案登记（回执不变）' : ' · 登记地区意见') + '</span>' +
      '<span class="small muted">意见挂在当前版本 ' + st.version.revision + '</span></div>' +
      '<div id="verdict-form" data-clause="' + st.clause.id + '" data-version="' + st.version.id + '">' +
      '<div class="field-row"><div class="field" style="max-width:130px;margin:6px 0 0"><label>地区</label><select data-vf="region">' +
      REGION_ORDER.filter(function (rg) { return st.clause.regions.indexOf(rg) >= 0; }).map(function (rg) {
        return '<option value="' + rg + '">' + REGION_NAME[rg] + '</option>';
      }).join('') + '</select></div>' +
      '<div class="field" style="margin:6px 0 0"><label>审核人</label><input data-vf="reviewer" placeholder="如：湖北 · 郑岩"></div></div>' +
      '<div class="field"><label>意见</label><textarea data-vf="comment" rows="2" placeholder="' + (opts.archived ? '备案说明（如：地方备案文号已取得）' : '退回原因 / 通过备注') + '"></textarea></div>' +
      '<div class="verdict-bar">' +
        '<button class="vbtn ok" data-act="verdict" data-v="approved">✓ 通过</button>' +
        (opts.archived ? '' : '<button class="vbtn bad" data-act="verdict" data-v="returned">⛔ 退回</button>') +
        '<button class="vbtn" data-act="verdict" data-v="waived">弃权/免审</button>' +
        '<span class="small muted" style="align-self:center">' +
          (opts.archived ? '备案意见留档但不改变发布状态与回执' : '同地区同轮重复登记会更新原意见并留修订次数') +
        '</span></div>' +
      '</div></div>';
  }

  function newClauseForm() {
    var db = store.db();
    return '<div class="drawer-head"><div><h2 class="drawer-title">新建条款</h2>' +
      '<p class="drawer-sub">新建后是草稿，可随时保存、送审或撤回。</p></div>' +
      '<button class="icon-btn" data-act="close-drawer">✕</button></div>' +
      '<div class="card section-gap">' +
      '<div class="field-row"><div class="field"><label>编号</label><input id="nc-code" placeholder="CL-XXX-00"></div>' +
        '<div class="field"><label>负责人</label><input id="nc-owner" value="产品法务"></div></div>' +
      '<div class="field"><label>标题</label><input id="nc-title"></div>' +
      '<div class="field"><label>适用地区</label><div class="checkbox-row">' + REGION_ORDER.map(function (rg) {
        return '<label class="checkbox-pill"><input type="checkbox" data-nc-region value="' + rg + '">' + REGION_NAME[rg] + '</label>';
      }).join('') + '</div></div>' +
      '<div class="field"><label>关联产品</label><div class="checkbox-row">' + db.products.map(function (p) {
        return '<label class="checkbox-pill"><input type="checkbox" data-nc-product value="' + p.id + '">' + esc(p.name) + '</label>';
      }).join('') + '</div></div>' +
      '<div class="field"><label>引用定义</label><div class="checkbox-row">' + db.definitions.map(function (d) {
        return '<label class="checkbox-pill"><input type="checkbox" data-nc-defref value="' + d.id + '">§ ' + esc(d.term) + '</label>';
      }).join('') + '</div></div>' +
      '<div class="field-row"><div class="field"><label>生效日期</label><input type="date" id="nc-date"></div></div>' +
      '<div class="field"><label>条款正文</label><textarea id="nc-content" rows="5"></textarea></div>' +
      '<button class="btn primary" data-act="create-clause">创建草稿</button></div>';
  }

  /* ================= 视图：定义与引用 ================= */

  function viewDefinitions() {
    var db = store.db();
    var rows = db.definitions.map(function (d) {
      var refs = db.clauses.map(function (c) {
        var v = CH.byId(c.versions, c.currentVersionId);
        return (v.definitionRefs || []).indexOf(d.id) >= 0 ? { c: c, v: v } : null;
      }).filter(Boolean);
      var staleRefs = refs.filter(function (r) {
        var st = CH.computeClauseState(db, r.c);
        return st.blockers.some(function (b) { return b.code === 'definition-changed' && b.defs.some(function (x) { return x.def.id === d.id; }); });
      });
      return '<tr class="clickable" data-open-definition="' + d.id + '"><td><div class="cell-title">§ ' + esc(d.term) + '</div>' +
        '<div class="cell-sub">更新于 ' + fmt(d.updatedAt) + '</div></td>' +
        '<td style="max-width:420px">' + esc(d.content) + '</td>' +
        '<td>' + refs.map(function (r) {
          var stale = staleRefs.some(function (x) { return x.c.id === r.c.id; });
          return '<span class="ref-chip ' + (stale ? 'stale' : '') + '" title="' + (stale ? '该条款通过后定义已变更，需复审' : '') + '">' +
            esc(r.c.code) + ' ' + r.v.revision + (stale ? ' ⟳' : '') + '</span>';
        }).join('') || '<span class="muted small">无引用</span>' + '</td></tr>';
    }).join('');
    return '<div class="view-head"><div><h1 class="view-title">定义与引用</h1>' +
      '<p class="view-desc">定义一经更新，所有「通过在先、变更在后」的条款自动标记需复审；发布包封存后的定义变更会阻断发布。</p></div>' +
      '<button class="btn primary" data-act="new-definition">＋ 新建定义</button></div>' +
      '<div class="card tight"><div class="table-wrap"><table class="data"><thead><tr><th>术语</th><th>释义</th><th>被当前版本引用</th></tr></thead><tbody>' +
      rows + '</tbody></table></div></div>';
  }

  function definitionDrawer(id, isNew) {
    var db = store.db();
    var d = isNew ? null : CH.byId(db.definitions, id);
    var affected = d ? db.clauses.filter(function (c) {
      var v = CH.byId(c.versions, c.currentVersionId);
      return (v.definitionRefs || []).indexOf(d.id) >= 0 && ['submitted', 'published'].indexOf(v.status) >= 0;
    }) : [];
    return '<div class="drawer-head"><div><h2 class="drawer-title">' + (d ? '编辑定义' : '新建定义') + '</h2>' +
      (d ? '<p class="drawer-sub code-mono">' + d.id + ' ｜ 创建 ' + fmt(d.createdAt) + ' ｜ 更新 ' + fmt(d.updatedAt) + '</p>' : '') +
      '</div><button class="icon-btn" data-act="close-drawer">✕</button></div>' +
      '<div class="card section-gap">' +
      '<div class="field"><label>术语</label><input id="def-term" value="' + (d ? esc(d.term) : '') + '"></div>' +
      '<div class="field"><label>释义内容</label><textarea id="def-content" rows="6">' + (d ? esc(d.content) : '') + '</textarea></div>' +
      (affected.length ? '<div class="alert warn" style="margin-bottom:10px"><span>⟳</span><div>保存后，引用该定义的待审/已通过条款若在定义更新前取得地区结论，将被要求重新表态；已发布版本的回执保持有效，仅提示下一发布包对齐。涉及条款：<br>' +
        affected.map(function (c) { return '<b>' + esc(c.code) + '</b>'; }).join('、') + '</div></div>' : '') +
      '<div class="inline-actions"><button class="btn primary" data-act="' + (d ? 'save-definition' : 'create-definition') + '"' + (d ? ' data-id="' + d.id + '"' : '') + '>保存定义</button>' +
      '<button class="btn" data-act="close-drawer">取消</button></div></div>';
  }

  /* ================= 视图：产品与地区 ================= */

  function viewProducts() {
    var db = store.db();
    var states = CH.allClauseStates(db);
    var stByClause = {}; states.forEach(function (s) { stByClause[s.clause.id] = s; });

    var matrix = '<table class="matrix"><thead><tr><th class="rowhead">条款 ＼ 地区</th>' +
      REGION_ORDER.map(function (rg) { return '<th>' + REGION_NAME[rg] + '</th>'; }).join('') + '<th>影响产品</th></tr></thead><tbody>' +
      states.map(function (s) {
        return '<tr class="clickable" data-open-clause="' + s.clause.id + '"><td class="rowhead"><div class="cell-title">' + esc(s.clause.code) + '</div>' +
          '<div class="cell-sub">' + s.version.revision + '</div></td>' +
          REGION_ORDER.map(function (rg) {
            var inClause = s.clause.regions.indexOf(rg) >= 0;
            if (!inClause) {
              var needed = s.products.some(function (p) { return p.regions.indexOf(rg) >= 0; });
              return '<td class="cell ' + (needed ? 'gap' : 'dash') + '">' + (needed ? '缺' : '·') + '</td>';
            }
            var it = s.review.byRegion[rg];
            if (it && (it.verdict === 'approved' || it.verdict === 'waived')) return '<td class="cell y">✓</td>';
            if (it && it.verdict === 'returned') return '<td class="cell n">退</td>';
            return '<td class="cell gap">待</td>';
          }).join('') +
          '<td class="rowhead small">' + s.products.map(function (p) { return esc(p.name); }).join('<br>') + '</td></tr>';
      }).join('') + '</tbody></table>';

    var cards = db.products.map(function (p) {
      var linked = (p.clauseIds || []).map(function (cid) { return CH.byId(db.clauses, cid); }).filter(Boolean);
      return '<div class="card tight"><div class="row-between"><div><b>' + esc(p.name) + '</b> <span class="code-mono">' + esc(p.code) + '</span></div>' +
        '<button class="btn tiny" data-act="edit-product" data-id="' + p.id + '">编辑</button></div>' +
        '<div class="region-tags" style="margin:6px 0">' + p.regions.map(function (rg) { return '<span class="rg">' + REGION_NAME[rg] + '</span>'; }).join('') + '</div>' +
        '<div class="small muted">关联条款 ' + linked.length + ' 条：' +
        linked.map(function (c) {
          var gap = CH.difference(p.regions, c.regions);
          return '<span class="ref-chip ' + (gap.length ? 'stale' : '') + '">' + esc(c.code) + (gap.length ? ' 缺' + gap.map(function (r) { return REGION_NAME[r]; }).join('/') : '') + '</span>';
        }).join('') + '</div></div>';
    }).join('');

    return '<div class="view-head"><div><h1 class="view-title">产品与地区覆盖</h1>' +
      '<p class="view-desc">矩阵中「缺」= 产品上线但条款未覆盖该地区；「待」= 已覆盖但当前轮次未通过；「退」= 当前轮次被退回。</p></div>' +
      '<button class="btn primary" data-act="new-product">＋ 新建产品</button></div>' +
      '<div class="card tight" style="margin-bottom:14px"><div class="card-title">条款 × 地区 审核矩阵</div><div class="table-wrap">' + matrix + '</div>' +
      '<div class="legend-inline"><span><span class="cell y" style="display:inline-table;vertical-align:middle">✓</span> 当前轮次通过</span>' +
      '<span><span class="cell n" style="display:inline-table;vertical-align:middle">退</span> 退回</span>' +
      '<span><span class="cell gap" style="display:inline-table;vertical-align:middle">待/缺</span> 待审或地区缺口</span>' +
      '<span><span class="cell dash" style="display:inline-table;vertical-align:middle">·</span> 不适用</span></div></div>' +
      '<div class="grid cols-3">' + cards + '</div>';
  }

  function productDrawer(id, isNew) {
    var db = store.db();
    var p = isNew ? null : CH.byId(db.products, id);
    return '<div class="drawer-head"><div><h2 class="drawer-title">' + (p ? '编辑产品' : '新建产品') + '</h2></div>' +
      '<button class="icon-btn" data-act="close-drawer">✕</button></div>' +
      '<div class="card section-gap">' +
      '<div class="field-row"><div class="field"><label>产品名称</label><input id="pr-name" value="' + (p ? esc(p.name) : '') + '"></div>' +
        '<div class="field" style="max-width:150px"><label>产品代码</label><input id="pr-code" value="' + (p ? esc(p.code || '') : '') + '"></div></div>' +
      '<div class="field"><label>上线地区</label><div class="checkbox-row">' + REGION_ORDER.map(function (rg) {
        return '<label class="checkbox-pill"><input type="checkbox" data-pr-region value="' + rg + '"' + (p && p.regions.indexOf(rg) >= 0 ? ' checked' : '') + '>' + REGION_NAME[rg] + '</label>';
      }).join('') + '</div></div>' +
      '<div class="field"><label>关联条款（双向同步）</label><div class="checkbox-row">' + db.clauses.map(function (c) {
        return '<label class="checkbox-pill"><input type="checkbox" data-pr-clause value="' + c.id + '"' + (p && (p.clauseIds || []).indexOf(c.id) >= 0 ? ' checked' : '') + '>' + esc(c.code) + ' ' + esc(c.title) + '</label>';
      }).join('') + '</div></div>' +
      '<button class="btn primary" data-act="' + (p ? 'save-product' : 'create-product') + '"' + (p ? ' data-id="' + p.id + '"' : '') + '>保存</button></div>';
  }

  /* ================= 视图：评审轮次 ================= */

  function viewRounds() {
    var db = store.db();
    var open = CH.openRound(db);
    var cards = db.rounds.slice().reverse().map(function (r) {
      return '<div class="card"><div class="row-between"><div class="card-title" style="margin:0">' + esc(r.name) +
        ' ' + (r.closedAt ? '<span class="hist-tag">已关闭 ' + fmt(r.closedAt) + '</span>' : '<span class="badge submitted"><span class="dot"></span>进行中</span>') +
        '</div><span class="small muted">第 ' + r.no + ' 轮 · ' + r.items.length + ' 条意见 · 开启 ' + fmt(r.openedAt) + '</span></div>' +
        roundItemsTable(r) + '</div>';
    }).join('');
    return '<div class="view-head"><div><h1 class="view-title">评审轮次</h1>' +
      '<p class="view-desc">同一时间只能有一个进行中的轮次；意见必须落在条款的当前版本上，登记旧版本会被拒绝并提示。</p></div>' +
      (open ? '<button class="btn" data-act="close-round" data-id="' + open.id + '">关闭当前轮次</button>'
            : '<button class="btn primary" data-act="new-round">开启新一轮</button>') + '</div>' +
      '<div class="stack">' + cards + '</div>';
  }

  function roundItemsTable(r) {
    var db = store.db();
    if (!r.items.length) return '<div class="empty">暂无意见</div>';
    return '<div class="table-wrap" style="margin-top:8px"><table class="data"><thead><tr>' +
      '<th>条款 / 版本</th><th>地区</th><th>结论</th><th>意见</th><th>审核人</th><th>时间</th></tr></thead><tbody>' +
      r.items.slice().sort(function (a, b) { return a.clauseId.localeCompare(b.clauseId) || a.region.localeCompare(b.region); }).map(function (it) {
        var c = CH.byId(db.clauses, it.clauseId);
        var v = CH.byId(c.versions, it.versionId);
        var stale = v.id !== c.currentVersionId;
        return '<tr class="clickable" data-open-clause="' + c.id + '"><td><b>' + esc(c.code) + '</b> ' + v.revision +
          (stale ? ' <span class="hist-tag" title="登记时的版本已被取代，该意见只留历史">旧版 · 历史留痕</span>' : ' <span class="badge submitted"><span class="dot"></span>当前</span>') +
          '</td><td>' + REGION_NAME[it.region] + '</td>' +
          '<td><span class="cover-item ' + (it.verdict === 'approved' ? 'cover' : it.verdict === 'returned' ? 'exclude' : '') + '">' + CH.VERDICTS[it.verdict] + '</span></td>' +
          '<td style="max-width:320px">' + esc(it.comment || '—') + '</td><td class="small">' + esc(it.reviewer) + '</td>' +
          '<td class="small num">' + fmt(it.at) + (it.revised ? ' <span class="hist-tag">改' + it.revised + '</span>' : '') + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  /* ================= 视图：发布与隔离 ================= */

  function viewRelease() {
    var db = store.db();
    var sealed = db.packages.filter(function (p) { return p.status === 'sealed'; });
    var released = db.packages.filter(function (p) { return p.status === 'released'; }).reverse();
    var quar = CH.quarantine(db);

    return '<div class="view-head"><div><h1 class="view-title">发布包与隔离区</h1>' +
      '<p class="view-desc">只有就绪条款能封入发布包；未通过或缺依赖的留在隔离区。封包是快照，之后条款再改产生新版本，旧包带旧版发布将被拦下。</p></div>' +
      '<button class="btn primary" data-act="new-package">＋ 组装新发布包</button></div>' +

      '<div class="grid cols-2">' +
        '<div class="card"><div class="card-title">待发布包 <span class="sub">封存快照，可解散重组</span></div>' +
          (sealed.length ? sealed.map(packageCard).join('') : '<div class="empty">没有待发布包</div>') +
        '</div>' +
        '<div class="card"><div class="card-title">已发布回执 <span class="sub">不可变更，刷新后仍可校验</span></div>' +
          (released.length ? released.map(packageCard).join('') : '<div class="empty">尚无发布回执</div>') +
        '</div>' +
      '</div>' +

      '<div class="card section-gap"><div class="card-title">隔离区 <span class="sub">以下条款不能进入发布包，原因实时计算</span></div>' +
        (quar.length ? '<div class="table-wrap"><table class="data"><thead><tr><th>条款 / 版本</th><th>阻断原因</th><th>影响产品</th><th></th></tr></thead><tbody>' +
          quar.map(function (q) {
            return '<tr><td style="min-width:180px"><div class="cell-title">' + esc(q.state.clause.title) + '</div>' +
              '<div class="code-mono">' + esc(q.state.clause.code) + ' ' + q.state.version.revision + '</div></td>' +
              '<td><ul class="reason-list blockers">' + q.reasons.map(function (r) {
                var detail = '';
                if (r.code === 'missing-region-approval') detail = '：' + r.detail.regions.map(function (x) { return REGION_NAME[x]; }).join('、');
                if (r.code === 'region-gap') detail = '：' + r.detail.gaps.map(function (g) { return g.product.name + '缺' + REGION_NAME[g.region]; }).join('；');
                return '<li><span class="ico">⛔</span>' + esc(r.label) + '<span class="detail">' + esc(detail) + '</span></li>';
              }).join('') + '</ul>' +
              (q.state.warnings.length ? '<ul class="reason-list warnings">' + warningLis(q.state) + '</ul>' : '') + '</td>' +
              '<td class="small">' + q.state.products.map(function (p) { return esc(p.name); }).join('、') + '</td>' +
              '<td><button class="btn tiny" data-open-clause="' + q.state.clause.id + '">去处理</button></td></tr>';
          }).join('') + '</tbody></table></div>'
        : '<div class="empty">隔离区为空，所有条款均可发布或已发布</div>') +
      '</div>';
  }

  function packageCard(p) {
    var db = store.db();
    var stale = p.status === 'sealed' ? CH.stalePackageEntries(db, p) : [];
    var verify = p.receipt ? store.verifyPackageReceipt(p) : null;
    return '<div class="pkg-entry"><div class="pe-head"><div><b>' + esc(p.name) + '</b>' +
      (p.productScope ? '<span class="small muted"> · ' + esc(p.productScope) + '</span>' : '') + '</div>' +
      (p.status === 'sealed'
        ? (stale.length
            ? '<span class="badge blocked"><span class="dot"></span>快照已过期</span>'
            : '<span class="badge ready"><span class="dot"></span>可发布</span>')
        : '<span class="badge published"><span class="dot"></span>已发布</span>') +
      '</div>' +
      '<div class="small muted">封存 ' + fmt(p.sealedAt) + (p.releasedAt ? ' ｜ 发布 ' + fmt(p.releasedAt) + ' by ' + esc(p.releasedBy) : '') +
        ' ｜ ' + p.entries.length + ' 条</div>' +
      '<div class="small" style="margin:4px 0">' + p.entries.map(function (e) {
        return '<span class="ref-chip">' + esc(e.code) + ' ' + e.revision + '</span>';
      }).join('') + '</div>' +
      (p.rejected && p.rejected.length ? '<div class="small" style="color:var(--crit-text)">封包时被隔离 ' + p.rejected.length +
        ' 条：' + p.rejected.map(function (r) { return esc(r.code || r.clauseId); }).join('、') + '</div>' : '') +
      (stale.length ? '<div class="alert crit" style="margin:8px 0"><span>⛔</span><div>' +
        stale.map(function (x) {
          if (x.changedDefinition) return esc(x.entry.code) + ' 依赖的定义「' + esc(x.changedDefinition.term) + '」在封包后更新';
          return esc(x.entry.code) + ' 的封包版本 ' + x.entry.revision + ' 已被 ' + x.currentVersion.revision + ' 取代';
        }).join('；') + '。请解散本包并用最新就绪版本重组。</div></div>' : '') +
      (verify ? '<div class="receipt-box"><div class="rp-title">🧾 发布回执 ' +
        '<span class="badge ' + (verify.ok ? 'ready' : 'blocked') + '"><span class="dot"></span>' + (verify.ok ? '校验一致' : '校验失败') + '</span></div>' +
        '<div class="fingerprint" style="margin:6px 0">' + esc(p.receipt.fingerprint) + '</div>' +
        '<div class="small muted">条目指纹：</div>' +
        verify.entries.map(function (r) {
          return '<div class="small">' + (r.ok ? '✓' : '✕') + ' ' + esc(r.code) + ' ' + esc(r.revision) +
            ' <span class="fingerprint">' + esc(r.expected) + '</span></div>';
        }).join('') + '</div>' : '') +
      '<div class="inline-actions" style="margin-top:8px">' +
        (p.status === 'sealed'
          ? '<button class="btn primary tiny" data-act="release-package" data-id="' + p.id + '"' + (stale.length ? ' disabled' : '') + '>交给发布同事</button>' +
            '<button class="btn tiny danger-ghost" data-act="discard-package" data-id="' + p.id + '">解散重组</button>'
          : '<button class="btn tiny" data-act="verify-receipt" data-id="' + p.id + '">重新校验回执</button>') +
      '</div></div>';
  }

  function newPackageDrawer() {
    var db = store.db();
    var states = CH.allClauseStates(db);
    var sealedIds = {};
    db.packages.filter(function (p) { return p.status === 'sealed'; }).forEach(function (p) {
      p.entries.forEach(function (e) { sealedIds[e.clauseId] = p.name; });
    });
    return '<div class="drawer-head"><div><h2 class="drawer-title">组装发布包</h2>' +
      '<p class="drawer-sub">勾选条款后实时预检：通过的入选，其余留在隔离区。</p></div>' +
      '<button class="icon-btn" data-act="close-drawer">✕</button></div>' +
      '<div class="card section-gap"><div class="field-row"><div class="field"><label>发布包名称</label><input id="pk-name" placeholder="如：2026 秋季综合包"></div>' +
      '<div class="field" style="max-width:220px"><label>产品范围（备注）</label><input id="pk-scope" placeholder="如：湾区长期重疾险"></div></div></div>' +
      '<div class="card section-gap"><div class="card-title">选择条款</div><div class="pick-list" id="pk-picklist">' +
      states.map(function (s) {
        var ready = s.state === 'ready';
        var dup = sealedIds[s.clause.id];
        var disabled = !ready || !!dup;
        return '<label class="pick-item ' + (disabled ? 'disabled' : '') + '"><input type="checkbox" data-pk value="' + s.clause.id + '"' +
          (disabled ? ' disabled' : '') + '><div>' + stateBadge(s) + ' <b>' + esc(s.clause.code) + '</b> ' + esc(s.version.title) +
          ' <span class="small muted">' + s.version.revision + ' ｜ 生效 ' + fmtDate(s.version.effectiveDate) + ' ｜ ' +
            s.review.approvedRegions.concat(s.review.waivedRegions).map(function (r) { return REGION_NAME[r]; }).join('、') + '</span>' +
          (dup ? '<div class="small" style="color:var(--warn)">已在待发布包「' + esc(dup) + '」中</div>' : '') +
          (!ready ? '<ul class="reason-list blockers" style="margin-top:3px">' + blockerLis(s) + '</ul>' :
            '<div class="small" style="color:var(--good-text);margin-top:2px">✓ 预检通过，可入选</div>') +
        '</div></label>';
      }).join('') + '</div></div>' +
      '<div class="card section-gap"><div id="pk-preflight" class="small muted">尚未选择条款</div>' +
      '<div class="inline-actions" style="margin-top:10px"><button class="btn primary" data-act="seal-package">封存发布包</button>' +
      '<button class="btn" data-act="close-drawer">取消</button></div></div>';
  }

  /* ================= 抽屉渲染 ================= */

  function renderDrawer() {
    var old = $('#overlay-layer');
    if (old) old.remove();
    if (!state.drawer) return;
    var d = state.drawer;
    var html = '';
    if (d.type === 'clause') html = clauseDrawer(d.id, false);
    if (d.type === 'new-clause') html = clauseDrawer(null, true);
    if (d.type === 'definition') html = definitionDrawer(d.id, false);
    if (d.type === 'new-definition') html = definitionDrawer(null, true);
    if (d.type === 'product') html = productDrawer(d.id, false);
    if (d.type === 'new-product') html = productDrawer(null, true);
    if (d.type === 'new-package') html = newPackageDrawer();
    if (!html) return;
    var overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.id = 'overlay-layer';
    var drawer = document.createElement('div');
    drawer.className = 'drawer';
    drawer.innerHTML = html;
    overlay.appendChild(drawer);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) { state.drawer = null; render(); } });
    document.body.appendChild(overlay);
    bindDrawer(drawer);
  }

  /* ================= 数据收集 ================= */

  function checkedValues(scope, attr) {
    return $all('input[' + attr + ']:checked', scope).map(function (i) { return i.value; });
  }

  function readClauseForm(scope) {
    var coverage = $all('[data-cov-row]', scope).map(function (row) {
      var i = row.dataset.covRow;
      return { label: row.querySelector('[data-cov-label="' + i + '"]').value.trim(),
               stance: row.querySelector('[data-cov-stance="' + i + '"]').value };
    }).filter(function (c) { return c.label; });
    return {
      title: $('[data-field="title"]', scope).value.trim(),
      effectiveDate: $('[data-field="effectiveDate"]', scope).value || null,
      content: $('[data-field="content"]', scope).value,
      coverage: coverage,
      definitionRefs: checkedValues(scope, 'data-field="defref"'),
      regions: checkedValues(scope, 'data-field="region"'),
      productIds: checkedValues(scope, 'data-field="product"')
    };
  }

  /* ================= 事件绑定 ================= */

  function bindCurrentView() {
    var main = $('#main');
    var search = $('#clause-search');
    if (search) {
      search.value = state.search;
      search.focus();
      search.setSelectionRange(search.value.length, search.value.length);
      search.addEventListener('input', function () {
        state.search = search.value;
        var table = $('.table-wrap', main);
        // 轻量过滤：直接整表重绘会失焦，改为行隐藏
        var q = search.value.trim().toLowerCase();
        $all('tbody tr', main).forEach(function (tr) {
          tr.style.display = !q || tr.textContent.toLowerCase().indexOf(q) >= 0 ? '' : 'none';
        });
      });
    }
  }

  var autosaveBuffer = null;
  function bindDrawer(scope) {
    // 草稿自动暂存（独立通道，800ms 防抖）
    var draftClauseId = state.drawer && state.drawer.type === 'clause' ? state.drawer.id : null;
    if (draftClauseId) {
      var clause = CH.byId(store.db().clauses, draftClauseId);
      if (clause) {
        var v = CH.byId(clause.versions, clause.currentVersionId);
        if (v.status === 'draft') {
          autosaveBuffer = scope;
          scope.addEventListener('input', function () {
            clearTimeout(state.autosaveTimer);
            state.autosaveTimer = setTimeout(function () {
              if (!autosaveBuffer || !$('#overlay-layer')) { autosaveBuffer = null; return; }
              var patch = readClauseForm(autosaveBuffer);
              store.saveFormDraft(draftClauseId, patch);
              var line = $('#autosave-line');
              if (line) line.innerHTML = '<span class="saved-dot"></span>表单已自动暂存 ' + fmt(new Date().toISOString());
            }, 800);
          });
        }
      }
    }

    // 发布包预检
    var picklist = $('#pk-picklist', scope);
    if (picklist) {
      var refresh = function () {
        var ids = checkedValues(scope, 'data-pk');
        var box = $('#pk-preflight', scope);
        if (!ids.length) { box.className = 'small muted'; box.textContent = '尚未选择条款'; return; }
        var pre = CH.preflight(store.db(), ids);
        box.className = '';
        box.innerHTML = '<div class="small" style="color:var(--good-text)">✓ 入选 ' + pre.accepted.length + ' 条：' +
          pre.accepted.map(function (a) { return esc(a.state.clause.code); }).join('、') + '</div>' +
          (pre.rejected.length ? '<div class="small" style="color:var(--crit-text);margin-top:4px">⛔ 隔离 ' + pre.rejected.length + ' 条：' +
            pre.rejected.map(function (r) { return esc(r.clause ? r.clause.code : r.clauseId) + '（' + r.reasons.map(function (x) { return x.label; }).join('、') + '）'; }).join('；') + '</div>' : '');
      };
      picklist.addEventListener('change', refresh);
    }
  }

  function globalClick(e) {
    var chipEl = e.target.closest('[data-filter]');
    if (chipEl) { state.filter = chipEl.dataset.filter; render(); return; }

    var openCl = e.target.closest('[data-open-clause]');
    if (openCl) { state.drawer = { type: 'clause', id: openCl.dataset.openClause }; render(); return; }

    var openDef = e.target.closest('[data-open-definition]');
    if (openDef) { state.drawer = { type: 'definition', id: openDef.dataset.openDefinition }; render(); return; }

    var goEl = e.target.closest('[data-go]');
    if (goEl) {
      var go = goEl.dataset.go;
      if (go.indexOf('clauses') === 0) { state.view = 'clauses'; state.filter = go.split(':')[1] || 'all'; render(); }
      if (go === 'release') { state.view = 'release'; render(); }
      return;
    }

    var btn = e.target.closest('[data-act]');
    if (!btn) return;
    var act = btn.dataset.act;
    var db = store.db();

    switch (act) {
      case 'close-drawer': state.drawer = null; render(); break;

      case 'new-clause': state.drawer = { type: 'new-clause' }; render(); break;
      case 'create-clause': createClauseFromForm(scope()); break;

      case 'save-draft': saveDraftAction(btn.dataset.id, scope()); break;
      case 'restore-form-draft': restoreFormDraft(btn.dataset.id); break;
      case 'discard-form-draft':
        store.clearFormDraft(btn.dataset.id); toast('已丢弃暂存草稿'); render(); break;
      case 'submit':
        if (run('送审', function (db, ctx) { CH.submitForReview(db, btn.dataset.id, ctx); }, '已送审，可在评审轮次中登记意见')) {
          store.clearFormDraft(btn.dataset.id);
        }
        break;
      case 'withdraw':
        run('撤回送审', function (db, ctx) { CH.withdrawSubmission(db, btn.dataset.id, ctx); }, '已撤回为草稿');
        break;
      case 'followup':
        run(btn.dataset.kind === 'replacement' ? '替换新版本' : '退回后补交',
          function (db, ctx) { CH.followUpVersion(db, btn.dataset.id, { kind: btn.dataset.kind }, ctx); },
          btn.dataset.kind === 'replacement' ? '已生成替换版草稿，旧版冻结' : '已生成补交版草稿，旧结论保留为历史');
        break;
      case 'add-coverage':
        addCoverageRow(); break;
      case 'del-coverage':
        delCoverageRow(e); break;
      case 'verdict':
        submitVerdict(btn.dataset.v); break;

      case 'new-definition': state.drawer = { type: 'new-definition' }; render(); break;
      case 'create-definition':
        upsertDef(null); break;
      case 'save-definition':
        upsertDef(btn.dataset.id); break;

      case 'new-product': state.drawer = { type: 'new-product' }; render(); break;
      case 'edit-product': state.drawer = { type: 'product', id: btn.dataset.id }; render(); break;
      case 'create-product': upsertProduct(null); break;
      case 'save-product': upsertProduct(btn.dataset.id); break;

      case 'new-round':
        openRoundModal(); break;
      case 'close-round':
        run('关闭轮次', function (db, ctx) { CH.closeRound(db, btn.dataset.id, ctx); }, '轮次已关闭，意见全部归档为该轮结论');
        break;

      case 'new-package': state.drawer = { type: 'new-package' }; render(); break;
      case 'seal-package': sealFromForm(); break;
      case 'release-package':
        run('发布回执', function (db, ctx) { CH.releasePackage(db, btn.dataset.id, ctx); }, '已交给发布同事，回执封存');
        break;
      case 'discard-package':
        openConfirm('解散发布包', '解散后条款回到就绪/隔离状态，可用最新版本重新组包。确定解散？', function () {
          run('解散发布包', function (db, ctx) { CH.discardSealedPackage(db, btn.dataset.id, ctx); }, '发布包已解散');
        });
        break;
      case 'verify-receipt':
        var pkg = CH.byId(db.packages, btn.dataset.id);
        var res = store.verifyPackageReceipt(pkg);
        toast(res.ok ? '回执校验一致：版本关系未被改动' : '回执校验失败', res.ok ? 'ok' : 'error');
        render();
        break;
    }
  }

  function scope() { return $('#overlay-layer .drawer'); }

  function globalInput() { /* 预留 */ }
  function globalChange(e) {
    // 产品/地区/定义勾选在非草稿版本上是元信息，即时保存；草稿版本上的勾选随「保存草稿」
    var el = e.target;
    if (!state.drawer || state.drawer.type !== 'clause') return;
    var clause = CH.byId(store.db().clauses, state.drawer.id);
    if (!clause) return;
    var v = CH.byId(clause.versions, clause.currentVersionId);
    if (v.status !== 'draft' && (el.dataset.field === 'region' || el.dataset.field === 'product')) {
      var sc = scope();
      var patch = readClauseForm(sc);
      run('更新条款元信息', function (db, ctx) {
        CH.updateClauseMeta(db, clause.id, { regions: patch.regions, productIds: patch.productIds }, ctx);
      });
    }
  }

  /* ================= 动作实现 ================= */

  function createClauseFromForm(sc) {
    var code = $('#nc-code', sc).value.trim();
    var title = $('#nc-title', sc).value.trim();
    if (!code || !title) return toast('编号和标题必填', 'error');
    var createdId = null;
    var ok = run('新建条款', function (db, ctx) {
      var c = CH.createClause(db, {
        code: code, title: title, owner: $('#nc-owner', sc).value.trim() || '产品法务',
        regions: checkedValues(sc, 'data-nc-region'),
        productIds: checkedValues(sc, 'data-nc-product'),
        effectiveDate: $('#nc-date', sc).value || null,
        definitionRefs: checkedValues(sc, 'data-nc-defref'),
        content: $('#nc-content', sc).value
      }, ctx);
      createdId = c.id;
    }, '条款草稿已创建');
    if (ok) { state.drawer = { type: 'clause', id: createdId }; render(); }
  }

  function saveDraftAction(id, sc) {
    var patch = readClauseForm(sc);
    if (!patch.title) return toast('标题必填', 'error');
    var ok = run('保存草稿', function (db, ctx) {
      CH.saveDraft(db, id, patch, ctx);
      CH.updateClauseMeta(db, id, { regions: patch.regions, productIds: patch.productIds }, ctx);
    }, '草稿已保存');
    if (ok) { store.clearFormDraft(id); }
  }

  function restoreFormDraft(id) {
    var d = store.getFormDraft(id);
    if (!d) return;
    var sc = scope();
    $('[data-field="title"]', sc).value = d.patch.title || '';
    $('[data-field="effectiveDate"]', sc).value = d.patch.effectiveDate || '';
    $('[data-field="content"]', sc).value = d.patch.content || '';
    $all('[data-field="region"]', sc).forEach(function (cb) { cb.checked = d.patch.regions.indexOf(cb.value) >= 0; });
    $all('[data-field="product"]', sc).forEach(function (cb) { cb.checked = d.patch.productIds.indexOf(cb.value) >= 0; });
    $all('[data-field="defref"]', sc).forEach(function (cb) { cb.checked = d.patch.definitionRefs.indexOf(cb.value) >= 0; });
    var editor = $('#coverage-editor', sc);
    var clause = CH.byId(store.db().clauses, id);
    var fakeV = { coverage: d.patch.coverage };
    editor.innerHTML = coverageEditorRows(fakeV, true);
    toast('暂存草稿已恢复到表单');
  }

  function addCoverageRow() {
    var editor = $('#coverage-editor');
    var i = editor.querySelectorAll('[data-cov-row]').length;
    var div = document.createElement('div');
    div.className = 'field-row';
    div.dataset.covRow = i;
    div.innerHTML = '<div class="field" style="margin:0"><input data-cov-label="' + i + '" placeholder="责任项，如：门诊手术"></div>' +
      '<div class="field" style="margin:0;max-width:120px"><select data-cov-stance="' + i + '">' +
      '<option value="cover">✓ 保障</option><option value="exclude">✕ 除外</option></select></div>' +
      '<button class="btn tiny danger-ghost" data-act="del-coverage" data-idx="' + i + '">删</button>';
    editor.appendChild(div);
  }

  function delCoverageRow(e) {
    var btn = e.target.closest('[data-act="del-coverage"]');
    var row = btn.closest('[data-cov-row]');
    if (row) row.remove();
    renumberCoverage();
  }

  function renumberCoverage() {
    $all('#coverage-editor [data-cov-row]').forEach(function (row, i) {
      row.dataset.covRow = i;
      row.querySelector('[data-cov-label]').dataset.covLabel = String(i);
      row.querySelector('[data-cov-label]').setAttribute('data-cov-label', String(i));
      row.querySelector('[data-cov-stance]').dataset.covStance = String(i);
      row.querySelector('[data-cov-stance]').setAttribute('data-cov-stance', String(i));
      var del = row.querySelector('[data-act="del-coverage"]');
      if (del) del.dataset.idx = i;
    });
  }

  function submitVerdict(verdict) {
    var form = $('#verdict-form');
    var sc = scope();
    var input = {
      clauseId: form.dataset.clause,
      versionId: form.dataset.version,
      region: $('[data-vf="region"]', form).value,
      reviewer: $('[data-vf="reviewer"]', form).value.trim(),
      comment: $('[data-vf="comment"]', form).value.trim(),
      verdict: verdict
    };
    run('登记评审意见', function (db, ctx) { CH.recordVerdict(db, input, ctx); },
      CH.REGIONS[input.region] + '意见已登记到当前轮次');
  }

  function upsertDef(id) {
    var sc = scope();
    var term = $('#def-term', sc).value.trim();
    var content = $('#def-content', sc).value.trim();
    if (!term) return toast('术语必填', 'error');
    var ok = run(id ? '更新定义' : '新建定义', function (db, ctx) { CH.upsertDefinition(db, { id: id, term: term, content: content }, ctx); },
      id ? '定义已保存，受影响条款将要求复审' : '定义已创建');
    if (ok) { state.drawer = null; render(); }
  }

  function upsertProduct(id) {
    var sc = scope();
    var name = $('#pr-name', sc).value.trim();
    if (!name) return toast('产品名称必填', 'error');
    var regions = checkedValues(sc, 'data-pr-region');
    var clauseIds = checkedValues(sc, 'data-pr-clause');
    run(id ? '更新产品' : '新建产品', function (db, ctx) {
      var p = CH.upsertProduct(db, { id: id, name: name, code: $('#pr-code', sc).value.trim(), regions: regions }, ctx);
      // 双向：从产品侧设置条款关联
      db.clauses.forEach(function (c) {
        var want = clauseIds.indexOf(c.id) >= 0;
        var has = c.productIds.indexOf(p.id) >= 0;
        if (want && !has) c.productIds.push(p.id);
        if (!want && has) c.productIds = c.productIds.filter(function (x) { return x !== p.id; });
      });
      p.clauseIds = clauseIds.slice();
      CH.audit(db, 'product.link', '产品条款关联更新：' + name, ctx);
    }, '产品已保存');
    if (ok) { state.drawer = null; render(); }
  }

  function openRoundModal() {
    var name = prompt('新一轮评审名称', '第' + (store.db().rounds.length + 1) + '轮评审');
    if (name === null) return;
    run('开启轮次', function (db, ctx) { CH.createRound(db, { name: name.trim() || undefined }, ctx); }, '新一轮评审已开启');
  }

  function sealFromForm() {
    var sc = scope();
    var ids = checkedValues(sc, 'data-pk');
    if (!ids.length) return toast('请至少勾选一个就绪条款', 'error');
    var sealed;
    var ok = run('封存发布包', function (db, ctx) {
      var r = CH.sealPackage(db, { name: $('#pk-name', sc).value.trim() || undefined, productScope: $('#pk-scope', sc).value.trim() || null, clauseIds: ids }, ctx);
      sealed = r;
    });
    if (ok) {
      state.drawer = null;
      toast('发布包已封存：' + sealed.accepted.length + ' 条入选，' + sealed.rejected.length + ' 条隔离');
    }
  }

  function doExport() {
    var blob = new Blob([store.exportJSON()], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'clauseharbor-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function doImport(e) {
    var file = e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        store.importJSON(String(reader.result));
        toast('备份已导入，发布回执与版本关系保持一致');
        state.drawer = null; render();
      } catch (err) { toast(err.message, 'error'); }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  /* ---------- 通用确认弹层 ---------- */
  function openConfirm(title, body, onOk) {
    var overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.innerHTML = '<div class="card" style="margin:auto;max-width:420px;width:92%;align-self:center;height:fit-content">' +
      '<div class="card-title">' + esc(title) + '</div><div class="small" style="margin-bottom:14px">' + esc(body) + '</div>' +
      '<div class="inline-actions"><button class="btn danger" id="cf-ok">确定</button><button class="btn" id="cf-cancel">取消</button></div></div>';
    overlay.style.justifyContent = 'center';
    document.body.appendChild(overlay);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay || e.target.id === 'cf-cancel') overlay.remove();
      if (e.target.id === 'cf-ok') { overlay.remove(); onOk(); }
    });
  }

  init();
})();
