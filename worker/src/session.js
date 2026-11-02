import { deleteSession, getSession, isAdminUser, putSession } from './auth.js';
import { isUserDisabled } from './user-status.js';
import { authorizationFromRow } from './rbac/authorization.ts';
import { readSessionState } from './data/session-state.ts';

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export async function validateSession(env, token, { management = false, profile = false, room = null } = {}) {
  const session = await getSession(env, token);
  if (!session) {
    return { ok: false, status: 401, message: '请先登录' };
  }

  const user = await readSessionState(env.DB, session, { management, profile, room });
  if (!user || user.deleted_at || isUserDisabled(user)) {
    await deleteSession(env, token);
    return { ok: false, status: 401, message: '账号已不可用' };
  }

  if (session.deviceSessionId) {
    if (user.device_session_version == null || toNumber(user.device_session_version) !== toNumber(user.session_version)) {
      await deleteSession(env, token);
      return { ok: false, status: 401, message: '设备登录已失效，请重新登录' };
    }
  }

  const dbVersion = toNumber(user.session_version);
  const sessionVersion = toNumber(session.sessionVersion);
  if (sessionVersion !== dbVersion) {
    await deleteSession(env, token);
    return { ok: false, status: 401, message: '登录已过期，请重新登录' };
  }

  if (room && !user.room_id) {
    // 退群只撤销当前房间访问，不能顺带销毁仍可访问其他会话的登录凭据。
    return { ok: false, status: 403, message: '无权访问该会话' };
  }

  const refreshed = {
    ...session,
    ...(profile ? {
      username: user.username,
      displayName: user.display_name,
      bio: user.bio ?? '',
      avatarUrl: user.avatar_key ? `/files/${encodeURIComponent(user.avatar_key)}` : ''
    } : {}),
    isAdmin: isAdminUser(env, user),
    isSuperAdmin: Boolean(user.is_super_admin),
    ...(management ? authorizationFromRow(user) : {}),
    sessionVersion: dbVersion
  };

  // 恢复接口直接复用本次鉴权的最新资料；仅资料确实改变时写回，避免每次启动续写 KV。
  const profileChanged = profile && ['username', 'displayName', 'bio', 'avatarUrl']
    .some((key) => refreshed[key] !== session[key]);
  if (profileChanged || refreshed.isAdmin !== session.isAdmin || refreshed.sessionVersion !== session.sessionVersion) {
    await putSession(env, refreshed);
  }

  return {
    ok: true,
    session: refreshed,
    ...(room ? { room: {
      id: user.room_id,
      name: user.room_name,
      description: user.room_description,
      avatar_key: user.room_avatar_key,
      kind: user.room_kind,
      dm_key: user.room_dm_key
    } } : {})
  };
}

