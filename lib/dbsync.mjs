// JSONL -> SQLite 的自动增量同步器
// 监控进程不直接写库：定时/手动启动独立导入进程，避免 SQLite 锁/迁移拖慢采集。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { ROOT, CONFIG } from './config.mjs';

export const DB_SYNC_DEFAULT_SEC = 300;
export const DB_SYNC_MIN_SEC = 60;
export const DB_SYNC_MAX_SEC = 86400;

function nodeSupportsSqlite(version = process.versions.node) {
  const [major, minor] = String(version).split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 5);
}

function envIntervalSec() {
  const raw = Number(process.env.SCUM_DB_SYNC_SEC);
  if (!Number.isFinite(raw)) return DB_SYNC_DEFAULT_SEC;
  return Math.min(DB_SYNC_MAX_SEC, Math.max(DB_SYNC_MIN_SEC, Math.trunc(raw)));
}

export class DbSyncService {
  constructor({
    dataDir = CONFIG.dataDir,
    intervalSec = envIntervalSec(),
    script = path.join(ROOT, 'tools', 'import-jsonl.mjs'),
    runImpl = null,
    logger = console,
    available = nodeSupportsSqlite(),
    enabled = !/^(0|off|false|no)$/i.test(String(process.env.SCUM_DB_SYNC || '')),
    startupDelayMs = 10000,
  } = {}) {
    this.dataDir = dataDir;
    this.intervalSec = intervalSec;
    this.intervalMs = intervalSec * 1000;
    this.script = script;
    this.runImpl = runImpl;
    this.logger = logger;
    this.available = available;
    this.enabled = enabled && available;
    this.startupDelayMs = startupDelayMs;
    this.running = false;
    this.started = false;
    this.lastStartedAt = null;
    this.lastSyncAt = null;
    this.nextSyncAt = null;
    this.lastError = enabled && !available ? '需要 Node.js 22.5+ 的 node:sqlite' : null;
    this.lastExitCode = null;
    this.lastSummary = null;
    this._firstTimer = null;
    this._timer = null;
  }

  _setNext(ms = this.intervalMs) {
    this.nextSyncAt = new Date(Date.now() + ms).toISOString();
  }

  start() {
    if (this.started) return this;
    this.started = true;
    if (!this.enabled) {
      this.logger.warn?.(
        this.available ? 'SQLite 自动同步已关闭（SCUM_DB_SYNC=0）' : 'SQLite 自动同步不可用：需要 Node.js 22.5+',
      );
      return this;
    }
    this._setNext(this.startupDelayMs);
    this._firstTimer = setTimeout(() => {
      this.trigger('startup').catch(() => {});
    }, this.startupDelayMs);
    this._timer = setInterval(() => {
      this.trigger('scheduled').catch(() => {});
    }, this.intervalMs);
    this.logger.log?.(`SQLite 自动同步已启动：每 ${Math.round(this.intervalSec / 60)} 分钟一次，启动后 ${Math.round(this.startupDelayMs / 1000)} 秒先同步一次`);
    return this;
  }

  stop() {
    if (this._firstTimer) clearTimeout(this._firstTimer);
    if (this._timer) clearInterval(this._timer);
    this._firstTimer = null;
    this._timer = null;
    this.started = false;
    return this;
  }

  _spawnImport() {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [this.script, '--quiet', `--data-dir=${this.dataDir}`], {
        cwd: ROOT,
        env: { ...process.env, SCUM_DATA_DIR: this.dataDir },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        try {
          child.kill();
        } catch {}
      }, 5 * 60 * 1000);
      child.stdout?.on('data', (b) => {
        if (stdout.length < 20000) stdout += b.toString('utf8');
      });
      child.stderr?.on('data', (b) => {
        if (stderr.length < 20000) stderr += b.toString('utf8');
      });
      child.on('error', (e) => {
        clearTimeout(timeout);
        resolve({ ok: false, code: null, error: e.message, stdout, stderr });
      });
      child.on('close', (code) => {
        clearTimeout(timeout);
        resolve({
          ok: !timedOut && code === 0,
          code,
          error: timedOut ? '导入超时（5 分钟）' : code === 0 ? null : `导入进程退出码 ${code}`,
          stdout,
          stderr,
        });
      });
    });
  }

  async trigger(reason = 'manual') {
    if (!this.available) {
      this.lastError = '需要 Node.js 22.5+ 的 node:sqlite';
      return { ok: false, error: this.lastError, status: this.status() };
    }
    if (!this.enabled) {
      this.lastError = 'SQLite 自动同步已关闭';
      return { ok: false, error: this.lastError, status: this.status() };
    }
    if (this.running) return { ok: false, running: true, error: '同步正在进行', status: this.status() };

    this.running = true;
    this.lastStartedAt = new Date().toISOString();
    this.lastError = null;
    this._setNext();
    this.logger.log?.(`SQLite 同步开始（${reason}）`);
    let result;
    try {
      result = this.runImpl ? await this.runImpl() : await this._spawnImport();
    } catch (e) {
      result = { ok: false, error: e.message, code: null, stdout: '', stderr: '' };
    }
    this.running = false;
    this.lastExitCode = result.code ?? null;
    if (result.ok) {
      this.lastSyncAt = new Date().toISOString();
      this.lastSummary = String(result.stdout || '')
        .split('\n')
        .filter((l) => l.trim())
        .slice(-8)
        .join('\n');
      this.lastError = null;
      this.logger.log?.('SQLite 同步完成');
    } else {
      const detail = String(result.stderr || result.error || '').trim().split('\n').slice(-3).join(' | ');
      this.lastError = detail || 'SQLite 同步失败';
      this.logger.warn?.('SQLite 同步失败:', this.lastError);
    }
    return { ...result, status: this.status() };
  }

  status() {
    return {
      available: this.available,
      enabled: this.enabled,
      running: this.running,
      intervalSec: this.intervalSec,
      lastStartedAt: this.lastStartedAt,
      lastSyncAt: this.lastSyncAt,
      nextSyncAt: this.nextSyncAt,
      lastError: this.lastError,
      lastExitCode: this.lastExitCode,
      lastSummary: this.lastSummary,
    };
  }
}
