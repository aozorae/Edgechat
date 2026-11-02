import { dispatchAuthInvalid, getStoredToken } from './auth-storage.js';
import { getEdgeChatServerOrigin, resolveServerUrl } from './capacitor-platform.ts';
import { t } from './i18n.js';
import { localizedError, localizeErrorMessage } from './localized-error.js';
import { getRuntimeFileUrl, isDemoMode, requestRuntime } from './runtime.js';
import { apiPrefix, isGatewayMode } from './gateway.ts';

function buildHeaders(extra = {}) {
  const headers = { ...extra };
  const token = getStoredToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function request(path, options = {}) {
  if (isDemoMode) {
    try {
      return await requestRuntime(path, options);
    } catch (error) {
      throw localizedError(error);
    }
  }

  const response = await fetch(resolveServerUrl(`${apiPrefix}${path}`), {
    ...options,
    headers: buildHeaders(options.headers),
    body:
      options.body instanceof FormData || typeof options.body === 'string'
        ? options.body
        : options.body
          ? JSON.stringify(options.body)
          : undefined
  });

  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json')
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const rawMessage = payload?.error?.message || payload?.error || payload || t('common.requestFailed');
    const error = new Error(localizeErrorMessage(rawMessage));
    error.status = response.status;
    error.payload = payload;
    error.rawMessage = rawMessage;

    if ((response.status === 401 || (isGatewayMode && response.status === 404
      && !contentType.includes('application/json'))) && typeof window !== 'undefined') {
      dispatchAuthInvalid(error.message);
    }
    if (response.status === 403 && path.startsWith('/admin/') && typeof window !== 'undefined') window.dispatchEvent(new Event('authorization-changed'));

    throw error;
  }

  return payload;
}

