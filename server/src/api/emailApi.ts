import crypto from 'crypto';
import { proxiedRequest } from '../httpClient.js';

// Constants removed, now passed dynamically

function generateLocalPart(minLen = 8, maxLen = 13): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const length = Math.floor(Math.random() * (maxLen - minLen + 1)) + minLen;
    // Starts with letter
    let res = String.fromCharCode(97 + Math.floor(Math.random() * 26));
    for (let i = 0; i < length - 1; i++) {
        res += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return res;
}

export async function createTempEmail(mailConfig: { apiBase: string, adminAuth: string, domain: string }): Promise<{ address: string; jwt: string; password?: string }> {
    const local = generateLocalPart();
    const url = `${mailConfig.apiBase}/admin/new_address`;
    
    // Attempt 3 times
    for (let i = 0; i < 3; i++) {
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    'x-admin-auth': mailConfig.adminAuth,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    name: local,
                    domain: mailConfig.domain,
                    enablePrefix: false
                })
            });
            
            if (res.ok) {
                const data = await res.json() as any;
                if (data.jwt && (data.address || `${local}@${mailConfig.domain}`)) {
                    return {
                        address: data.address || `${local}@${mailConfig.domain}`,
                        jwt: data.jwt,
                        password: data.password
                    };
                }
            } else if (res.status === 400 || res.status === 409) {
                // maybe collision, try again
                continue;
            } else {
                throw new Error(`HTTP ${res.status}: ${await res.text()}`);
            }
        } catch (e) {
            console.error(`Attempt ${i+1} failed to create email:`, e);
            if (i === 2) throw e;
        }
    }
    throw new Error("Failed to create email after retries.");
}

export async function fetchEmails(jwt: string, apiBase: string, limit = 20): Promise<any[]> {
    try {
        const url = `${apiBase}/api/mails?limit=${limit}&offset=0`;
        const res = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${jwt}`
            }
        });
        if (res.ok) {
            const data = await res.json() as any;
            return data.results || [];
        }
    } catch (e) {
        // ignore
    }
    return [];
}

// removed old fetchEmails

export async function fetchEmailDetail(jwt: string, msgId: string, apiBase: string): Promise<any> {
    try {
        const url = `${apiBase}/api/mail/${msgId}`;
        const res = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${jwt}`
            }
        });
        if (res.ok) {
            return await res.json();
        }
    } catch (e) {
        // ignore
    }
    return null;
}

