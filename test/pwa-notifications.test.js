import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseNotificationRoomTarget,
  takeNotificationRoomTarget,
} from '../frontend/src/notification-target.js';

async function runNotificationClick(clientList) {
  const listeners = new Map();
  const opened = [];
  const self = {
    location: { origin: 'https://chat.example' },
    addEventListener(name, listener) { listeners.set(name, listener); },
    clients: {
      async matchAll() { return clientList; },
      async openWindow(url) { opened.push(url); },
    },
  };
  globalThis.self = self;
  await import('../frontend/public/sw.js?test=' + crypto.randomUUID());
  let completed;
  let closed = false;
  listeners.get('notificationclick')({
    notification: {
      data: { roomKind: 'dm', roomId: 42 },
      close() { closed = true; },
    },
    waitUntil(promise) { completed = promise; },
  });
  await completed;
  delete globalThis.self;
  return { opened, closed };
}

test('通知点击复用窗口时发送目标并聚焦', async () => {
  const messages = [];
  let focused = false;
  const client = {
    postMessage(message) { messages.push(message); },
    async focus() { focused = true; },
  };
  const result = await runNotificationClick([client]);
  assert.equal(result.closed, true);
  assert.equal(focused, true);
  assert.deepEqual(result.opened, []);
  assert.equal(messages[0].type, 'edgechat:notification-click');
  assert.equal(messages[0].data.roomId, 42);
});

test('通知点击冷启动时在 URL 中保留会话，读取后清除参数', async () => {
  const result = await runNotificationClick([]);
  const openedUrl = new URL(result.opened[0]);
  assert.equal(openedUrl.origin, 'https://chat.example');
  const browserWindow = {
    location: { href: `${openedUrl.href}#view` },
    history: {
      state: { scroll: 12 },
      replaceState(state, title, url) { this.replacement = { state, title, url }; },
    },
  };
  assert.deepEqual(takeNotificationRoomTarget(browserWindow), { kind: 'dm', id: 42 });
  assert.equal(browserWindow.history.replacement.url, '/#view');
  assert.deepEqual(browserWindow.history.replacement.state, { scroll: 12 });
});

test('拒绝无效通知目标，仍清除 URL 中的通知参数', () => {
  assert.equal(parseNotificationRoomTarget({ roomKind: 'admin', roomId: 2 }), null);
  assert.equal(parseNotificationRoomTarget({ roomKind: 'dm', roomId: -1 }), null);
  const browserWindow = {
    location: { href: 'https://chat.example/?keep=yes&notificationRoomKind=dm&notificationRoomId=oops' },
    history: {
      state: null,
      replaceState(_state, _title, url) { this.url = url; },
    },
  };
  assert.equal(takeNotificationRoomTarget(browserWindow), null);
  assert.equal(browserWindow.history.url, '/?keep=yes');
});
