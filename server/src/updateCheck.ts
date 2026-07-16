/**
 * 本地版本与检查更新：以 BUILD_ID（git short SHA）为准，便于对照镜像/注册机日志。
 * 优先级：REGISTER_BUILD / GIT_* 环境变量 → BUILD_ID 文件 → package.json version 兜底。
 * 远端对比：GitHub beta 分支最新 commit short SHA（开发主线在 beta）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { UpdateInfo } from '@shared/ipc';

const REPO = 'MurasameCyan/GrokRegisterAgent';
const BETA_REF = 'beta';
const __dirname = dirname(fileURLToPath(import.meta.url));

let cachedBuildId: string | null = null;

function shortSha(raw: string): string {
  const v = (raw || '').trim();
  if (!v) return '';
  // full or short hex sha
  if (/^[0-9a-fA-F]{7,40}$/.test(v)) return v.slice(0, 7).toLowerCase();
  return v.slice(0, 32);
}

function readBuildIdFile(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const line = readFileSync(path, 'utf-8').trim().split(/\r?\n/)[0]?.trim() || '';
    const s = shortSha(line);
    return s || null;
  } catch {
    return null;
  }
}

/** 解析当前运行构建号（short hash / BUILD_ID） */
export function currentBuildId(): string {
  if (cachedBuildId) return cachedBuildId;

  for (const key of [
    'REGISTER_BUILD',
    'GIT_COMMIT',
    'GIT_SHA',
    'SOURCE_COMMIT',
    'GITHUB_SHA',
    'BUILD_ID'
  ]) {
    const env = shortSha(process.env[key] || '');
    if (env) {
      cachedBuildId = env;
      return cachedBuildId;
    }
  }

  const fileCandidates = [
    join(process.cwd(), 'register', 'BUILD_ID'),
    join(process.cwd(), 'BUILD_ID'),
    '/app/register/BUILD_ID',
    '/app/BUILD_ID',
    join(__dirname, '..', '..', '..', '..', 'register', 'BUILD_ID'),
    join(__dirname, '..', '..', '..', '..', 'BUILD_ID')
  ];
  for (const p of fileCandidates) {
    const v = readBuildIdFile(p);
    if (v) {
      cachedBuildId = v;
      return cachedBuildId;
    }
  }

  // 最后兜底 package.json（非 hash 时仍显示，便于未注入 BUILD_ID 的开发态）
  const pkgCandidates = [
    join(__dirname, '..', '..', '..', '..', 'package.json'),
    join(process.cwd(), 'package.json')
  ];
  for (const path of pkgCandidates) {
    try {
      const pkg = JSON.parse(readFileSync(path, 'utf-8')) as { version?: string };
      if (pkg.version) {
        cachedBuildId = pkg.version;
        return cachedBuildId;
      }
    } catch {
      // next
    }
  }

  cachedBuildId = 'unknown';
  return cachedBuildId;
}

/** @deprecated 使用 currentBuildId；保留别名兼容旧 import */
export function currentVersion(): string {
  return currentBuildId();
}

export async function checkForUpdate(): Promise<UpdateInfo> {
  const current = currentBuildId();
  const base: UpdateInfo = {
    current,
    latest: null,
    hasUpdate: false,
    htmlUrl: `https://github.com/${REPO}/commits/${BETA_REF}`,
    publishedAt: null,
    buildId: current
  };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    // beta 最新 commit
    const resp = await fetch(
      `https://api.github.com/repos/${REPO}/commits/${encodeURIComponent(BETA_REF)}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'grok-register-agent'
        },
        signal: controller.signal
      }
    );
    clearTimeout(timer);

    if (resp.status === 404) {
      return { ...base, error: `分支 ${BETA_REF} 不可用` };
    }
    if (!resp.ok) {
      return { ...base, error: `GitHub 返回 HTTP ${resp.status}` };
    }

    const data = (await resp.json()) as {
      sha?: string;
      html_url?: string;
      commit?: { committer?: { date?: string }; author?: { date?: string } };
    };
    const latestFull = (data.sha || '').trim();
    const latest = shortSha(latestFull) || null;
    const localNorm = shortSha(current);
    const remoteNorm = latest || '';
    const bothHash =
      /^[0-9a-f]{7,}$/i.test(localNorm) && /^[0-9a-f]{7,}$/i.test(remoteNorm);
    const hasUpdate = bothHash
      ? localNorm.toLowerCase() !== remoteNorm.toLowerCase()
      : Boolean(latest && latest !== current);

    return {
      current,
      latest,
      hasUpdate,
      htmlUrl: data.html_url || base.htmlUrl,
      publishedAt:
        data.commit?.committer?.date || data.commit?.author?.date || null,
      buildId: current
    };
  } catch (err) {
    return {
      ...base,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}