export function extractVerificationCode(content: string): string | null {
    if (!content) return null;
    
    // Pattern 1: Grok XXX-XXX
    let m = content.match(/(?<![A-Z0-9-])([A-Z0-9]{3}-[A-Z0-9]{3})(?![A-Z0-9-])/);
    if (m) return m[1];
    
    // Pattern 2: labeled
    m = content.match(/(?:verification code|验证码|your code)[:\s]*[<>\s]*([A-Z0-9]{3}-[A-Z0-9]{3})\b/i);
    if (m) return m[1];
    
    // Pattern 3: HTML styled
    m = content.match(/background-color:\s*#F3F3F3[^>]*>[\s\S]*?([A-Z0-9]{3}-[A-Z0-9]{3})[\s\S]*?<\/p>/);
    if (m) return m[1];
    
    // Pattern 4: Subject 6 digits
    m = content.match(/Subject:.*?(\d{6})/);
    if (m && m[1] !== "177010") return m[1];
    
    // Pattern 5: HTML tags 6 digits
    const p5 = />\s*(\d{6})\s*</g;
    let match;
    while ((match = p5.exec(content)) !== null) {
        if (match[1] !== "177010") return match[1];
    }
    
    // Pattern 6: Standalone 6 digits
    const p6 = /(?<![&#\d])(\d{6})(?![&#\d])/g;
    while ((match = p6.exec(content)) !== null) {
        if (match[1] !== "177010") return match[1];
    }
    
    return null;
}

export async function waitForVerificationCode(jwt: string, apiBase: string, timeoutS = 120): Promise<string | null> {
    const start = Date.now();
    const seenIds = new Set<string>();
    
    while (Date.now() - start < timeoutS * 1000) {
        const msgs = await fetchEmails(jwt, apiBase);
        for (const msg of msgs) {
            if (!msg || !msg.id || seenIds.has(msg.id)) continue;
            seenIds.add(msg.id);
            
            let content = msg.raw || msg.text || msg.html || msg.body || '';
            if (!content) {
                const detail = await fetchEmailDetail(jwt, msg.id, apiBase);
                if (detail) {
                    content = detail.raw || detail.text || detail.html || detail.body || '';
                }
            }
            
            if (msg.subject) {
                content = `Subject: ${msg.subject}\n${content}`;
            }
            
            const code = extractVerificationCode(content);
            if (code) {
                return code.replace('-', ''); // Return purely alphanumeric
            }
        }
        await new Promise(r => setTimeout(r, 3000));
    }
    return null;
}

/** 从邮件原文里提取 Subject 行（admin 接口的邮件对象不带独立 subject 字段） */
function extractSubject(raw: string): string {
    if (!raw) return '';
    const m = raw.match(/^Subject:\s*(.+)$/im);
    if (!m) return '';
    let s = m[1].trim();
    // 解码常见的 RFC2047 base64 编码主题，如 =?UTF-8?B?xxxx?=
    const enc = s.match(/=\?[^?]+\?B\?([^?]+)\?=/i);
    if (enc) {
        try {
            s = Buffer.from(enc[1], 'base64').toString('utf-8');
        } catch {
            // 解码失败就用原文
        }
    }
    return s;
}

export interface LatestCodeResult {
    code: string | null;
    subject: string | null;
    receivedAt: string | null;
    hasMail: boolean;
    error?: string;
}

/**
 * 通过 admin 接口按邮箱地址取最新一封邮件并提取验证码。
 * 账号记录里没有每个地址的 JWT，所以用 admin 的 x-admin-auth 头按地址查。
 */
export async function fetchLatestCodeByAddress(
    address: string,
    mailConfig: { apiBase: string; adminAuth: string },
    proxy?: string
): Promise<LatestCodeResult> {
    const empty: LatestCodeResult = {
        code: null,
        subject: null,
        receivedAt: null,
        hasMail: false
    };

    if (!address) return { ...empty, error: '缺少邮箱地址' };
    if (!mailConfig.apiBase || !mailConfig.adminAuth) {
        return { ...empty, error: '缺少邮箱后端配置' };
    }

    const base = mailConfig.apiBase.replace(/\/+$/, '');
    const url = `${base}/admin/mails?address=${encodeURIComponent(address)}&limit=10&offset=0`;

    try {
        const res = await proxiedRequest(url, {
            headers: { 'x-admin-auth': mailConfig.adminAuth },
            proxy
        });
        if (res.status !== 200) {
            return { ...empty, error: `邮箱后端返回 HTTP ${res.status}` };
        }

        const data = res.data as { results?: any[] } | null;
        const results = Array.isArray(data?.results) ? data!.results! : [];
        if (results.length === 0) return empty;

        // 按 created_at 倒序，最新在前
        results.sort((a, b) => {
            const ta = Date.parse(a?.created_at ?? '') || 0;
            const tb = Date.parse(b?.created_at ?? '') || 0;
            return tb - ta;
        });

        // 逐封从新到旧找出第一条能解析出验证码的
        for (const mail of results) {
            const content =
                (mail?.raw as string) ||
                (mail?.text as string) ||
                (mail?.html as string) ||
                '';
            const subject = (mail?.subject as string) || extractSubject(content);
            const merged = subject ? `Subject: ${subject}\n${content}` : content;
            const code = extractVerificationCode(merged);
            if (code) {
                return {
                    code,
                    subject: subject || null,
                    receivedAt: mail?.created_at ?? null,
                    hasMail: true
                };
            }
        }

        // 有邮件但没解析到验证码：回最新一封的信息
        const latest = results[0];
        const latestContent =
            (latest?.raw as string) || (latest?.text as string) || (latest?.html as string) || '';
        return {
            code: null,
            subject: (latest?.subject as string) || extractSubject(latestContent) || null,
            receivedAt: latest?.created_at ?? null,
            hasMail: true
        };
    } catch (e) {
        return { ...empty, error: e instanceof Error ? e.message : String(e) };
    }
}
