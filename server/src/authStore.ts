import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { promises as fsp, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { dataDir } from './settingsStore.js';

const AUTH_PATH = join(dataDir(), 'auth.json');
const SESSION_COOKIE = 'grok_register_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const DEFAULT_USERNAME = 'admin';
const DEFAULT_PASSWORD = 'admin';

interface AuthRecord {
  username: string;
  passwordHash: string;
  salt: string;
  mustChangePassword: boolean;
}

interface SessionRecord {
  username: string;
  expiresAt: number;
}

export interface AuthState {
  authenticated: boolean;
  username: string | null;
  mustChangePassword: boolean;
}

const sessions = new Map<string, SessionRecord>();
let cache: AuthRecord | null = null;

function hashPassword(password: string, salt: string) {
  return scryptSync(password, salt, 32).toString('hex');
}

function makeRecord(username: string, password: string, mustChangePassword: boolean): AuthRecord {
  const salt = randomBytes(16).toString('hex');
  return {
    username,
    salt,
    passwordHash: hashPassword(password, salt),
    mustChangePassword
  };
}

function defaultRecord(): AuthRecord {
  return makeRecord(DEFAULT_USERNAME, DEFAULT_PASSWORD, true);
}

async function loadAuthRecord(): Promise<AuthRecord> {
  if (cache) return cache;
  if (!existsSync(AUTH_PATH)) {
    cache = defaultRecord();
    return cache;
  }
  try {
    const raw = await fsp.readFile(AUTH_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<AuthRecord>;
    if (!parsed.username || !parsed.passwordHash || !parsed.salt) {
      cache = defaultRecord();
      return cache;
    }
    cache = {
      username: parsed.username,
      passwordHash: parsed.passwordHash,
      salt: parsed.salt,
      mustChangePassword: parsed.mustChangePassword ?? false
    };
    return cache;
  } catch {
    cache = defaultRecord();
    return cache;
  }
}

async function saveAuthRecord(next: AuthRecord) {
  cache = next;
  await fsp.mkdir(dataDir(), { recursive: true });
  const tmp = `${AUTH_PATH}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(next, null, 2), 'utf-8');
  await fsp.rename(tmp, AUTH_PATH);
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return header
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((acc, part) => {
      const idx = part.indexOf('=');
      if (idx === -1) return acc;
      acc[part.slice(0, idx)] = decodeURIComponent(part.slice(idx + 1));
      return acc;
    }, {});
}

function safeCompare(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function verifyPassword(record: AuthRecord, password: string) {
  return safeCompare(hashPassword(password, record.salt), record.passwordHash);
}

function pruneSessions() {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(token);
  }
}

setInterval(pruneSessions, 1000 * 60 * 10).unref();

function readSessionFromCookie(cookie: string | undefined): SessionRecord | null {
  pruneSessions();
  const token = parseCookies(cookie)[SESSION_COOKIE];
  if (!token) return null;
  const session = sessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    if (session) sessions.delete(token);
    return null;
  }
  return session;
}

function buildCookie(token: string, expiresAt: number) {
  const secure = process.env.COOKIE_SECURE === '1';
  const pieces = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))}`
  ];
  if (secure) pieces.push('Secure');
  return pieces.join('; ');
}

function clearCookie() {
  const secure = process.env.COOKIE_SECURE === '1';
  const pieces = [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT'
  ];
  if (secure) pieces.push('Secure');
  return pieces.join('; ');
}

export async function getAuthStateFromCookie(cookie: string | undefined): Promise<AuthState> {
  const session = readSessionFromCookie(cookie);
  if (!session) {
    return { authenticated: false, username: null, mustChangePassword: false };
  }
  const record = await loadAuthRecord();
  if (session.username !== record.username) {
    return { authenticated: false, username: null, mustChangePassword: false };
  }
  return {
    authenticated: true,
    username: record.username,
    mustChangePassword: record.mustChangePassword
  };
}

export async function getAuthState(req: Request): Promise<AuthState> {
  return getAuthStateFromCookie(req.header('cookie'));
}

export async function login(req: Request, res: Response): Promise<AuthState | null> {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const record = await loadAuthRecord();
  if (username !== record.username || !verifyPassword(record, password)) {
    return null;
  }
  const token = randomBytes(24).toString('base64url');
  const expiresAt = Date.now() + SESSION_TTL_MS;
  sessions.set(token, { username: record.username, expiresAt });
  res.append('Set-Cookie', buildCookie(token, expiresAt));
  return {
    authenticated: true,
    username: record.username,
    mustChangePassword: record.mustChangePassword
  };
}

export async function logout(req: Request, res: Response) {
  const token = parseCookies(req.header('cookie'))[SESSION_COOKIE];
  if (token) sessions.delete(token);
  res.append('Set-Cookie', clearCookie());
}

export async function changeCredentials(req: Request, input: unknown): Promise<AuthState> {
  const state = await getAuthState(req);
  if (!state.authenticated) {
    throw new Error('unauthorized');
  }
  const body = (input ?? {}) as Record<string, unknown>;
  const currentPassword = String(body.currentPassword || '');
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const confirmPassword = String(body.confirmPassword || '');
  const record = await loadAuthRecord();

  if (!verifyPassword(record, currentPassword)) {
    throw new Error('当前密码不正确');
  }
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) {
    throw new Error('用户名只能包含字母、数字、下划线、点和短横线，长度 3-32');
  }
  if (password.length < 6 || password.length > 72) {
    throw new Error('新密码长度必须在 6 到 72 位之间');
  }
  if (password !== confirmPassword) {
    throw new Error('两次输入的新密码不一致');
  }

  const next = makeRecord(username, password, false);
  await saveAuthRecord(next);
  for (const [token, session] of sessions) {
    sessions.set(token, { ...session, username });
  }
  return {
    authenticated: true,
    username,
    mustChangePassword: false
  };
}

export async function authBootstrapInfo() {
  const record = await loadAuthRecord();
  return {
    username: record.username,
    defaultUsername: DEFAULT_USERNAME,
    defaultPassword: DEFAULT_PASSWORD,
    mustChangePassword: record.mustChangePassword
  };
}
