import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { spawn, execFile, ChildProcess } from 'child_process';
import { loadSettings } from '../settingsStore.js';
import { appendAccount } from '../accountStore.js';
import type { AccountRecord, LogLevel, RunEvent, RunPhase, RunStatus } from '@shared/runEvents';
import { EMPTY_STATUS } from '@shared/runEvents';
import type { AppSettings } from '@shared/settings';
import fs from 'fs';
import path from 'path';
import { resolveRegisterRuntime, writeConfigForPython } from './registerRuntime.js';
import { syncCfwpFromSettings } from '../cfwpManager.js';

interface StartOptions {
  runCountOverride?: number;
  /** 并行 worker 上限覆盖；默认读 settings.maxParallelWorkers */
  maxParallelOverride?: number;
}

/** 任务摘要（列表浏览用） */
export interface RegisterJobSummary {
  runId: string;
  phase: RunPhase;
  pid: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  current: number;
  total: number;
  success: number;
  failed: number;
  errorMessage: string | null;
  focused: boolean;
}

interface Job {
  runId: string;
  status: RunStatus;
  shouldStop: boolean;
  childProcess: ChildProcess | null;
  childDetached: boolean;
  killEscalationTimer: ReturnType<typeof setTimeout> | null;
  killHardTimer: ReturnType<typeof setTimeout> | null;
  currentSsoFile: string | null;
  pendingAccount: { email?: string; password?: string };
}

const DEFAULT_MAX_PARALLEL = 3;
const HARD_MAX_PARALLEL = 8;

function isActivePhase(phase: RunPhase): boolean {
  return phase === 'starting' || phase === 'running';
}

/**
 * UI 无需展示的冗长调试行（进度/成功/失败仍会先解析，再决定是否 hide）。
 * 来源：邮件创建、重定向轮询、mint 细节、代理轮换、grok2api 中间步骤等。
 */
