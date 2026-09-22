'use strict';
// 持久化：快照（原子写 tmp+rename）+ JSONL WAL 重放 + 异常恢复。
const fs = require('fs');
const path = require('path');
const domain = require('./domain');

class Store {
  constructor(dir) {
    this.dir = dir;
    this.snapshotPath = path.join(dir, 'snapshot.json');
    this.prevSnapshotPath = path.join(dir, 'snapshot.prev.json');
    this.tmpSnapshotPath = path.join(dir, 'snapshot.json.tmp');
    this.walPath = path.join(dir, 'wal.log');
    this.tmpWalPath = path.join(dir, 'wal.log.tmp');
    this.state = null;
    this.appliedSeq = 0;
    this.snapshotEvery = 50;   // 每 50 条命令压缩一次快照
    this.commandsSinceSnapshot = 0;
    fs.mkdirSync(dir, { recursive: true });
    this._load();
  }

  _load() {
    const events = [];
    let base = null;
    let baseSeq = 0;
    let usedPrev = false;

    // 1) 读快照（当前代损坏 → 隔离并回退上一代）
    const readSnap = (file, label) => {
      try {
        const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!snap.state || typeof snap.seq !== 'number') throw new Error('快照结构不完整');
        return snap;
      } catch (e) {
        const quar = path.join(this.dir, `${label}-corrupt-${Date.now()}.json`);
        try { fs.renameSync(file, quar); } catch (_) {}
        events.push({ kind: label === 'snapshot' ? 'snapshot_corrupt' : 'prev_snapshot_corrupt', detail: e.message, quarantined: quar });
        return null;
      }
    };

    if (fs.existsSync(this.snapshotPath)) {
      const snap = readSnap(this.snapshotPath, 'snapshot');
      if (snap) { base = snap.state; baseSeq = snap.seq; }
      else if (fs.existsSync(this.prevSnapshotPath)) {
        const prev = readSnap(this.prevSnapshotPath, 'snapshot.prev');
        if (prev) { base = prev.state; baseSeq = prev.seq; usedPrev = true; }
      }
    } else if (fs.existsSync(this.prevSnapshotPath)) {
      const prev = readSnap(this.prevSnapshotPath, 'snapshot.prev');
      if (prev) { base = prev.state; baseSeq = prev.seq; usedPrev = true; }
    }

