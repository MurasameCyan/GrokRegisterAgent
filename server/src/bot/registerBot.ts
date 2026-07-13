import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { spawn, ChildProcess } from 'child_process';
import { loadSettings } from '../settingsStore.js';
import { appendAccount } from '../accountStore.js';
import type { AccountRecord, LogLevel, RunEvent, RunStatus } from '@shared/runEvents';
import { EMPTY_STATUS } from '@shared/runEvents';
import fs from 'fs';
import path from 'path';
import { resolveRegisterRuntime, writeConfigForPython } from './registerRuntime.js';

interface StartOptions {
    runCountOverride?: number;
}

export class RegisterBot extends EventEmitter {
    private status: RunStatus = { ...EMPTY_STATUS };
    private currentRunId: string | null = null;
    private shouldStop: boolean = false;
    private childProcess: ChildProcess | null = null;
    private replayBuffer: RunEvent[] = [];
    private static readonly REPLAY_LIMIT = 1000;
    private collectedTokens: string[] = [];
    private currentSsoFile: string | null = null;
    private pendingAccount: { email?: string; password?: string } = {};

    getStatus(): RunStatus {
        return { ...this.status };
    }

    /** 解析最终使用的注册脚本目录:配置里真实存在的优先,否则用内置 register/。供体检等复用。 */
    resolveRegisterDir(configured?: string): string | null {
        return resolveRegisterRuntime({ registerDir: configured })?.registerDir ?? null;
    }