function isNoiseStdoutLine(msg: string): boolean {
  const m = String(msg || '').trim();
  if (!m) return true;
  // 纯时间戳行
  if (/^\d{2}:\d{2}:\d{2}$/.test(m)) return true;
  // 代理诊断/注入结果必须可见（排查「开了代理却直连」）
  if (/^\[proxy\]/i.test(m) || /代理配置失败|本地转发失败|未拿到节点|误直连/i.test(m)) {
    return false;
  }
  const rules: RegExp[] = [
    /邮件\s*API\s*:/i,
    /email_register\s+build/i,
    /邮箱域名池\s*:/,
    /邮箱创建成功\s*:/,
    /等待重定向到\s*grok\.com/i,
    /已追加写入.*(?:sso|SSO).*到文件/,
    /\[auth\]\s*SSO\s*[→\-].*mint/i,
    /\[auth\]\s*SSO→CPA\s*mint/i,
    /access_token\s*referrer/i,
    /access_token\s*\(expires_in/i,
    /\[auth\]\s*wrote\s+/i,
    /\[auth\]\s*probe\s+action=/i,
    /\[auth\]\s*access_token/i,
    /\[grok2api\]\s*Updating\s+Web\s+egress/i,
    /\[grok2api\]\s*Uploading\s+SSO\s+mode=/i,
    /代理注册成功计数\s*\+/i,
    /可用池成功计数\s*\+/i,
    /复用已有\s*DISPLAY\s*=/i,
    /代理池\s*:\s*\d+\s*条/i,
    /本轮代理\s*IP\s*键\s*:/i,
    // 成功注入细节可藏；失败 [proxy][!] 与启动 [proxy] 摘要必须可见（下方白名单）
    /浏览器代理\s*\(\s*本轮/i,
    /本轮特征\s*:/i,
    /当前使用代理\s*:/i,
    /代理降级未生效:\s*未匹配到可用池/i,
    // mint 软重试细节
    /\[auth\]\s*probe.*soft_/i,
    // ── 启动/环境调试（用户要求隐藏）──
    /注册脚本目录\s*:/,
    /注册机入口\s*:/,
    // 本轮代理行：不推前端（代理切换仍有「已降级并切换」等业务日志）
    /\[\*?\]\s*本轮代理\s*:/,
    /^\*\]\s*本轮代理\s*:/,
    /本轮代理\s*:\s*`?https?:\/\//i,
    /本轮代理\s*\(Plan\s*B\)\s*:/i,
    /支持带密码\s*HTTP\s*代理/i,
    /扩展\/本地转发/,
    /浏览器路径\s*:/,
    /turnstilePatch/i,
    /日志文件\s*:/,
    /\(启动前\)/,
    /SSO\s*输出\s*:/,
    /指纹探测\s*machine\s*=/i,
    /ARM\s*风险/i,
    /Turnstile\s*更容易给\s*failure/i,
    /DISPLAY\s*=/,
    /XDG_SESSION_TYPE\s*=/,
    /WAYLAND_DISPLAY\s*=/,
    /\[\*?\]\s*UA\s*:/i,
    /^\*?\]?\s*UA\s*:/i,
    /Mozilla\/5\.0\s*\(/i,
    /platform\s*=\s*['"]?Linux/i,
    /webdriver\s*=/i,
    /\bhw\s*=\s*\d+/i,
    /\bmem\s*=\s*\d+/i,
    /langs\s*=\s*\[/,
    /screen\s*=\s*\d+x\d+/i,
    /avail\s*=\s*\d+x\d+/i,
    /\bdepth\s*=\s*\d+/i,
    /\bdpr\s*=\s*[\d.]+/i,
    /WebGL\s*OK/i,
    /WebGL\s*unmasked/i,
    /unmasked\s*vendor\s*=/i,
    /renderer\s*=\s*['"]?(?:WebKit|ANGLE)/i,
    /vendor\s*=\s*['"]WebKit['"]/i,
    /version\s*=\s*['"]WebGL/i,
    // 路径类噪声（仅启动信息；避免误伤业务错误）
    /浏览器路径\s*:.*chromium/i,
    /\/usr\/bin\/chromium/i,
    /logs\/run_\d{8}_\d{6}/i,
    /SSO\s*输出\s*:.*\/sso\//i
  ];
  return rules.some((re) => re.test(m));
}

export class RegisterBot extends EventEmitter {
  private jobs = new Map<string, Job>();
  /** 前端「聚焦」任务：日志/状态默认展示这个；空则取最近活跃 */
  private focusRunId: string | null = null;
  private replayBuffer: RunEvent[] = [];
  private static readonly REPLAY_LIMIT = 2000;

  getStatus(): RunStatus {
    const job = this.resolveFocusJob();
    return job ? { ...job.status } : { ...EMPTY_STATUS };
  }

  /** 并行任务列表（新→旧） */
  listJobs(): RegisterJobSummary[] {
    const focus = this.focusRunId;
    const list = [...this.jobs.values()]
      .map((j) => ({
        runId: j.runId,
        phase: j.status.phase,
        pid: j.status.pid,
        startedAt: j.status.startedAt,
        finishedAt: j.status.finishedAt,
        current: j.status.current,
        total: j.status.total,
        success: j.status.success,
        failed: j.status.failed,
        errorMessage: j.status.errorMessage,
        focused: j.runId === focus || (!focus && j === this.resolveFocusJob())
      }))
      .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    return list;
  }

  getJobStatus(runId: string): RunStatus | null {
    const job = this.jobs.get(runId);
    return job ? { ...job.status } : null;
  }

  setFocus(runId: string | null): { ok: boolean; runId: string | null } {
    if (runId && !this.jobs.has(runId)) {
      return { ok: false, runId: this.focusRunId };
    }
    this.focusRunId = runId;
    return { ok: true, runId: this.focusRunId };
  }

  activeCount(): number {
    let n = 0;
    for (const j of this.jobs.values()) {
      if (isActivePhase(j.status.phase)) n++;
    }
    return n;
  }

  /** 解析最终使用的注册脚本目录 */
  resolveRegisterDir(configured?: string): string | null {
    return resolveRegisterRuntime({ registerDir: configured })?.registerDir ?? null;
  }

  getReplay(): RunEvent[] {
    return this.replayBuffer.slice();
  }

  private resolveFocusJob(): Job | null {
    if (this.focusRunId) {
      const j = this.jobs.get(this.focusRunId);
      if (j) return j;
    }
    // 优先活跃任务，否则最近启动的
    let best: Job | null = null;
    for (const j of this.jobs.values()) {
      if (isActivePhase(j.status.phase)) {
        if (!best || (j.status.startedAt || 0) > (best.status.startedAt || 0)) best = j;
      }
    }
    if (best) return best;
    for (const j of this.jobs.values()) {
      if (!best || (j.status.startedAt || 0) > (best.status.startedAt || 0)) best = j;
    }
    return best;
  }

  private push(ev: RunEvent) {
    this.replayBuffer.push(ev);
    if (this.replayBuffer.length > RegisterBot.REPLAY_LIMIT) {
      this.replayBuffer.splice(0, this.replayBuffer.length - RegisterBot.REPLAY_LIMIT);
    }
    this.emit('event', ev);
  }

  private log(runId: string, text: string, level: LogLevel = 'info') {
    this.push({ type: 'stdout', runId, level, text, ts: Date.now() });
  }

  private error(runId: string, text: string) {
    this.push({ type: 'stderr', runId, text, ts: Date.now() });
  }

  private pruneFinishedJobs(keep = 30) {
    const finished = [...this.jobs.values()]
      .filter((j) => !isActivePhase(j.status.phase))
      .sort((a, b) => (b.status.finishedAt || 0) - (a.status.finishedAt || 0));
    if (finished.length <= keep) return;
    for (const j of finished.slice(keep)) {
      if (this.focusRunId === j.runId) this.focusRunId = null;
      this.jobs.delete(j.runId);
    }
  }

  /**
   * 清理已停止/完成/失败的任务（从队列移除，不杀进程）。
   * 保留 running/starting；若当前聚焦被删则切到最近活跃或 null。
   */
  clearFinishedJobs(): { ok: true; removed: number; removedIds: string[] } {
    const removedIds: string[] = [];
    for (const j of [...this.jobs.values()]) {
      if (isActivePhase(j.status.phase)) continue;
      removedIds.push(j.runId);
      this.jobs.delete(j.runId);
    }
    if (this.focusRunId && !this.jobs.has(this.focusRunId)) {
      this.focusRunId = null;
      // 若有活跃任务，聚焦最近启动的
      let best: Job | null = null;
      for (const j of this.jobs.values()) {
        if (!isActivePhase(j.status.phase)) continue;
        if (!best || (j.status.startedAt || 0) > (best.status.startedAt || 0)) best = j;
      }
      if (best) this.focusRunId = best.runId;
    }
    // 顺带裁剪已无对应 job 的旧日志缓冲（整表重放仍有上限）
    if (removedIds.length > 0) {
      const keep = new Set(this.jobs.keys());
      this.replayBuffer = this.replayBuffer.filter((ev) => {
        const rid = (ev as { runId?: string }).runId;
        return !rid || keep.has(rid);
      });
    }
    return { ok: true, removed: removedIds.length, removedIds };
  }

  async start(opts: StartOptions = {}): Promise<{ runId: string }> {
    const settings = await loadSettings();
    // CF 独立代理：开注册前确保 cfwp 已按配置运行
    if (settings.cfProxyEnabled) {
      const st = await syncCfwpFromSettings(settings);
      if (!st.running && process.platform !== 'win32') {
        throw new Error(
          st.lastError ||
            'CF 独立代理未运行：请检查域名/token 与 register/bin/cfwp 二进制后保存设置再试'
        );
      }
      if (process.platform === 'win32' && st.lastError) {
        console.warn('[registerBot] cfwp on Windows:', st.lastError);
      }
    }
    const runCount = opts.runCountOverride ?? settings.runCount;
    const maxParallel = Math.min(
      HARD_MAX_PARALLEL,
      Math.max(
        1,
        opts.maxParallelOverride ??
          (Number.isFinite(Number(settings.maxParallelWorkers))
            ? Math.floor(Number(settings.maxParallelWorkers))
            : DEFAULT_MAX_PARALLEL)
      )
    );

    const active = this.activeCount();
    if (active >= maxParallel) {
      throw new Error(
        `并行任务已达上限 ${maxParallel}（当前活跃 ${active}）。请先停止部分任务，或在配置中提高并行上限。`
      );
    }

    const runId = randomUUID();
    const job: Job = {
      runId,
      status: {
        ...EMPTY_STATUS,
        phase: 'starting',
        runId,
        startedAt: Date.now(),
        total: runCount
      },
      shouldStop: false,
      childProcess: null,
      childDetached: false,
      killEscalationTimer: null,
      killHardTimer: null,
      currentSsoFile: null,
      pendingAccount: {}
    };
    this.jobs.set(runId, job);
    this.focusRunId = runId;
    this.pruneFinishedJobs();

    this.push({
      type: 'started',
      runId,
      pid: process.pid,
      total: runCount
    });
    this.log(
      runId,
      `并行任务启动 #${runId.slice(0, 8)} · 轮数 ${runCount} · 活跃 ${active + 1}/${maxParallel}`
    );

    // Fire and forget
    this.runPython(job, runCount, settings).catch((e) => {
      this.error(runId, `Runner error: ${e instanceof Error ? e.message : String(e)}`);
      this.finalizeRun(runId, false);
    });

    return { runId };
  }

  /** 停止指定任务；不传 runId 则停聚焦任务；stopAll=true 停全部活跃 */
  async stop(runId?: string, opts?: { stopAll?: boolean }): Promise<{ ok: boolean; stopped: string[] }> {
    const stopped: string[] = [];
    if (opts?.stopAll) {
      for (const j of this.jobs.values()) {
        if (isActivePhase(j.status.phase)) {
          await this.stopJob(j);
          stopped.push(j.runId);
        }
      }
      return { ok: true, stopped };
    }

    const id = (runId || this.focusRunId || this.resolveFocusJob()?.runId || '').trim();
    if (!id) return { ok: true, stopped };
    const job = this.jobs.get(id);
    if (!job) return { ok: false, stopped };
    if (!isActivePhase(job.status.phase) && !job.childProcess) {
      return { ok: true, stopped };
    }
    await this.stopJob(job);
    stopped.push(id);
    return { ok: true, stopped };
  }

  private async stopJob(job: Job): Promise<void> {
    job.shouldStop = true;
    const runId = job.runId;
    if (!job.childProcess && !isActivePhase(job.status.phase)) return;

    this.log(runId, '收到停止指令，正在强制终止注册进程（含浏览器子进程）…');
    job.status.phase = 'killed';

    this.clearKillTimers(job);
    this.killChildTree(job, 'SIGTERM');
    job.killEscalationTimer = setTimeout(() => {
      if (job.childProcess) {
        this.log(runId, '进程未退出，升级为 SIGKILL…');
        this.killChildTree(job, 'SIGKILL');
      }
    }, 800);
    job.killHardTimer = setTimeout(() => {
      if (!job.childProcess) return;
      this.error(runId, '强制停止超时，直接结束任务状态');
      try {
        job.childProcess.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      job.childProcess = null;
      if (this.jobs.get(runId) === job) {
        this.finalizeRun(runId, true);
      }
    }, 2500);
  }

  private clearKillTimers(job: Job) {
    if (job.killEscalationTimer) {
      clearTimeout(job.killEscalationTimer);
      job.killEscalationTimer = null;
    }
    if (job.killHardTimer) {
      clearTimeout(job.killHardTimer);
      job.killHardTimer = null;
    }
  }

  private killChildTree(job: Job, signal: NodeJS.Signals = 'SIGKILL') {
    const child = job.childProcess;
    if (!child?.pid) return;
    const pid = child.pid;

    if (process.platform === 'win32') {
      try {
        execFile(
          'taskkill',
          ['/pid', String(pid), '/T', '/F'],
          { windowsHide: true },
          () => undefined
        );
      } catch {
        try {
          child.kill(signal);
        } catch {
          /* ignore */
        }
      }
      return;
    }

    if (job.childDetached) {
      try {
        process.kill(-pid, signal);
        return;
      } catch {
        /* fall through */
      }
    }

    try {
      execFile('pkill', ['-P', String(pid)], { timeout: 1500 }, () => undefined);
    } catch {
      /* ignore */
    }
    try {
      child.kill(signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        /* ignore */
      }
    }
  }

  private finalizeRun(runId: string, success: boolean) {
    const job = this.jobs.get(runId);
    if (!job) return;
    this.clearKillTimers(job);
    job.status.phase = job.shouldStop ? 'killed' : success ? 'done' : 'error';
    job.status.finishedAt = Date.now();
    this.push({
      type: 'exit',
      runId,
      code: success ? 0 : 1,
      signal: job.shouldStop ? 'SIGTERM' : null,
      killed: job.shouldStop
    });
    job.childDetached = false;
    job.childProcess = null;
  }

  private async runPython(job: Job, count: number, settings: AppSettings) {
    const runId = job.runId;
    job.status.phase = 'running';

    const runtime = resolveRegisterRuntime(settings);
    if (!runtime) {
      throw new Error(
        '未找到内置注册脚本目录 register/（需含 runner.py 或 DrissionPage_example.py）。' +
          '若使用 Docker：请勿用空的 ./register 挂载覆盖 /app/register；' +
          '默认只用 ./data:/data。热更新请挂载完整 register 源码目录。'
      );
    }

    const { registerDir, scriptPath, pythonPath, entrypoint } = runtime;

    // 并行时 config 共用；count 走 CLI，避免互相覆盖轮数
    writeConfigForPython(registerDir, settings, count);
    // 启动时在任务日志打一行代理摘要（与 Python [proxy] 双保险）
    try {
      const pe = settings.proxyEnabled === true;
      const cf = (settings as { cfProxyEnabled?: boolean }).cfProxyEnabled === true;
      const poolOn = settings.proxyPoolEnabled === true;
      const aliveN = String(settings.proxyPoolAlive || '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#')).length;
      const pendingN = String(settings.proxyPool || '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#')).length;
      const poolN = aliveN > 0 ? aliveN : pendingN;
      const single = String(settings.proxy || settings.browserProxy || '').trim();
      const mode = cf
        ? 'cf'
        : !pe
          ? 'direct'
          : poolOn || poolN > 0
            ? 'pool'
            : single
              ? 'single'
              : 'empty';
      this.log(
        runId,
        `[proxy] 启动写入 config: mode=${mode} enabled=${pe || cf} ` +
          `alive≈${aliveN} pending≈${pendingN} single=${!!single} poolSwitch=${poolOn}` +
          (mode === 'direct'
            ? '（直连：若需代理请打开「启用代理」并保存）'
            : mode === 'empty'
              ? '（已启用但无节点：Python 将停止，避免误直连）'
              : '')
      );
    } catch {
      /* ignore */
    }

    const ssoOutDir = this.resolveSsoOutDir();
    if (!fs.existsSync(ssoOutDir)) {
      fs.mkdirSync(ssoOutDir, { recursive: true });
    }
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const timeStr = new Date().toISOString().slice(11, 19).replace(/:/g, '');
    const ssoFile = path.join(
      ssoOutDir,
      `sso_${dateStr}_${timeStr}_${runId.slice(0, 8)}.txt`
    );
    job.currentSsoFile = ssoFile;

    // 脚本目录/入口仅写服务端控制台，不推前端日志（用户要求隐藏）
    console.log(`[registerBot] run=${runId} dir=${registerDir} entry=${entrypoint}`);

    const args = ['-u', scriptPath, '--count', String(count), '--output', ssoFile];

    await new Promise<void>((resolve) => {
      const useDetach = process.platform !== 'win32';
      const child = spawn(pythonPath, args, {
        cwd: registerDir,
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUNBUFFERED: '1',
          GROK_RUN_ID: runId,
          // 代理成功计数 / 降级回调鉴权（与 Node requireApiAuth 共享）
          GRA_INTERNAL_KEY: process.env.GRA_INTERNAL_KEY || '',
          GRA_API_BASE:
            process.env.GRA_API_BASE ||
            process.env.GRA_SERVER_URL ||
            `http://127.0.0.1:${process.env.PORT || 6657}`
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: useDetach
      });

      job.childProcess = child;
      job.childDetached = useDetach;
      if (child.pid) {
        job.status.pid = child.pid;
      }

      child.stdout?.on('data', (data: Buffer) => {
        const text = data.toString('utf-8').trim();
        if (!text) return;
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          this.parsePythonOutput(job, trimmed, count);
        }
      });

      child.stderr?.on('data', (data: Buffer) => {
        const text = data.toString('utf-8').trim();
        if (!text) return;
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          this.error(runId, trimmed);
        }
      });

      child.on('close', (code) => {
        job.childProcess = null;
        this.clearKillTimers(job);
        this.extractSsoFromFile(runId, ssoFile);
        if (code === 0 || job.shouldStop) {
          this.finalizeRun(runId, true);
          resolve();
        } else {
          this.finalizeRun(runId, false);
          resolve();
        }
      });

      child.on('error', (err) => {
        job.childProcess = null;
        this.clearKillTimers(job);
        this.error(runId, `Python 进程启动失败: ${err.message}`);
        this.finalizeRun(runId, false);
        resolve();
      });
    });
  }

  private parsePythonOutput(job: Job, line: string, total: number) {
    const runId = job.runId;
    let msg = line;
    const tsMatch = msg.match(/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s*\|\s*(.*)/);
    if (tsMatch) msg = tsMatch[1];

    if (/^[═─]+$/.test(msg.trim())) return;

    const roundMatch = msg.match(/第\s*(\d+)/);
    if (roundMatch && msg.includes('轮') && !msg.includes('成功') && !msg.includes('失败')) {
      const current = parseInt(roundMatch[1], 10);
      job.status.current = current;
      job.pendingAccount = {};
      this.push({ type: 'progress', runId, current, total });
    }

    const emailMatch =
      msg.match(/已填写邮箱并点击注册:\s*(\S+)/) || msg.match(/本轮注册完成，邮箱:\s*(\S+)/);
    if (emailMatch) {
      job.pendingAccount.email = emailMatch[1];
    }

    const passwordMatch = msg.match(/已填写注册资料并点击完成注册:\s*\S+\s+\S+\s*\/\s*(.+)$/);
    if (passwordMatch) {
      job.pendingAccount.password = passwordMatch[1].trim();
    }

    const isRoundSuccess =
      (/[✔✅✓]/.test(msg) || msg.includes('轮成功')) &&
      msg.includes('成功') &&
      /第\s*\d+/.test(msg) &&
      !msg.includes('失败') &&
      !msg.includes('跳过');
    if (isRoundSuccess) {
      job.status.success++;
      this.push({
        type: 'success',
        runId,
        success: job.status.success,
        failed: job.status.failed,
        total
      });
      this.recordAccount(job);
    }

    // 失败/跳过均计入「失败」：Python 常用「✘ 第 N 轮跳过」不含「失败」字样
    const isRoundFail =
      /第\s*\d+/.test(msg) &&
      ((/[✘❌✕]/.test(msg) ||
        msg.includes('轮失败') ||
        msg.includes('轮跳过') ||
        /第\s*\d+\s*轮\s*(失败|跳过)/.test(msg)) &&
        (msg.includes('失败') || msg.includes('跳过'))) &&
      !msg.includes('轮成功') &&
      !isRoundSuccess;
    if (isRoundFail) {
      job.status.failed++;
      job.pendingAccount = {};
      this.push({
        type: 'failed',
        runId,
        success: job.status.success,
        failed: job.status.failed,
        total
      });
    }

    // 噪声行：不写 UI 日志（进度/成功/失败事件已在上面处理）
    if (isNoiseStdoutLine(msg)) return;

    if (isRoundFail || msg.startsWith('✘') || msg.includes('[Error]') || msg.includes('失败')) {
      this.error(runId, msg);
    } else {
      this.log(runId, msg);
    }
  }

  private recordAccount(job: Job) {
    const runId = job.runId;
    const { email, password } = job.pendingAccount;
    job.pendingAccount = {};
    if (!email && !password) return;

    let sso = '';
    let fileEmail = '';
    let filePassword = '';
    try {
      if (job.currentSsoFile && fs.existsSync(job.currentSsoFile)) {
        const lines = fs
          .readFileSync(job.currentSsoFile, 'utf-8')
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l.length > 0);
        if (lines.length > 0) {
          const last = lines[lines.length - 1];
          if (last.includes(' | ')) {
            const parts = last.split(' | ').map((p) => p.trim());
            fileEmail = parts[0] || '';
            filePassword = parts[1] || '';
            sso = parts.slice(2).join(' | ').replace(/^sso=/i, '');
          } else if (last.includes('----')) {
            const parts = last.split('----');
            fileEmail = (parts[0] || '').trim();
            filePassword = (parts[1] || '').trim();
            sso = parts.slice(2).join('----').trim().replace(/^sso=/i, '');
          } else {
            sso = last.replace(/^sso=/i, '');
          }
        }
      }
    } catch {
      /* ignore */
    }

    const record: AccountRecord = {
      id: randomUUID(),
      runId,
      email: email || fileEmail || '',
      password: password || filePassword || '',
      sso,
      createdAt: new Date().toISOString()
    };

    this.push({ type: 'account', runId, record });
    void appendAccount(record).catch((e) => {
      this.error(runId, `账号记录写入失败: ${e instanceof Error ? e.message : String(e)}`);
    });
  }

  private extractSsoFromFile(runId: string, ssoFile: string) {
    try {
      if (!fs.existsSync(ssoFile)) return;
      const content = fs.readFileSync(ssoFile, 'utf-8');
      const lines = content.split('\n').filter((l) => l.trim());
      for (const line of lines) {
        let token = line.trim();
        if (token.includes(' | ')) {
          const parts = token.split(' | ').map((p) => p.trim());
          token = parts.slice(2).join(' | ') || parts[parts.length - 1] || '';
        } else if (token.includes('----')) {
          const parts = token.split('----');
          token = parts.slice(2).join('----').trim() || parts[parts.length - 1] || '';
        }
        token = token.replace(/^sso=/i, '');
        if (token) {
          this.push({ type: 'sso', runId, token: `sso=${token}` });
        }
      }
      if (lines.length > 0) {
        this.log(runId, `共提取到 ${lines.length} 个 SSO token`);
        this.copySsoToStandardDir(ssoFile);
      }
    } catch {
      /* ignore */
    }
  }

  private copySsoToStandardDir(ssoFile: string) {
    try {
      const outDir = this.resolveSsoOutDir();
      if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
      }
      const basename = path.basename(ssoFile);
      const dest = path.join(outDir, basename);
      if (path.resolve(ssoFile) !== path.resolve(dest)) {
        fs.copyFileSync(ssoFile, dest);
      }
    } catch {
      /* ignore */
    }
  }

  private resolveSsoOutDir(): string {
    if (process.env.SSO_DIR) return path.resolve(process.env.SSO_DIR);
    if (process.env.DATA_DIR) return path.resolve(process.env.DATA_DIR, 'sso');
    return path.resolve(process.cwd(), 'out', 'sso');
  }
}

export const registerBot = new RegisterBot();
