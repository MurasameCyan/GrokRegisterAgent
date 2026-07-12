/**
 * 检查更新（仅提醒，不下载）。
 * 读取 package.json 的 version 作为本地版本，调用 GitHub Releases API 取最新 tag 比对。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { UpdateInfo } from '@shared/ipc';

const REPO = 'FengZi1221/grok-reg-tool';
const __dirname = dirname(fileURLToPath(import.meta.url));

let cachedVersion: string | null = null;

export function currentVersion(): string {
  if (cachedVersion) return cachedVersion;
  // 编译后 index.js 位于 server/dist/server/src/，项目根目录上溯 4 层
  const candidates = [
    join(__dirname, '..', '..', '..', '..', 'package.json'),
    join(process.cwd(), 'package.json')
  ];
  for (const path of candidates) {
    try {
      const raw = readFileSync(path, 'utf-8');
      const pkg = JSON.parse(raw) as { version?: string };
      if (pkg.version) {
        cachedVersion = pkg.version;
        return cachedVersion;
      }
    } catch {
      // try next
    }
  }
  cachedVersion = '0.0.0';
  return cachedVersion;
}

/** 去掉前缀 v，拆成数字数组做粗比较 */
function parseVersion(v: string): number[] {
  return v
    .replace(/^v/i, '')
    .split('.')
    .map((part) => parseInt(part, 10) || 0);
}

/** a > b 返回 true */
function isNewer(a: string, b: string): boolean {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

export async function checkForUpdate(): Promise<UpdateInfo> {
  const current = currentVersion();
  const base: UpdateInfo = {
    current,
    latest: null,
    hasUpdate: false,
    htmlUrl: `https://github.com/${REPO}/releases`,
    publishedAt: null
  };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const resp = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'grok-reg-tool' },
      signal: controller.signal
    });
    clearTimeout(timer);

    if (resp.status === 404) {
      // 仓库尚无 release
      return { ...base, error: '仓库暂无发布版本' };
    }
    if (!resp.ok) {
      return { ...base, error: `GitHub 返回 HTTP ${resp.status}` };
    }

    const data = (await resp.json()) as {
      tag_name?: string;
      html_url?: string;
      published_at?: string;
    };
    const latest = data.tag_name ?? null;
    return {
      current,
      latest,
      hasUpdate: latest ? isNewer(latest, current) : false,
      htmlUrl: data.html_url ?? base.htmlUrl,
      publishedAt: data.published_at ?? null
    };
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
}