export default {
  authorization() { return request('/me/authorization'); },
  rbacRoles(offset = 0) { return request(`/admin/rbac/roles?offset=${offset}`); },
  rbacPermissions() { return request('/admin/rbac/permissions'); },
  rbacMembers(id, offset = 0) { return request(`/admin/rbac/roles/${id}/members?offset=${offset}`); },
  saveRbacRole(id, body) { return request(`/admin/rbac/roles${id ? `/${id}` : ''}`, { method: id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body }); },
  deleteRbacRole(id) { return request(`/admin/rbac/roles/${id}`, { method: 'DELETE' }); },
  assignRbacRole(id, body) { return request(`/admin/rbac/users/${id}/role`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body }); },
  unprotectUser(id, expectedAuthzVersion) { return request(`/admin/rbac/users/${id}/unprotect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { expectedAuthzVersion } }); },
  adminAudit(offset = 0) { return request(`/admin/audit?offset=${offset}`); },
  adminStorage() { return request('/admin/storage'); },
  callConfig(roomId) {
    return request(`/calls/${roomId}/config`, { signal: AbortSignal.timeout(10000) });
  },
  callAction(roomId, body) {
    return request(`/calls/${roomId}/action`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(10000), keepalive: ['hangup', 'reject'].includes(body.type)
    });
  },
  callIce(roomId, callId, clientId) {
    return request(`/calls/${roomId}/ice?${new URLSearchParams({ callId, clientId })}`, { signal: AbortSignal.timeout(15000) });
  },
  adminStealth() {
    return request('/admin/stealth');
  },
  saveAdminStealth(enabled) {
    return request('/admin/stealth', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: { enabled }
    });
  },
  instanceBridge(path = '', body) {
    return request(`/admin/instance-bridge${path}`, body ? {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body
    } : {});
  },
  roomInstanceBridge(roomId) {
    return request(`/channels/${roomId}/instance-bridge`);
  },
  login(credentials) {
    return request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: credentials
    });
  },
  logout() {
    return request('/auth/logout', { method: 'POST' });
  },
  reportLoginNetwork(probeId, result, options) {
    return request('/auth/login-network', {
      ...options, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { probeId, ...result }
    });
  },
  session() {
    return request('/auth/session', { signal: AbortSignal.timeout(10000) });
  },
  getSite() {
    return request('/site', { signal: AbortSignal.timeout(10000) });
  },
  changePassword(payload) {
    return request('/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload
    });
  },
  updateProfile(payload) {
    return request('/me/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: payload
    });
  },
  getUsers() {
    return request('/users');
  },
  getContacts(options = {}) {
    return request('/contacts', options);
  },
  getBlockedUsers(options = {}) {
    return request('/users/blocked', options);
  },
  getUserProfile(userId, options = {}) {
    return request(`/users/${encodeURIComponent(userId)}/profile`, options);
  },
  bootstrap() {
    return request('/bootstrap');
  },
  getChannels() {
    return request('/channels');
  },
  createGroup(payload) {
    return request('/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload
    });
  },
  joinChannel(channelId) {
    return request(`/channels/${channelId}/join`, { method: 'POST' });
  },
  getChannelMembers(channelId) {
    return request(`/channels/${channelId}/members`);
  },
  inviteChannelMembers(channelId, userIds) {
    return request(`/channels/${channelId}/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { userIds }
    });
  },
  removeChannelMember(channelId, userId) {
    return request(`/channels/${channelId}/members/${userId}`, {
      method: 'DELETE'
    });
  },
  deleteOwnedChannel(channelId) {
    return request(`/channels/${channelId}`, {
      method: 'DELETE'
    });
  },
  updateChannel(channelId, payload) {
    return request(`/channels/${channelId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: payload
    });
  },
  getMessages(kind, roomId, before) {
    const query = new URLSearchParams({ kind, roomId: String(roomId) });
    if (before) {
      query.set('before', String(before));
    }
    return request(`/messages?${query.toString()}`);
  },
  getRecentMessages(kind, roomId, limit = 30) {
    const query = new URLSearchParams({ limit: String(limit) });
    return request(
      `/v1/rooms/${encodeURIComponent(kind)}/${Number(roomId)}/messages?${query.toString()}`
    );
  },
  sendRoomMessage(kind, roomId, payload) {
    return request(`/v1/rooms/${encodeURIComponent(kind)}/${Number(roomId)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload
    });
  },
  markRoomRead(kind, roomId, messageId) {
    return request('/messages/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        kind,
        roomId,
        ...(messageId ? { messageId } : {})
      }
    });
  },
  openDm(userId) {
    return request('/dm/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { userId }
    });
  },
  listDms() {
    return request('/dm');
  },
  blockUser(userId) {
    return request(`/users/${Number(userId)}/block`, { method: 'PUT' });
  },
  unblockUser(userId) {
    return request(`/users/${Number(userId)}/block`, { method: 'DELETE' });
  },
  uploadFile(file) {
    const form = new FormData();
    form.append('file', file);
    return request('/upload', {
      method: 'POST',
      body: form
    });
  },
  getRoomWebSocketUrl(kind, roomId) {
    const token = getStoredToken();
    const url = new URL(`${apiPrefix}/ws/${kind}/${roomId}`, getEdgeChatServerOrigin());
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('token', token || '');
    return url.toString();
  },
  getInboxWebSocketUrl() {
    const token = getStoredToken();
    const url = new URL(`${apiPrefix}/inbox/ws`, getEdgeChatServerOrigin());
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('token', token || '');
    return url.toString();
  },
  getFileUrl(keyOrUrl) {
    const raw = String(keyOrUrl || '');
    if (!raw) {
      return '';
    }
    if (isDemoMode) {
      return getRuntimeFileUrl(raw);
    }

    const url = raw.startsWith('/files/')
      ? new URL(resolveServerUrl(raw), getEdgeChatServerOrigin())
      : new URL(resolveServerUrl(`/files/${encodeURIComponent(raw)}`), getEdgeChatServerOrigin());
    const token = getStoredToken();
    if (token) {
      url.searchParams.set('token', token);
    }
    return resolveServerUrl(url.pathname + url.search);
  },
  adminUsers(offset = 0) {
    return request(`/admin/users?offset=${offset}`);
  },
  adminUserDetails(userId, options = {}) {
    return request(`/admin/users/${userId}/details`, options);
  },
  adminOverview() {
    return request('/admin/overview');
  },
  adminMaintenance() {
    return request('/admin/maintenance');
  },
  adminStorageScan(cursor = '') {
    const query = new URLSearchParams();
    if (cursor) {
      query.set('cursor', cursor);
    }
    const suffix = query.size ? `?${query.toString()}` : '';
    return request(`/admin/storage/scan${suffix}`, { method: 'POST', body: '{}' });
  },
  adminSiteSettings() {
    return request('/admin/site-settings');
  },
  adminTelegram() {
    return request('/admin/telegram');
  },
  telegramNotifications() {
    return request('/me/telegram-notifications');
  },
  createTelegramNotificationLink() {
    return request('/me/telegram-notifications/link', { method: 'POST' });
  },
  updateTelegramNotifications(payload) {
    return request('/me/telegram-notifications', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: payload
    });
  },
  disconnectTelegramNotifications() {
    return request('/me/telegram-notifications', { method: 'DELETE' });
  },
  saveAdminTelegramConfig(payload) {
    return request('/admin/telegram/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: payload
    });
  },
  createAdminTelegramMapping(payload) {
    return request('/admin/telegram/mappings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload
    });
  },
  updateAdminTelegramMapping(mappingId, payload) {
    return request(`/admin/telegram/mappings/${mappingId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: payload
    });
  },
  deleteAdminTelegramMapping(mappingId) {
    return request(`/admin/telegram/mappings/${mappingId}`, { method: 'DELETE' });
  },
  listAdminRegisterLinks() {
    return request('/admin/register-links');
  },
  createAdminRegisterLink(payload) {
    return request('/admin/register-links', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload
    });
  },
  getAdminDistributionConfig() {
    return request('/admin/distribution/config');
  },
  updateAdminDistributionConfig(payload) {
    return request('/admin/distribution/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: payload
    });
  },
  getAdminDistributionTree() {
    return request('/admin/distribution/tree');
  },  revokeAdminRegisterLink(inviteId) {
    return request(`/admin/register-links/${inviteId}`, {
      method: 'DELETE'
    });
  },
  updateAdminSiteSettings(payload) {
    return request('/admin/site-settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: payload
    });
  },
  createUser(payload) {
    return request('/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload
    });
  },
  updateUser(userId, payload) {
    return request(`/admin/users/${userId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: payload
    });
  },
  resetPassword(userId, password) {
    return request(`/admin/users/${userId}/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { password }
    });
  },
  deleteUser(userId) {
    return request(`/admin/users/${userId}`, {
      method: 'DELETE'
    });
  },
  adminChannels() {
    return request('/admin/channels');
  },
  deleteChannel(channelId) {
    return request(`/admin/channels/${channelId}`, {
      method: 'DELETE'
    });
  },
  adminDms() {
    return request('/admin/dms');
  },
  getRegisterInvite(token) {
    return request(`/register-links/${encodeURIComponent(token)}`);
  },
  registerWithInvite(token, payload) {
    return request(`/register-links/${encodeURIComponent(token)}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload
    });
  }
};
