import { errorResponse, errorCodeForStatus, v1ErrorResponse } from './utils.js';
import { validateSession } from './session.js';
import { cookieRequestAllowed, extractSessionToken } from './session-cookie.ts';
import { resolvePolicy } from './rbac/policies.ts';
import { authorizedDatabase, checkPolicy, policyAssertion, runAuthorizedBatch } from './rbac/authorization.ts';
import { ApiError } from './errors.js';

export async function authMiddleware(c, next) {
  if (new URL(c.req.url).pathname.startsWith('/api/admin/')) c.header('Cache-Control', 'private, no-store');
  if (!cookieRequestAllowed(c.req.raw)) return errorResponse('请求被拒绝', 403);
  const token = extractSessionToken(c.req.raw);
  const path = new URL(c.req.url).pathname;
  const management = path.startsWith('/api/admin/') || path === '/api/me/authorization' || path === '/api/auth/session';
  if (path.startsWith('/api/admin/') && !c.req.raw.headers.get('Authorization') && !c.req.raw.headers.get('Cookie')) return errorResponse('请先登录', 401);
  let result;
  try { result = await validateSession(c.env, token, { management, profile: path === '/api/auth/session' }); }
  catch (error) {
    if (!management) throw error;
    console.error('management_authorization_unavailable');
    return errorResponse('权限服务暂不可用', 503);
  }
  if (!result.ok) {
    if (new URL(c.req.url).pathname.startsWith('/api/v1/')) {
      return v1ErrorResponse(errorCodeForStatus(result.status), result.message, result.status);
    }
    return errorResponse(result.message, result.status);
  }

  c.set('session', result.session);
  await next();
}

export async function adminMiddleware(c, next) {
  const session = c.get('session');
  c.header('Cache-Control', 'private, no-store');
  const method = c.req.method;
  let payload = {};
  if (!['GET', 'DELETE', 'HEAD'].includes(method)) {
    try { payload = await c.req.raw.clone().json(); } catch { throw new ApiError('请求格式无效', 400); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ApiError('请求格式无效', 400);
  }
  const path = new URL(c.req.url).pathname;
  const policy = resolvePolicy(method, path, payload);
  if (!policy) throw new ApiError('后台操作未授权', 403);
  checkPolicy(session, policy);
  if (policy.fields && Object.keys(payload).some((key) => !policy.fields.includes(key))) throw new ApiError('请求包含不允许修改的字段', 400);
  if (policy.id === 'users.update' && !policy.permissions.length) throw new ApiError('没有可修改的字段', 400);
  const target = policy.scope === 'group' ? Number(payload.channelId) : policy.path.exec(path)?.[1] || '';
  if (policy.scope === 'user' && Number(target) === session.userId &&
      (policy.id === 'users.delete' || payload.isDisabled === true)) throw new ApiError('不能删除或封禁自己的账号', 403);
  const context = { policy, session, target };
  const assertion = policyAssertion(policy, session, target);
  let allowed;
  try { allowed = await c.env.DB.prepare(`SELECT ${assertion.sql} AS ok`).bind(...assertion.params).first(); }
  catch { throw new ApiError('权限服务暂不可用', 503); }
  if (!allowed?.ok) throw new ApiError(policy.id === 'users.history' ? '用户不存在' : '没有此操作权限或目标不在管理范围', policy.id === 'users.history' ? 404 : 403);
  c.set('authorizationContext', context);
  c.set('authorizationDatabase', c.env.DB);
  c.set('unrestrictedEnvironment', c.env);
  if (['telegram.config', 'telegram.create'].includes(policy.id)) {
    // 外部网络动作不属于 D1 事务；先持久接受意图，审计不记录凭据，后续网络结果允许独立失败。
    await runAuthorizedBatch(c.env.DB, context, [], undefined, { phase: 'accepted' });
  }
  if (method !== 'GET') c.env = { ...c.env, DB: authorizedDatabase(c.env.DB, context) };
  await next();
}
