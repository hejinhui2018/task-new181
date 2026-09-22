/*
 * ClauseHarbor 持久化层
 *
 * 提交采用 WAL（先写日志）三段式，任何阶段断电 / 杀进程 / 配额异常都可恢复：
 *
 *   1) 写 ch.wal（新状态完整快照 + 校验和）
 *   2) 旧主库另存 ch.backup
 *   3) 主库 ch.db 切换为新状态
 *   4) 删除 ch.wal
 *
 * 启动恢复：
 *   - wal 与 db 校验和一致 → 上次提交已完成（死在清 wal 前），清 wal；
 *   - wal 有效但 db 缺失/损坏/不一致 → 用 wal 前滚；
 *   - wal 损坏而 db 有效 → 丢弃 wal；
 *   - db 也损坏 → 回滚 backup；
 *   每次恢复都会留痕，并在界面展示一次「异常恢复」提示。
 *
 * 草稿表单独立存储（ch.draft.*），不与事务库混写，
 * 所以「保存草稿」即使在事务提交前崩溃也不丢表单内容。
 */
(function (global) {
  'use strict';

  var CH = global.CH || (typeof require === 'function' ? require('./engine.js') : global.CH);

  var K = {
    db: 'ch.db.v1',
    wal: 'ch.wal.v1',
    backup: 'ch.backup.v1',
    draftPrefix: 'ch.draft.v1.',
    recovery: 'ch.recovery.v1',
    seeded: 'ch.seeded.v1'
  };

  function makeStore(storage, clock) {
    storage = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!storage) throw new Error('没有可用的本地存储');
    clock = clock || function () { return new Date().toISOString(); };

    var fault = null; // 测试用故障注入：'wal' | 'backup' | 'commit'
    var listeners = [];

    function rawGet(key) { try { return storage.getItem(key); } catch (e) { return null; } }
    function rawSet(key, val) { storage.setItem(key, val); }
    function rawRemove(key) { storage.removeItem(key); }

    function checksum(db) { return CH.fingerprint(CH.stableStringify(db)); }

    function validDB(db) {
      return db && typeof db === 'object' && db.meta && db.meta.schema === 1 &&
        Array.isArray(db.clauses) && Array.isArray(db.rounds) && Array.isArray(db.packages);
    }

    function parse(raw) {
      if (!raw) return null;
      try { return JSON.parse(raw); } catch (e) { return null; }
    }

    var recoveryNotes = [];
    function noteRecovery(text) {
      recoveryNotes.push({ at: clock(), text: text });
      try { rawSet(K.recovery, JSON.stringify(recoveryNotes)); } catch (e) { /* 配额满也要保证主流程 */ }
    }

    /* ---------- 启动恢复链 ---------- */

    function bootstrap(seedBuilder) {
      var dbRaw = rawGet(K.db);
      var walRaw = rawGet(K.wal);
      var backupRaw = rawGet(K.backup);
      var db = parse(dbRaw);
      var wal = parse(walRaw);
      var backup = parse(backupRaw);
      var persistedNotes = parse(rawGet(K.recovery)) || [];
      recoveryNotes = persistedNotes;

      if (wal && wal.data && wal.checksum === checksum(wal.data) && validDB(wal.data)) {
        if (db && validDB(db) && checksum(db) === wal.checksum) {
          // 死在第 4 步：数据已切换，只差清 wal
          rawRemove(K.wal);
        } else {
          // 死在第 3 步前后：前滚
          if (db && validDB(db)) rawSet(K.backup, dbRaw);
          rawSet(K.db, JSON.stringify(wal.data));
          rawRemove(K.wal);
          noteRecovery('检测到未完成的写入（WAL 前滚）：已恢复到最近一次完整事务，时间点 ' + wal.at);
          db = wal.data;
        }
      } else if (walRaw) {
        // wal 损坏：以主库为准，主库坏了再找备份
        rawRemove(K.wal);
        noteRecovery('写入日志损坏，已忽略该未完成事务');
      }

      if (!validDB(db)) {
        if (validDB(backup)) {
          rawSet(K.db, JSON.stringify(backup));
          noteRecovery('主库校验失败，已回滚到上一版备份（' + backup.meta.lastSavedAt + '）');
          db = backup;
        } else {
          db = seedBuilder ? seedBuilder() : CH.createDB();
          if (!db.meta.createdAt) db.meta.createdAt = clock();
          rawSet(K.db, JSON.stringify(db));
          noteRecovery('未找到可用数据文件，已初始化空白工作台');
        }
      }

      db.meta.lastSavedAt = db.meta.lastSavedAt || clock();
      return { db: db, recovery: recoveryNotes.slice() };
    }

    function consumeRecoveryNotes() {
      var n = recoveryNotes.slice();
      recoveryNotes = [];
      rawRemove(K.recovery);
      return n;
    }

    /* ---------- 事务提交 ---------- */

    var state = null;

    function init(seedBuilder) {
      var booted = bootstrap(seedBuilder);
      state = booted.db;
      return booted;
    }

    function db() { return state; }

    function setFault(point) { fault = point; }

    function commit(label, mutator, ctx) {
      if (!state) throw new Error('存储尚未初始化');
      ctx = ctx || {};
      ctx.now = ctx.now || clock();
      ctx.actor = ctx.actor || '产品法务';
      mutator(state, ctx);
      state.meta.lastSavedAt = ctx.now;

      var payload = JSON.stringify({ at: ctx.now, label: label, checksum: checksum(state), data: state });
      // 1) WAL
      rawSet(K.wal, payload);
      if (fault === 'wal') throw new Error('故障注入：WAL 写入后崩溃');
      // 2) backup 旧主库
      var old = rawGet(K.db);
      if (old) rawSet(K.backup, old);
      if (fault === 'backup') throw new Error('故障注入：备份后崩溃');
      // 3) 切换主库
      rawSet(K.db, JSON.stringify(state));
      if (fault === 'commit') throw new Error('故障注入：主库切换后崩溃');
      // 4) 清 WAL
      rawRemove(K.wal);
      emit(label);
      return state;
    }

    function emit(label) { listeners.forEach(function (fn) { try { fn(state, label); } catch (e) {} }); }
    function onChange(fn) { listeners.push(fn); }

    /* ---------- 表单草稿（独立通道） ---------- */

    function draftKey(clauseId) { return K.draftPrefix + clauseId; }

    function saveFormDraft(clauseId, patch) {
      rawSet(draftKey(clauseId), JSON.stringify({ patch: patch, savedAt: clock() }));
    }
    function getFormDraft(clauseId) { return parse(rawGet(draftKey(clauseId))); }
    function listFormDrafts() {
      var out = [];
      for (var i = 0; i < storage.length; i++) {
        var key = storage.key(i);
        if (key && key.indexOf(K.draftPrefix) === 0) {
          var d = parse(rawGet(key));
          if (d) out.push({ clauseId: key.slice(K.draftPrefix.length), savedAt: d.savedAt, patch: d.patch });
        }
      }
      return out;
    }
    function clearFormDraft(clauseId) { rawRemove(draftKey(clauseId)); }

    /* ---------- 导入导出 / 回执校验 ---------- */

    function exportJSON() {
      return JSON.stringify({ exportedAt: clock(), checksum: checksum(state), db: state }, null, 2);
    }

    function importJSON(text, ctx) {
      var parsed = parse(text);
      var incoming = parsed && parsed.db;
      if (!validDB(incoming)) throw new Error('文件不是有效的 ClauseHarbor 工作台备份');
      if (parsed.checksum && parsed.checksum !== checksum(incoming)) throw new Error('备份校验和不一致，文件可能被改动');
      return commit('import', function (db) {
        var fresh = incoming;
        Object.keys(db).forEach(function (k) { delete db[k]; });
        Object.keys(fresh).forEach(function (k) { db[k] = fresh[k]; });
      }, ctx);
    }

    function resetAll(seedBuilder, ctx) {
      [K.db, K.wal, K.backup, K.recovery].forEach(rawRemove);
      var draftKeys = [];
      for (var i = 0; i < storage.length; i++) {
        var key = storage.key(i);
        if (key && key.indexOf(K.draftPrefix) === 0) draftKeys.push(key);
      }
      draftKeys.forEach(rawRemove);
      var fresh = seedBuilder ? seedBuilder() : CH.createDB();
      if (!fresh.meta.createdAt) fresh.meta.createdAt = clock();
      rawSet(K.db, JSON.stringify(fresh));
      state = fresh;
      emit('reset');
      return state;
    }

    // 用封包时保存的快照重算指纹，验证发布回执未被篡改 / 刷新后仍一一对应
    function verifyPackageReceipt(pkg) {
      if (!pkg || !pkg.receipt) return { ok: false, reason: '缺少回执' };
      var entryResults = pkg.entries.map(function (e) {
        var recomputed = CH.fingerprint(CH.stableStringify({
          clauseId: e.clauseId,
          code: e.code,
          versionId: e.versionId,
          revision: e.revision,
          title: e.title,
          content: e.contentSnapshot,
          coverage: e.coverage,
          effectiveDate: e.effectiveDate,
          definitionRefs: e.definitionRefs,
          approvedRegions: e.approvedRegions,
          latestRoundNo: e.roundNo
        }));
        return { code: e.code, revision: e.revision, ok: recomputed === e.fingerprint, expected: e.fingerprint, actual: recomputed };
      });
      var receiptRecomputed = CH.fingerprint(CH.stableStringify({
        packageId: pkg.id,
        releasedAt: pkg.receipt.releasedAt,
        entries: pkg.entries.map(function (e) { return e.clauseId + '@' + e.versionId + '#' + e.fingerprint; })
      }));
      return {
        ok: entryResults.every(function (r) { return r.ok; }) && receiptRecomputed === pkg.receipt.fingerprint,
        entries: entryResults,
        receiptFingerprint: pkg.receipt.fingerprint,
        receiptActual: receiptRecomputed
      };
    }

    return {
      keys: K,
      init: init,
      db: db,
      commit: commit,
      onChange: onChange,
      setFault: setFault,
      consumeRecoveryNotes: consumeRecoveryNotes,
      saveFormDraft: saveFormDraft,
      getFormDraft: getFormDraft,
      listFormDrafts: listFormDrafts,
      clearFormDraft: clearFormDraft,
      exportJSON: exportJSON,
      importJSON: importJSON,
      resetAll: resetAll,
      verifyPackageReceipt: verifyPackageReceipt,
      checksum: checksum
    };
  }

  var Store = { makeStore: makeStore, KEYS: K };
  if (typeof module !== 'undefined' && module.exports) module.exports = Store;
  global.CHStore = Store;
})(typeof window !== 'undefined' ? window : globalThis);
