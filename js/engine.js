/*
 * ClauseHarbor 核心引擎（纯逻辑，无 DOM 依赖）
 *
 * 设计原则：
 * 1. 结论只认「当前版本 + 最新轮次」：退回 / 补交 / 替换都会产生新版本，
 *    旧版本、旧轮次的意见只作历史留痕，永远不能覆盖当前结论。
 * 2. 所有判定（冲突、准备度、隔离原因）均为派生值，任意时刻可从 db 重算，
 *    不依赖缓存 —— 持久化层只要保住 db 即可。
 * 3. 发布包以「快照 + 指纹」封存，发布后不可变；条款之后再改产生新版本，
 *    不影响回执。
 */
(function (global) {
  'use strict';

  /* ---------------- 基础工具 ---------------- */

  function uid(prefix, db) {
    var seq = (db.meta.seq[prefix] = (db.meta.seq[prefix] || 0) + 1);
    return prefix + '-' + String(seq).padStart(3, '0');
  }

  function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
    var keys = Object.keys(value).sort();
    return '{' + keys.map(function (k) { return JSON.stringify(k) + ':' + stableStringify(value[k]); }).join(',') + '}';
  }

  // FNV-1a 32 位指纹，浏览器 / Node 行为一致
  function fingerprint(input) {
    var s = typeof input === 'string' ? input : stableStringify(input);
    var hash = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) {
      hash ^= s.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return 'fnv32-' + hash.toString(16).padStart(8, '0');
  }

  function byId(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function uniq(arr) { return Array.prototype.filter.call(arr, function (v, i) { return arr.indexOf(v) === i; }); }

  function difference(a, b) { return a.filter(function (x) { return b.indexOf(x) < 0; }); }

  var REGIONS = {
    BJ: '北京', SH: '上海', GD: '广东', SC: '四川', HB: '湖北'
  };

  var VERDICTS = {
    approved: '通过',
    returned: '退回',
    waived: '弃权/免审',
    pending: '待审'
  };

  var BLOCKER_LABELS = {
    draft: '当前版本仍是草稿',
    returned: '当前轮次被地区退回',
    'missing-region-approval': '尚有地区未在当前轮次通过',
    'definition-missing': '引用的定义不存在',
    'definition-changed': '引用定义在通过后发生变更，需复审',
    'effective-inversion': '生效日期不得早于被替换版本（生效倒挂）',
    'coverage-conflict': '与同产品其他条款责任范围冲突',
    'region-gap': '产品上线地区存在条款未覆盖的地区',
    'stale-package-entry': '发布包含有已被替换的旧版本'
  };

  var WARNING_LABELS = {
    'replacement-residue': '仍有进行中轮次在评审被替换的旧版本',
    'draft-conflict': '草稿与其他条款存在责任范围冲突',
    'post-publish-definition-change': '已发布版本引用的定义在发布后更新（回执仍有效，建议下一包对齐）'
  };

  function createDB() {
    return {
      meta: { schema: 1, seq: {}, createdAt: null },
      definitions: [],
      products: [],
      clauses: [],
      rounds: [],
      packages: [],
      audit: []
    };
  }

  function audit(db, type, detail, ctx) {
    db.audit.push({
      seq: db.audit.length + 1,
      at: ctx.now,
      type: type,
      detail: detail,
      actor: ctx.actor || '法务编辑'
    });
  }

  /* ---------------- 领域对象变更 ---------------- */

  function upsertDefinition(db, input, ctx) {
    var existing = input.id ? byId(db.definitions, input.id) : null;
    if (existing) {
      existing.term = input.term;
      existing.content = input.content;
      existing.updatedAt = ctx.now;
      audit(db, 'definition.update', '定义更新：' + existing.term, ctx);
      return existing;
    }
    var def = {
      id: uid('D', db),
      term: input.term,
      content: input.content,
      createdAt: ctx.now,
      updatedAt: ctx.now
    };
    db.definitions.push(def);
    audit(db, 'definition.create', '新建定义：' + def.term, ctx);
    return def;
  }

  function upsertProduct(db, input, ctx) {
    var existing = input.id ? byId(db.products, input.id) : null;
    if (existing) {
      existing.name = input.name;
      existing.regions = input.regions.slice();
      audit(db, 'product.update', '产品更新：' + existing.name, ctx);
      return existing;
    }
    var product = { id: uid('P', db), code: input.code || '', name: input.name, regions: input.regions.slice(), createdAt: ctx.now };
    db.products.push(product);
    if (input.clauseIds) product.clauseIds = input.clauseIds.slice();
    audit(db, 'product.create', '新建产品：' + product.name, ctx);
    return product;
  }

  function attachClauseToProducts(db, clauseId, productIds, ctx) {
    var clause = byId(db.clauses, clauseId);
    productIds.forEach(function (pid) {
      var p = byId(db.products, pid);
      if (!p) return;
      p.clauseIds = p.clauseIds || [];
      if (p.clauseIds.indexOf(clauseId) < 0) {
        p.clauseIds.push(clauseId);
        audit(db, 'product.attach', p.name + ' 关联条款 ' + clause.code, ctx);
      }
    });
  }

  function createClause(db, input, ctx) {
    var version = {
      id: uid('V', db),
      revision: 'v1',
      kind: 'initial',
      status: 'draft', // draft | submitted | returned | published
      title: input.title,
      content: input.content || '',
      coverage: input.coverage || [], // [{label, stance: 'cover'|'exclude'}]
      effectiveDate: input.effectiveDate || null,
      definitionRefs: (input.definitionRefs || []).slice(),
      replacesVersionId: null,
      supersededBy: null,
      createdAt: ctx.now,
      submittedAt: null
    };
    var clause = {
      id: uid('C', db),
      code: input.code,
      title: input.title,
      owner: input.owner || '产品法务',
      regions: (input.regions || []).slice(),
      productIds: (input.productIds || []).slice(),
      currentVersionId: version.id,
      versions: [version],
      createdAt: ctx.now
    };
    db.clauses.push(clause);
    attachClauseToProducts(db, clause.id, clause.productIds, ctx);
    audit(db, 'clause.create', '新建条款 ' + clause.code + '（草稿 v1）', ctx);
    return clause;
  }

  function updateClauseMeta(db, clauseId, patch, ctx) {
    var clause = byId(db.clauses, clauseId);
    if (patch.title !== undefined) clause.title = patch.title;
    if (patch.regions) clause.regions = patch.regions.slice();
    if (patch.owner !== undefined) clause.owner = patch.owner;
    if (patch.productIds) {
      clause.productIds = patch.productIds.slice();
      db.products.forEach(function (p) {
        p.clauseIds = (p.clauseIds || []).filter(function (id) { return id !== clauseId; });
      });
      attachClauseToProducts(db, clauseId, clause.productIds, ctx);
    }
    audit(db, 'clause.meta', '条款元信息更新：' + clause.code, ctx);
  }

  // 保存草稿（仅 status=draft 的版本可改内容）
  function saveDraft(db, clauseId, patch, ctx) {
    var clause = byId(db.clauses, clauseId);
    var version = byId(clause.versions, clause.currentVersionId);
    if (version.status !== 'draft') throw new Error('当前版本已送审，不能直接覆盖；请使用「补交/替换」生成新版本');
    if (patch.title !== undefined) { version.title = patch.title; clause.title = patch.title; }
    if (patch.content !== undefined) version.content = patch.content;
    if (patch.coverage) version.coverage = patch.coverage;
    if (patch.effectiveDate !== undefined) version.effectiveDate = patch.effectiveDate;
    if (patch.definitionRefs) version.definitionRefs = patch.definitionRefs.slice();
    audit(db, 'clause.draft', '草稿保存：' + clause.code + ' ' + version.revision, ctx);
    return version;
  }

  // 撤回送审：仅限当前版本尚无任何评审意见
  function withdrawSubmission(db, clauseId, ctx) {
    var clause = byId(db.clauses, clauseId);
    var version = byId(clause.versions, clause.currentVersionId);
    if (version.status !== 'submitted') throw new Error('只有「待审」版本可以撤回');
    var items = collectItems(db, clause.id, version.id);
    if (items.length) throw new Error('该版本已有评审意见，不能撤回；请走退回后补交流程');
    version.status = 'draft';
    version.submittedAt = null;
    audit(db, 'clause.withdraw', '撤回送审：' + clause.code + ' ' + version.revision, ctx);
  }

  function submitForReview(db, clauseId, ctx) {
    var clause = byId(db.clauses, clauseId);
    var version = byId(clause.versions, clause.currentVersionId);
    if (version.status !== 'draft') throw new Error('只有草稿可以送审');
    if (!version.effectiveDate) throw new Error('请先填写生效日期再送审');
    if (!clause.regions.length) throw new Error('请先选择适用地区再送审');
    version.status = 'submitted';
    version.submittedAt = ctx.now;
    audit(db, 'clause.submit', clause.code + ' ' + version.revision + ' 提交评审', ctx);
  }

  // 退回后补交 / 替换：一律产生新版本，旧版本冻结
  function followUpVersion(db, clauseId, input, ctx) {
    var clause = byId(db.clauses, clauseId);
    var base = byId(clause.versions, input.baseVersionId || clause.currentVersionId);
    if (base.status === 'draft') throw new Error('旧版本仍是草稿，无需补交');
    var kind = input.kind === 'replacement' ? 'replacement' : 'resubmit';
    var revNo = clause.versions.length + 1;
    var version = {
      id: uid('V', db),
      revision: 'v' + revNo,
      kind: kind,
      status: 'draft',
      title: input.title !== undefined ? input.title : base.title,
      content: input.content !== undefined ? input.content : base.content,
      coverage: input.coverage || base.coverage.map(function (c) { return { label: c.label, stance: c.stance }; }),
      effectiveDate: input.effectiveDate || base.effectiveDate,
      definitionRefs: (input.definitionRefs || base.definitionRefs.slice()).slice(),
      replacesVersionId: base.id,
      supersededBy: null,
      createdAt: ctx.now,
      submittedAt: null
    };
    base.supersededBy = version.id;
    clause.versions.push(version);
    clause.currentVersionId = version.id;
    audit(db, kind === 'replacement' ? 'clause.replace' : 'clause.resubmit',
      clause.code + ' ' + version.revision + '（' + (kind === 'replacement' ? '替换' : '补交') + '自 ' + base.revision + '）', ctx);
    return version;
  }

  /* ---------------- 评审轮次 ---------------- */

  function createRound(db, input, ctx) {
    var open = db.rounds.filter(function (r) { return !r.closedAt; });
    if (open.length) throw new Error('仍有未关闭的轮次：' + open[0].name);
    var round = {
      id: uid('R', db),
      no: db.rounds.length + 1,
      name: input.name || ('第' + (db.rounds.length + 1) + '轮评审'),
      openedAt: ctx.now,
      closedAt: null,
      items: []
    };
    db.rounds.push(round);
    audit(db, 'round.open', '开启 ' + round.name, ctx);
    return round;
  }

  function closeRound(db, roundId, ctx) {
    var round = byId(db.rounds, roundId);
    round.closedAt = ctx.now;
    audit(db, 'round.close', '关闭 ' + round.name + '（意见 ' + round.items.length + ' 条）', ctx);
  }

  function openRound(db) {
    for (var i = db.rounds.length - 1; i >= 0; i--) {
      if (!db.rounds[i].closedAt) return db.rounds[i];
    }
    return null;
  }

  function collectItems(db, clauseId, versionId) {
    var out = [];
    db.rounds.forEach(function (r) {
      r.items.forEach(function (it) {
        if (it.clauseId === clauseId && (!versionId || it.versionId === versionId)) {
          out.push(Object.assign({ roundNo: r.no, roundId: r.id, roundName: r.name, roundOpen: !r.closedAt }, it));
        }
      });
    });
    return out.sort(function (a, b) { return a.roundNo - b.roundNo || a.at - b.at; });
  }

  // 登记地区意见。意见必须挂在具体版本上；评审旧版本会被拒绝。
  function recordVerdict(db, input, ctx) {
    var clause = byId(db.clauses, input.clauseId);
    if (!clause) throw new Error('条款不存在');
    var version = byId(clause.versions, input.versionId);
    if (!version) throw new Error('版本不存在');
    if (version.id !== clause.currentVersionId) {
      throw new Error('该版本已被 ' + byId(clause.versions, clause.currentVersionId).revision + ' 取代，旧轮次意见不能覆盖当前版本');
    }
    var round = input.roundId ? byId(db.rounds, input.roundId) : openRound(db);
    if (!round) throw new Error('没有进行中的评审轮次');
    if (round.closedAt) throw new Error('该轮次已关闭');
    if (['approved', 'returned', 'waived'].indexOf(input.verdict) < 0) throw new Error('结论不合法');
    // 已发布版本只留档「通过 / 弃权」备案意见，版本状态与封存回执都不改变；
    // 退回必须走补交 / 替换新版本。它被取代后，备案意见自动归入「替换残留」。
    var wasPublished = version.status === 'published';
    if (wasPublished && input.verdict === 'returned') {
      throw new Error('该版本已发布，不能再退回；请基于发布版本补交或替换新版本');
    }
    if (version.status === 'draft') {
      throw new Error('该版本还是草稿，请先送审再登记地区意见');
    }
    var existing = null;
    for (var i = 0; i < round.items.length; i++) {
      var it = round.items[i];
      if (it.clauseId === clause.id && it.versionId === version.id && it.region === input.region) { existing = it; break; }
    }
    if (existing) {
      existing.verdict = input.verdict;
      existing.comment = input.comment || '';
      existing.reviewer = input.reviewer || existing.reviewer;
      existing.at = ctx.now;
      existing.revised = (existing.revised || 0) + 1;
    } else {
      round.items.push({
        id: uid('I', db),
        clauseId: clause.id,
        versionId: version.id,
        region: input.region,
        verdict: input.verdict,
        comment: input.comment || '',
        reviewer: input.reviewer || REGIONS[input.region] + '审核人',
        at: ctx.now
      });
    }
    // 同轮改判后按本轮现存意见重算状态：本轮仍有退回 → 退回；否则回到待审。
    // 已发布版本的状态不受留档意见影响。
    if (!wasPublished) {
      var stillReturned = round.items.some(function (it) {
        return it.clauseId === clause.id && it.versionId === version.id && it.verdict === 'returned';
      });
      version.status = stillReturned ? 'returned' : 'submitted';
    }
    audit(db, 'review.verdict',
      round.name + ' · ' + REGIONS[input.region] + ' · ' + clause.code + ' ' + version.revision + ' → ' + VERDICTS[input.verdict], ctx);
  }

  /* ---------------- 派生：评审状态 / 冲突 / 准备度 ---------------- */

  function impactedProducts(db, clause) {
    return db.products.filter(function (p) { return (p.clauseIds || []).indexOf(clause.id) >= 0; });
  }

  function versionReview(db, clause, version) {
    var items = collectItems(db, clause.id, version.id);
    var result = {
      items: items,
      latestRoundNo: null,
      byRegion: {},
      returnedRegions: [],
      approvedRegions: [],
      waivedRegions: [],
      missingRegions: clause.regions.slice(),
      staleDefinition: false,
      unreviewed: items.length === 0
    };
    if (!items.length) return result;
    // 已发布版本的当前结论冻结在发布轮次；之后的备案意见只在时间线留档
    result.latestRoundNo = version.publishedRoundNo || items[items.length - 1].roundNo;
    var latest = items.filter(function (it) { return it.roundNo === result.latestRoundNo; });
    latest.forEach(function (it) { result.byRegion[it.region] = it; });
    clause.regions.forEach(function (rg) {
      var it = result.byRegion[rg];
      if (!it) return;
      if (it.verdict === 'approved') result.approvedRegions.push(rg);
      else if (it.verdict === 'returned') result.returnedRegions.push(rg);
      else if (it.verdict === 'waived') result.waivedRegions.push(rg);
    });
    result.missingRegions = clause.regions.filter(function (rg) {
      var it = result.byRegion[rg];
      return !it || (it.verdict !== 'approved' && it.verdict !== 'waived');
    });
    return result;
  }

  function coverageConflicts(db) {
    // product -> label -> stance -> [clause/version]
    var conflicts = [];
    db.products.forEach(function (p) {
      var index = {};
      (p.clauseIds || []).forEach(function (cid) {
        var clause = byId(db.clauses, cid);
        if (!clause) return;
        var v = byId(clause.versions, clause.currentVersionId);
        if (!v || v.status === 'draft') return;
        (v.coverage || []).forEach(function (c) {
          index[c.label] = index[c.label] || {};
          (index[c.label][c.stance] = index[c.label][c.stance] || []).push({ clause: clause, version: v });
        });
      });
      Object.keys(index).forEach(function (label) {
        if (index[label].cover && index[label].exclude) {
          conflicts.push({
            key: 'coverage:' + p.id + ':' + label,
            product: p, label: label,
            cover: index[label].cover,
            exclude: index[label].exclude,
            clauseIds: uniq(index[label].cover.concat(index[label].exclude).map(function (x) { return x.clause.id; }))
          });
        }
      });
    });
    return conflicts;
  }

  function draftCoverageConflicts(db) {
    // 草稿阶段的同类冲突（仅提示）
    var conflicts = [];
    db.products.forEach(function (p) {
      var cover = [], exclude = [];
      (p.clauseIds || []).forEach(function (cid) {
        var clause = byId(db.clauses, cid);
        if (!clause) return;
        var v = byId(clause.versions, clause.currentVersionId);
        if (!v || v.status !== 'draft') return;
        (v.coverage || []).forEach(function (c) {
          (c.stance === 'cover' ? cover : exclude).push({ clause: clause, version: v, label: c.label });
        });
      });
      // 草稿与同产品已生效版本对打
      (p.clauseIds || []).forEach(function (cid) {
        var clause = byId(db.clauses, cid);
        if (!clause) return;
        var v = byId(clause.versions, clause.currentVersionId);
        if (!v || v.status === 'draft') return;
        (v.coverage || []).forEach(function (c) {
          var hit = (c.stance === 'cover' ? exclude : cover).filter(function (d) { return d.label === c.label; });
          hit.forEach(function (d) {
            conflicts.push({ product: p, label: c.label, draftClause: d.clause, otherClause: clause });
          });
        });
      });
    });
    return conflicts;
  }

  function replacementResidue(db) {
    // 进行中轮次仍在对已被取代的版本下结论，而新版本在该轮次没有意见
    var out = [];
    db.rounds.filter(function (r) { return !r.closedAt; }).forEach(function (r) {
      r.items.forEach(function (it) {
        var clause = byId(db.clauses, it.clauseId);
        if (!clause) return;
        if (it.versionId === clause.currentVersionId) return;
        var hasNew = r.items.some(function (x) { return x.clauseId === clause.id && x.versionId === clause.currentVersionId; });
        if (!hasNew) {
          out.push({ round: r, item: it, clause: clause, staleVersion: byId(clause.versions, it.versionId) });
        }
      });
    });
    return uniq(out.map(function (x) { return x; })).filter(function (v, i, a) {
      return a.findIndex(function (x) { return x.round.id === v.round.id && x.item.id === v.item.id; }) === i;
    });
  }

  function computeClauseState(db, clause) {
    var version = byId(clause.versions, clause.currentVersionId);
    var review = versionReview(db, clause, version);

    // 定义变更导致复审：逐地区核对——该地区最新「通过」意见早于定义更新时间，就必须在更新后的轮次重新表态
    var staleDefs = [];
    (version.definitionRefs || []).forEach(function (did) {
      var def = byId(db.definitions, did);
      if (!def) return;
      var staleRegions = Object.keys(review.byRegion).filter(function (rg) {
        var it = review.byRegion[rg];
        return it.verdict === 'approved' && it.at < def.updatedAt;
      });
      if (staleRegions.length) staleDefs.push({ def: def, regions: staleRegions });
    });

    var blockers = [];
    var warnings = [];

    var missingDefs = (version.definitionRefs || []).filter(function (did) { return !byId(db.definitions, did); });
    if (missingDefs.length) blockers.push({ code: 'definition-missing', defIds: missingDefs });

    // 已发布版本封入回执、不可变：定义在发布后更新不构成阻断（回执照原样有效），
    // 仅提示下一轮 / 下一个发布包需要对齐；未发布版本则旧定义下的通过一律失效
    if (staleDefs.length && version.status !== 'published') {
      blockers.push({ code: 'definition-changed', defs: staleDefs });
      var staleRegionSet = {};
      staleDefs.forEach(function (sd) {
        sd.regions.forEach(function (rg) { staleRegionSet[rg] = sd.def.term; });
      });
      review.staleRegions = Object.keys(staleRegionSet);
      review.approvedRegions = review.approvedRegions.filter(function (rg) { return !(rg in staleRegionSet); });
      review.missingRegions = uniq(review.missingRegions.concat(Object.keys(staleRegionSet)));
    } else if (staleDefs.length) {
      warnings.push({ code: 'post-publish-definition-change', defs: staleDefs });
      review.staleRegions = [];
    }
    if (version.replacesVersionId) {
      var base = byId(clause.versions, version.replacesVersionId);
      if (base && version.effectiveDate && base.effectiveDate && version.effectiveDate < base.effectiveDate) {
        blockers.push({ code: 'effective-inversion', baseDate: base.effectiveDate, date: version.effectiveDate });
      }
    }

    var products = impactedProducts(db, clause);
    var gapRegions = [];
    products.forEach(function (p) {
      difference(p.regions, clause.regions).forEach(function (rg) { gapRegions.push({ product: p, region: rg }); });
    });
    if (gapRegions.length) blockers.push({ code: 'region-gap', gaps: gapRegions });

    var covConflicts = coverageConflicts(db).filter(function (c) { return c.clauseIds.indexOf(clause.id) >= 0; });
    if (covConflicts.length) blockers.push({ code: 'coverage-conflict', conflicts: covConflicts });

    if (version.status === 'draft') blockers.push({ code: 'draft' });
    if (version.status === 'returned' || review.returnedRegions.length) {
      blockers.push({ code: 'returned', regions: review.returnedRegions });
    }
    if (['submitted', 'returned'].indexOf(version.status) >= 0 && review.missingRegions.length) {
      blockers.push({ code: 'missing-region-approval', regions: review.missingRegions });
    }

    replacementResidue(db).forEach(function (r) {
      if (r.clause.id === clause.id) warnings.push({ code: 'replacement-residue', round: r.round, staleVersion: r.staleVersion });
    });
    draftCoverageConflicts(db).forEach(function (c) {
      if (c.draftClause.id === clause.id) warnings.push({ code: 'draft-conflict', conflict: c });
    });

    var publishedIn = db.packages.filter(function (pk) {
      return pk.status === 'released' && pk.entries.some(function (e) { return e.clauseId === clause.id; });
    }).map(function (pk) {
      var e = pk.entries.filter(function (x) { return x.clauseId === clause.id; })[0];
      return { package: pk, versionId: e.versionId };
    });

    var state;
    if (version.status === 'published') state = 'published';
    else if (blockers.length) state = 'blocked';
    else state = 'ready';

    return {
      clause: clause,
      version: version,
      review: review,
      blockers: blockers,
      warnings: warnings,
      products: products,
      state: state,
      publishedIn: publishedIn,
      hasNewerAfterPublish: publishedIn.some(function (x) { return x.versionId !== version.id; }) ||
        (version.status !== 'published' && publishedIn.length > 0)
    };
  }

  function allClauseStates(db) {
    return db.clauses.map(function (c) { return computeClauseState(db, c); });
  }

  /* ---------------- 发布包 / 隔离区 ---------------- */

  function entryFingerprint(clause, version, review) {
    return fingerprint({
      clauseId: clause.id,
      code: clause.code,
      versionId: version.id,
      revision: version.revision,
      title: version.title,
      content: version.content,
      coverage: version.coverage,
      effectiveDate: version.effectiveDate,
      definitionRefs: version.definitionRefs,
      approvedRegions: review.approvedRegions.concat(review.waivedRegions),
      latestRoundNo: review.latestRoundNo
    });
  }

  // 预检：给出可入选与必须隔离的清单
  function preflight(db, clauseIds) {
    var accepted = [], rejected = [];
    clauseIds.forEach(function (cid) {
      var clause = byId(db.clauses, cid);
      if (!clause) { rejected.push({ clauseId: cid, reasons: [{ code: 'missing', label: '条款不存在' }] }); return; }
      var st = computeClauseState(db, clause);
      if (st.state === 'ready') {
        accepted.push({ state: st, fingerprint: entryFingerprint(clause, st.version, st.review) });
      } else {
        rejected.push({
          clauseId: cid,
          clause: clause,
          state: st,
          reasons: st.blockers.map(function (b) { return { code: b.code, label: BLOCKER_LABELS[b.code] || b.code, detail: b }; })
        });
      }
    });
    return { accepted: accepted, rejected: rejected };
  }

  function quarantine(db) {
    // 隔离区 = 所有当前版本不能发布的条款（已发布条款的新版本单列）
    return allClauseStates(db).filter(function (st) {
      return st.state !== 'published' && st.state !== 'ready';
    }).map(function (st) {
      return {
        state: st,
        reasons: st.blockers.map(function (b) { return { code: b.code, label: BLOCKER_LABELS[b.code] || b.code, detail: b }; })
      };
    });
  }

  function sealPackage(db, input, ctx) {
    var ids = uniq(input.clauseIds || []);
    if (!ids.length) throw new Error('发布包至少包含一个条款');
    var pre = preflight(db, ids);
    if (!pre.accepted.length) throw new Error('没有任何条款通过预检，不能组成发布包');

    // 已封包待发布的条目不能重复进入另一个包
    pre.accepted.forEach(function (a) {
      db.packages.filter(function (p) { return p.status === 'sealed'; }).forEach(function (p) {
        if (p.entries.some(function (e) { return e.clauseId === a.state.clause.id; })) {
          throw new Error(a.state.clause.code + ' 已在待发布包「' + p.name + '」中');
        }
      });
    });

    var entries = pre.accepted.map(function (a) {
      var v = a.state.version;
      return {
        clauseId: a.state.clause.id,
        versionId: v.id,
        revision: v.revision,
        code: a.state.clause.code,
        title: v.title,
        contentSnapshot: v.content,
        coverage: v.coverage.map(function (c) { return { label: c.label, stance: c.stance }; }),
        effectiveDate: v.effectiveDate,
        definitionRefs: v.definitionRefs.slice(),
        approvedRegions: a.state.review.approvedRegions.concat(a.state.review.waivedRegions),
        roundNo: a.state.review.latestRoundNo,
        fingerprint: a.fingerprint
      };
    });
    var pkg = {
      id: uid('PK', db),
      name: input.name || ('发布包-' + (db.packages.length + 1)),
      productScope: input.productScope || null,
      status: 'sealed',
      createdAt: ctx.now,
      sealedAt: ctx.now,
      entries: entries,
      rejected: pre.rejected.map(function (r) {
        return {
          clauseId: r.clauseId,
          code: r.clause ? r.clause.code : null,
          reasons: r.reasons.map(function (x) { return x.code; })
        };
      }),
      receipt: null
    };
    pkg.fingerprint = fingerprint(entries.map(function (e) {
      return { clauseId: e.clauseId, versionId: e.versionId, fingerprint: e.fingerprint };
    }));
    db.packages.push(pkg);
    audit(db, 'package.seal',
      '封包「' + pkg.name + '」：入选 ' + entries.length + ' 条，隔离 ' + pre.rejected.length + ' 条', ctx);
    return { pkg: pkg, accepted: pre.accepted, rejected: pre.rejected };
  }

  function discardSealedPackage(db, packageId, ctx) {
    var pkg = byId(db.packages, packageId);
    if (!pkg) throw new Error('发布包不存在');
    if (pkg.status !== 'sealed') throw new Error('已发布回执不可撤回');
    db.packages = db.packages.filter(function (p) { return p.id !== packageId; });
    audit(db, 'package.discard', '撤消失效发布包：' + pkg.name, ctx);
  }

  // 已封包条目是否在封存后被新版本替换 → 不允许带旧版本发布
  function stalePackageEntries(db, pkg) {
    var out = [];
    pkg.entries.forEach(function (e) {
      var clause = byId(db.clauses, e.clauseId);
      if (clause && clause.currentVersionId !== e.versionId) {
        out.push({ entry: e, clause: clause, currentVersion: byId(clause.versions, clause.currentVersionId) });
      }
      // 定义在封包后又被改动
      e.definitionRefs.forEach(function (did) {
        var def = byId(db.definitions, did);
        if (def && def.updatedAt > pkg.sealedAt) out.push({ entry: e, clause: clause, changedDefinition: def });
      });
    });
    return out;
  }

  function releasePackage(db, packageId, ctx) {
    var pkg = byId(db.packages, packageId);
    if (!pkg) throw new Error('发布包不存在');
    if (pkg.status === 'released') throw new Error('发布包已发布，回执不可变更');
    var stale = stalePackageEntries(db, pkg);
    if (stale.length) {
      var err = new Error('发布包内容已过期，必须解散重组');
      err.code = 'stale-package-entry';
      err.stale = stale;
      throw err;
    }
    pkg.status = 'released';
    pkg.releasedAt = ctx.now;
    pkg.releasedBy = ctx.actor || '发布同事';
    pkg.entries.forEach(function (e) {
      var clause = byId(db.clauses, e.clauseId);
      var v = byId(clause.versions, e.versionId);
      v.status = 'published';
      v.publishedAt = pkg.releasedAt;
      v.publishedRoundNo = e.roundNo; // 冻结结论轮次，之后的备案意见不改变发布快照
    });
    pkg.receipt = {
      packageId: pkg.id,
      name: pkg.name,
      releasedAt: pkg.releasedAt,
      releasedBy: pkg.releasedBy,
      itemCount: pkg.entries.length,
      entries: pkg.entries.map(function (e) {
        return { code: e.code, revision: e.revision, versionId: e.versionId, effectiveDate: e.effectiveDate, fingerprint: e.fingerprint };
      }),
      fingerprint: fingerprint({
        packageId: pkg.id,
        releasedAt: pkg.releasedAt,
        entries: pkg.entries.map(function (e) { return e.clauseId + '@' + e.versionId + '#' + e.fingerprint; })
      })
    };
    audit(db, 'package.release', '发布「' + pkg.name + '」回执 ' + pkg.receipt.fingerprint, ctx);
    return pkg;
  }

  /* ---------------- 总览 ---------------- */

  function overview(db) {
    var states = allClauseStates(db);
    var o = {
      clauses: db.clauses.length,
      ready: states.filter(function (s) { return s.state === 'ready'; }).length,
      blocked: states.filter(function (s) { return s.state === 'blocked'; }).length,
      published: states.filter(function (s) { return s.state === 'published'; }).length,
      drafts: states.filter(function (s) { return s.version.status === 'draft'; }).length,
      quarantine: quarantine(db).length,
      packagesSealed: db.packages.filter(function (p) { return p.status === 'sealed'; }).length,
      packagesReleased: db.packages.filter(function (p) { return p.status === 'released'; }).length,
      openRound: openRound(db),
      conflicts: coverageConflicts(db),
      residues: replacementResidue(db)
    };
    return o;
  }

  var engine = {
    REGIONS: REGIONS,
    VERDICTS: VERDICTS,
    BLOCKER_LABELS: BLOCKER_LABELS,
    WARNING_LABELS: WARNING_LABELS,
    createDB: createDB,
    uid: uid,
    fingerprint: fingerprint,
    stableStringify: stableStringify,
    byId: byId,
    difference: difference,
    uniq: uniq,
    audit: audit,
    upsertDefinition: upsertDefinition,
    upsertProduct: upsertProduct,
    createClause: createClause,
    updateClauseMeta: updateClauseMeta,
    saveDraft: saveDraft,
    submitForReview: submitForReview,
    withdrawSubmission: withdrawSubmission,
    followUpVersion: followUpVersion,
    createRound: createRound,
    closeRound: closeRound,
    openRound: openRound,
    collectItems: collectItems,
    recordVerdict: recordVerdict,
    impactedProducts: impactedProducts,
    computeClauseState: computeClauseState,
    allClauseStates: allClauseStates,
    coverageConflicts: coverageConflicts,
    replacementResidue: replacementResidue,
    preflight: preflight,
    quarantine: quarantine,
    sealPackage: sealPackage,
    discardSealedPackage: discardSealedPackage,
    stalePackageEntries: stalePackageEntries,
    releasePackage: releasePackage,
    overview: overview
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = engine;
  global.CH = engine;
})(typeof window !== 'undefined' ? window : globalThis);
