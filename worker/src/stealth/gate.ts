import type { StealthSettings } from '../data/stealth-settings.ts';
import { loginWithPassword } from '../login.ts';
import { sessionCookie } from '../session-cookie.ts';
import { renderGate } from './appearance.ts';
import { getLoginVerification, type LoginVerificationSettings } from '../data/login-verification.ts';
import { verifyLoginSecurity } from '../login-security.ts';
import { ApiError } from '../errors.js';

export const privateHeaders = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  // no-referrer 会让浏览器表单 POST 的 Origin 变为 null；same-origin 隐藏外站来源且保留同源校验。
  'Referrer-Policy': 'same-origin',
};

export function notFound() {
  return new Response('Not Found', {
    status: 404,
    headers: { ...privateHeaders, 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

export function gatePage(settings: StealthSettings, failed = false, status = 200, verification?: LoginVerificationSettings) {
  // Settings are initialized/persisted before rendering; never generate presentation per request.
  if (!settings.appearance) throw new Error('Missing gate appearance');
  const nonce = crypto.randomUUID().replaceAll('-', '');
  const html = renderGate({ ...settings, appearance: settings.appearance }, failed, verification?.enabled ? verification.siteKey : '', nonce);
  return new Response(html, {
    status,
    headers: {
      ...privateHeaders,
      'Content-Type': 'text/html; charset=utf-8',
      ...(status === 429 ? { 'Retry-After': '60' } : {}),
      'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'${verification?.enabled ? `; script-src 'nonce-${nonce}' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src https://challenges.cloudflare.com` : ''}`,
    },
  });
}

async function readForm(request: Request) {
  // 实际流读取也限额，不能只信 Content-Length；登录表单无需接受大体积或 multipart 上传。
  if (!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) return null;
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8192) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new URLSearchParams(await new Blob(chunks).text());
}

export async function submitGate(request: Request, env, settings: StealthSettings) {
  if (request.headers.get('origin') !== new URL(request.url).origin) return notFound();
  const verification = await getLoginVerification(env.DB);
  const form = await readForm(request);
  const username = form?.get('username')?.trim() || '';
  const password = form?.get('password') || '';
  if (!username || username.length > 100 || !password || password.length > 1024) {
    return gatePage(settings, true, 400, verification);
  }
  try {
    await verifyLoginSecurity(env, request, form?.get('cf-turnstile-response'));
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return gatePage(settings, true, error.status, verification);
  }
  const session = await loginWithPassword(env, username, password, request);
  if (!session) return gatePage(settings, true, 401, verification);
  return new Response(null, {
    status: 303,
    headers: { ...privateHeaders, Location: '/', 'Set-Cookie': sessionCookie(request, session.token) },
  });
}