    getReplay(): RunEvent[] {
        return this.replayBuffer.slice();
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

    async start(opts: StartOptions = {}): Promise<{ runId: string }> {
        if (this.status.phase === 'starting' || this.status.phase === 'running') {
            throw new Error('已有一个注册任务在进行，请先停止');
        }

        const settings = await loadSettings();
        const runCount = opts.runCountOverride ?? settings.runCount;

        const runId = randomUUID();
        this.currentRunId = runId;
        this.shouldStop = false;
        this.replayBuffer = [];
        this.collectedTokens = [];
        this.pendingAccount = {};
        this.currentSsoFile = null;

        this.status = {
            ...EMPTY_STATUS,
            phase: 'starting',
            runId,
            startedAt: Date.now(),
            total: runCount
        };

        this.push({
            type: 'started',
            runId,
            pid: process.pid,
            total: runCount
        });

        // Fire and forget
        this.runPython(runId, runCount, settings).catch(e => {
            this.error(runId, `Runner error: ${e.message}`);
            this.finalizeRun(runId, false);
        });

        return { runId };
    }

    async stop(): Promise<void> {
        this.shouldStop = true;
        if (this.childProcess) {
            try {
                this.childProcess.kill('SIGTERM');
            } catch (e) {}
        }
    }

    private finalizeRun(runId: string, success: boolean) {
        if (this.currentRunId !== runId) return;
        this.status.phase = this.shouldStop ? 'killed' : (success ? 'done' : 'error');
        this.status.finishedAt = Date.now();
        this.push({
            type: 'exit',
            runId,
            code: success ? 0 : 1,
            signal: this.shouldStop ? 'SIGTERM' : null,
            killed: this.shouldStop
        });
        this.currentRunId = null;
    }

    private async runPython(runId: string, count: number, settings: any) {
        this.status.phase = 'running';

        // 1. 确定 Python 脚本路径:优先用配置里真实存在的目录,否则回退到项目内置 register/。
        const runtime = resolveRegisterRuntime(settings);
        if (!runtime) {
            throw new Error(
                '未找到内置注册脚本目录 register/（需含 runner.py 或 DrissionPage_example.py）。' +
                    '若使用 Docker：请勿用空的 ./register 挂载覆盖 /app/register；' +
                    '默认只用 ./data:/data。热更新请挂载完整 register 源码目录。'
            );
        }

        const { registerDir, scriptPath, pythonPath, entrypoint } = runtime;

        // 2. 写入 config.json 到 Python 目录，传递 WebUI 的配置
        writeConfigForPython(registerDir, settings, count);

        // 3. 构建 SSO 输出目录
        const ssoOutDir = this.resolveSsoOutDir();
        if (!fs.existsSync(ssoOutDir)) {
            fs.mkdirSync(ssoOutDir, { recursive: true });
        }
        const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const timeStr = new Date().toISOString().slice(11, 19).replace(/:/g, '');
        const ssoFile = path.join(ssoOutDir, `sso_${dateStr}_${timeStr}_${process.pid}.txt`);
        this.currentSsoFile = ssoFile;

        // 4. 启动 Python 子进程
        this.log(runId, `注册脚本目录: ${registerDir}`);
        this.log(runId, `注册机入口: ${entrypoint}`);

        const args = ['-u', scriptPath, '--count', String(count), '--output', ssoFile];

        await new Promise<void>((resolve, reject) => {
            const child = spawn(pythonPath, args, {
                cwd: registerDir,
                env: {
                    ...process.env,
                    PYTHONIOENCODING: 'utf-8',
                    PYTHONUNBUFFERED: '1',
                },
                stdio: ['pipe', 'pipe', 'pipe']
            });

            this.childProcess = child;

            child.stdout?.on('data', (data: Buffer) => {
                const text = data.toString('utf-8').trim();
                if (!text) return;
                for (const line of text.split('\n')) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;
                    this.parsePythonOutput(runId, trimmed, count);
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
                this.childProcess = null;

                // 读取 SSO 文件，提取 token
                this.extractSsoFromFile(runId, ssoFile);

                if (code === 0 || this.shouldStop) {
                    this.finalizeRun(runId, true);
                    resolve();
                } else {
                    this.finalizeRun(runId, false);
                    resolve(); // Don't reject, we handled it
                }
            });

            child.on('error', (err) => {
                this.childProcess = null;
                this.error(runId, `Python 进程启动失败: ${err.message}`);
                this.finalizeRun(runId, false);
                resolve();
            });
        });
    }

    private parsePythonOutput(runId: string, line: string, total: number) {
        let msg = line;
        // 去掉 Python logger 时间戳前缀
        const tsMatch = msg.match(/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s*\|\s*(.*)/);
        if (tsMatch) msg = tsMatch[1];

        // 跳过纯装饰线
        if (/^[═─]+$/.test(msg.trim())) return;

        // 提取轮次 "─── 第 1/10 轮 ───"：每进入新一轮，清空上一轮残留的 pending
        const roundMatch = msg.match(/第\s*(\d+)/);
        if (roundMatch && msg.includes('轮') && !msg.includes('成功') && !msg.includes('失败')) {
            const current = parseInt(roundMatch[1], 10);
            this.status.current = current;
            this.pendingAccount = {};
            this.push({ type: 'progress', runId, current, total });
        }

        // 提取邮箱（注册时 / 本轮完成时都会打印，后者覆盖前者）
        const emailMatch =
            msg.match(/已填写邮箱并点击注册:\s*(\S+)/) ||
            msg.match(/本轮注册完成，邮箱:\s*(\S+)/);
        if (emailMatch) {
            this.pendingAccount.email = emailMatch[1];
        }

        // 提取密码 "已填写注册资料并点击完成注册: 名 姓 / 密码"
        const passwordMatch = msg.match(/已填写注册资料并点击完成注册:\s*\S+\s+\S+\s*\/\s*(.+)$/);
        if (passwordMatch) {
            this.pendingAccount.password = passwordMatch[1].trim();
        }

        // 成功 "✔ 第 N 轮成功"：累加成功数并关联出一条账号记录
        if (msg.startsWith('✔') && msg.includes('轮成功')) {
            this.status.success++;
            this.push({ type: 'success', runId, success: this.status.success, total });
            this.recordAccount(runId);
        }

        // 失败 "✘ 第 N 轮失败"
        if (msg.startsWith('✘') && msg.includes('轮失败')) {
            this.status.failed++;
            this.pendingAccount = {};
        }

        // 转发到 WebUI
        if (msg.startsWith('✘') || msg.includes('[Error]') || msg.includes('失败')) {
            this.error(runId, msg);
        } else {
            this.log(runId, msg);
        }
    }

    private recordAccount(runId: string) {
        const { email, password } = this.pendingAccount;
        this.pendingAccount = {};
        if (!email && !password) return;

        // 该轮已由 Python 追加：email | password | sso
        let sso = '';
        let fileEmail = '';
        let filePassword = '';
        try {
            if (this.currentSsoFile && fs.existsSync(this.currentSsoFile)) {
                const lines = fs
                    .readFileSync(this.currentSsoFile, 'utf-8')
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
            // ignore
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
            const lines = content.split('\n').filter(l => l.trim());
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
                    this.collectedTokens.push(`sso=${token}`);
                    this.push({ type: 'sso', runId, token: `sso=${token}` });
                }
            }
            if (lines.length > 0) {
                this.log(runId, `共提取到 ${lines.length} 个 SSO token`);
                // 也复制一份到 WebUI 的标准 sso 目录
                this.copySsoToStandardDir(ssoFile);
            }
        } catch (e) {
            // ignore
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
        } catch (e) {
            // ignore
        }
    }

    private resolveSsoOutDir(): string {
        if (process.env.SSO_DIR) return path.resolve(process.env.SSO_DIR);
        if (process.env.DATA_DIR) return path.resolve(process.env.DATA_DIR, 'sso');
        return path.resolve(process.cwd(), 'out', 'sso');
    }
}

export const registerBot = new RegisterBot();