    // 2) 读 WAL；容忍末尾截断（崩溃写到一半）—— 丢弃最后一条不完整行
    let entries = [];
    if (fs.existsSync(this.walPath)) {
      const lines = fs.readFileSync(this.walPath, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line);
          if (!rec.seq || !rec.type) throw new Error('WAL 记录缺少字段');
          entries.push(rec);
        } catch (e) {
          // 最后一行损坏：视为崩溃截断；中间损坏：同样跳过但记录
          events.push({
            kind: 'wal_truncated',
            detail: `第 ${i + 1} 行无法解析，已跳过：${e.message}`,
            linePreview: line.slice(0, 80),
            last: i === lines.length - 1 || lines.slice(i + 1).every((x) => !x.trim()),
          });
        }
      }
      // seq 排序并过滤已在快照内的
      entries.sort((a, b) => a.seq - b.seq);
      entries = entries.filter((e) => e.seq > baseSeq);
    }

    // 3) 构建状态并重放
    if (!base) {
      base = domain.emptyState();
      if (!fs.existsSync(this.snapshotPath) && !fs.existsSync(this.walPath)) {
        events.push({ kind: 'fresh_start', detail: '未发现历史数据，初始化空工作台' });
      } else {
        events.push({ kind: 'rebuild_from_wal', detail: '快照不可用，已从操作日志重建状态' });
      }
    }
    this.state = base;
    const applied = [];
    for (const e of entries) {
      try {
        domain.replayWithCaptured(this.state, [e]);
        this.appliedSeq = e.seq;
        applied.push(e);
      } catch (err) {
        events.push({ kind: 'replay_failed', detail: `seq ${e.seq} (${e.type}) 重放失败：${err.message}；该条及其后日志未应用` });
        break;
      }
    }
    this.commandsSinceSnapshot = applied.length;

    // 4) 恢复事件落进状态（内存），并重建一个干净 WAL（去掉损坏尾部）
    for (const ev of events) {
      if (ev.kind === 'fresh_start') continue; // 全新启动不算异常事件
      const rec = { id: domain.uid('rec'), at: domain.nowIso(), ...ev };
      this.state.recoveryEvents.push(rec);
    }
    if (events.length && !events.some((e) => e.kind === 'replay_failed')) {
      // 成功重建后压缩：重写 WAL 去掉坏行、轮换快照代际
      this._forceSnapshot();
    }
  }

  // 执行命令：在状态副本上执行校验并捕获 id/时间序列 → 追加 WAL → 提交内存状态。
  // 任一步失败，磁盘与内存都保持上一条命令后的一致状态。
  dispatch(type, args) {
    const seq = this.appliedSeq + 1;
    const scratch = JSON.parse(JSON.stringify(this.state));
    const exec = domain.executeCommand(scratch, type, args);
    const rec = { seq, at: domain.nowIso(), type, args, captured: exec.captured };
    fs.appendFileSync(this.walPath, JSON.stringify(rec) + '\n');
    this.state = scratch;
    this.appliedSeq = seq;
    this.commandsSinceSnapshot++;
    if (this.commandsSinceSnapshot >= this.snapshotEvery) this._forceSnapshot();
    return exec.result;
  }

  // 也支持“先校验不落盘”的 dryRun（创建发布包前预览隔离区可用）
  preview(type, args) {
    const snapshotState = JSON.stringify(this.state);
    try {
      return domain.executeCommand(this.state, type, args).result;
    } finally {
      this.state = JSON.parse(snapshotState);
    }
  }

  _forceSnapshot() {
    // 代际轮换：snapshot.json -> snapshot.prev.json -> 安装新 snapshot.json；
    // WAL 只截断到“上一代快照”已覆盖的位置，因此新一代快照损坏时仍可靠 prev + WAL 重建。
    let prevCoveredSeq = 0;
    if (fs.existsSync(this.prevSnapshotPath)) {
      try { prevCoveredSeq = JSON.parse(fs.readFileSync(this.prevSnapshotPath, 'utf8')).seq || 0; } catch (_) { prevCoveredSeq = 0; }
    }
    if (fs.existsSync(this.snapshotPath)) {
      fs.renameSync(this.snapshotPath, this.prevSnapshotPath);
      prevCoveredSeq = 0; // 轮换后旧当前代成为 prev，其 seq 在下面读取
      try { prevCoveredSeq = JSON.parse(fs.readFileSync(this.prevSnapshotPath, 'utf8')).seq || 0; } catch (_) {}
    }
    const snap = { seq: this.appliedSeq, at: domain.nowIso(), state: this.state };
    const tmp = this.tmpSnapshotPath + '.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(snap));
    fs.renameSync(tmp, this.snapshotPath);
    // 重写 WAL：只保留上一代快照未覆盖的记录
    const keep = [];
    if (fs.existsSync(this.walPath)) {
      for (const line of fs.readFileSync(this.walPath, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line);
          if (typeof rec.seq === 'number' && rec.seq > prevCoveredSeq) keep.push(line);
        } catch (_) { /* 坏行在装载阶段已被处理，这里不再保留 */ }
      }
    }
    const wtmp = this.tmpWalPath + '.' + process.pid;
    fs.writeFileSync(wtmp, keep.join('\n') + (keep.length ? '\n' : ''));
    fs.renameSync(wtmp, this.walPath);
    this.commandsSinceSnapshot = 0;
  }

  forceCheckpoint() { this._forceSnapshot(); }

  // 重新执行装载流程（异常恢复演练用，等价于进程重启）
  reload() { this._load(); return this.state; }

  // 测试辅助：模拟崩溃场景
  _debugCorruptSnapshot() { fs.writeFileSync(this.snapshotPath, '{ this is not json'); }
  _debugTruncateWalTail() {
    const buf = fs.readFileSync(this.walPath);
    fs.appendFileSync(this.walPath, '{"seq":99999,"type":"broken');
    void buf;
  }
}

module.exports = { Store };
