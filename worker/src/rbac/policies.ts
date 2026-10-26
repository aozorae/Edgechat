export type Policy = { id: string; method: string; path: RegExp; permissions: string[]; superOnly?: boolean;
  scope?: 'user' | 'group' | 'telegram' | 'bridge'; fields?: string[]; audit?: boolean };
function policy(id: string, method: string, path: string, permissions: string[], options: Partial<Policy> = {}): Policy {
  return { id, method, path: new RegExp(`^/api/admin/${path}$`), permissions, ...options };
}
// 路由、字段和目标范围只在这里登记；未知后台入口没有管理员兜底。
export const ADMIN_POLICIES = [
  policy('overview', 'GET', 'overview', ['dashboard.read']),
  policy('users.list', 'GET', 'users', ['users.read']),
  policy('users.history', 'GET', 'users/([^/]+)/details', ['users.login_history.read'], { scope: 'user' }),
  policy('users.create', 'POST', 'users', ['users.create'], { fields: ['username', 'displayName', 'password', 'roleId'], audit: true }),
  policy('users.update', 'PATCH', 'users/([1-9]\\d*)', [], { scope: 'user', fields: ['displayName', 'isDisabled', 'banDurationMinutes'], audit: true }),
  policy('users.reset', 'POST', 'users/([1-9]\\d*)/reset-password', [], { superOnly: true, scope: 'user', fields: ['password'], audit: true }),
  policy('users.delete', 'DELETE', 'users/([1-9]\\d*)', ['users.delete'], { scope: 'user', audit: true }),
  policy('invites.list', 'GET', 'register-links', ['invites.read']),
  policy('invites.create', 'POST', 'register-links', ['invites.create'], { fields: ['note', 'maxUses'], audit: true }),
  policy('invites.revoke', 'DELETE', 'register-links/([1-9]\\d*)', ['invites.revoke'], { audit: true }),
  // 期一：分发制后台（复用 invites 权限，不新增权限点，避免影响已有角色授权）
  policy('distribution.config.read', 'GET', 'distribution/config', ['invites.read']),
  policy('distribution.config.update', 'PUT', 'distribution/config', ['invites.create'], { fields: ['gateEnabled', 'treeVisible'], audit: true }),
  policy('distribution.tree.read', 'GET', 'distribution/tree', ['invites.read']),
  policy('channels.list', 'GET', 'channels', ['channels.read']),
  policy('channels.delete', 'DELETE', 'channels/([1-9]\\d*)', ['channels.delete'], { audit: true }),
  policy('dms.list', 'GET', 'dms', [], { superOnly: true }),
  policy('storage.scan', 'POST', 'storage/scan', ['storage.scan'], { fields: [], audit: true }),
  policy('storage.read', 'GET', 'storage', ['storage.read']),
  policy('site.read', 'GET', 'site-settings', ['site.read']),
  policy('site.update', 'PATCH', 'site-settings', ['site.appearance.update'], { fields: ['siteName', 'siteIconUrl', 'colorTheme'], audit: true }),
  policy('telegram.read', 'GET', 'telegram', ['telegram.read']),
  policy('telegram.config', 'PUT', 'telegram/config', [], { superOnly: true, fields: ['botToken'], audit: true }),
  policy('telegram.create', 'POST', 'telegram/mappings', ['telegram.mappings.manage'], { scope: 'group', fields: ['channelId', 'telegramChatId'], audit: true }),
  policy('telegram.update', 'PATCH', 'telegram/mappings/([1-9]\\d*)', ['telegram.mappings.manage'], { scope: 'telegram', fields: ['enabled'], audit: true }),
  policy('telegram.delete', 'DELETE', 'telegram/mappings/([1-9]\\d*)', ['telegram.mappings.manage'], { scope: 'telegram', audit: true }),
  policy('bridge.read', 'GET', 'instance-bridge', ['instance_bridge.read']),
  policy('bridge.create', 'POST', 'instance-bridge/invitations', ['instance_bridge.manage'], { scope: 'group', fields: ['channelId'], audit: true }),
  policy('bridge.accept', 'POST', 'instance-bridge/accept', ['instance_bridge.manage'], { scope: 'group', fields: ['channelId', 'invitation'], audit: true }),
  policy('bridge.action', 'POST', 'instance-bridge/([^/]+)/actions', ['instance_bridge.manage'], { scope: 'bridge', fields: ['action'], audit: true }),
  policy('maintenance.read', 'GET', 'maintenance', ['maintenance.read']),
  policy('stealth.read', 'GET', 'stealth', [], { superOnly: true }),
  policy('stealth.update', 'PUT', 'stealth', [], { superOnly: true, fields: ['enabled'], audit: true }),
  policy('rbac.catalog', 'GET', 'rbac/permissions', [], { superOnly: true }),
  policy('rbac.list', 'GET', 'rbac/roles', [], { superOnly: true }),
  policy('rbac.create', 'POST', 'rbac/roles', [], { superOnly: true, fields: ['name', 'description', 'permissions'], audit: true }),
  policy('rbac.update', 'PATCH', 'rbac/roles/([1-9]\\d*)', [], { superOnly: true, fields: ['name', 'description', 'permissions', 'enabled', 'expectedRevision'], audit: true }),
  policy('rbac.delete', 'DELETE', 'rbac/roles/([1-9]\\d*)', [], { superOnly: true, audit: true }),
  policy('rbac.members', 'GET', 'rbac/roles/([1-9]\\d*)/members', [], { superOnly: true }),
  policy('rbac.assign', 'PUT', 'rbac/users/([1-9]\\d*)/role', [], { superOnly: true, fields: ['roleId', 'expectedAuthzVersion'], audit: true }),
  policy('rbac.unprotect', 'POST', 'rbac/users/([1-9]\\d*)/unprotect', [], { superOnly: true, fields: ['expectedAuthzVersion'], audit: true }),
  policy('audit.read', 'GET', 'audit', [], { superOnly: true }),
];

export function resolvePolicy(method: string, path: string, payload: Record<string, unknown> = {}) {
  const registered = ADMIN_POLICIES.find((p) => p.method === method && p.path.test(path));
  if (!registered) return null;
  const resolved = { ...registered, permissions: [...registered.permissions] };
  if (resolved.id === 'users.update') {
    if ('displayName' in payload) resolved.permissions.push('users.profile.update');
    if ('isDisabled' in payload) resolved.permissions.push('users.ban');
  }
  if (resolved.id === 'users.create' && 'roleId' in payload) resolved.superOnly = true;
  return resolved;
}
