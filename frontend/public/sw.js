import { decryptedResponse } from './attachment-crypto.js';

async function downloadAttachment(request) {
  const headers = new Headers(request.headers);
  headers.set('x-edgechat-file', 'descriptor');
  const descriptor = await fetch(request.url, { headers, credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: request.signal });
  // 未启用直传时服务端返回普通文件；专用响应头区分描述符与用户上传的 JSON。
  if (descriptor.headers.get('x-edgechat-descriptor') !== 'v2') return descriptor;
  const info = await descriptor.json();
  return decryptedResponse(info, request.headers.get('range'), async (offset, length) => {
    const res = await fetch(info.url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` },
      credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store', signal: request.signal });
    if (res.status !== 206 || !res.body) throw new Error('附件分块读取失败');
    return res.body;
  });
}

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Never touch non-GET requests (PUT/POST/DELETE, WebSocket upgrades, etc.).
  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);

  // Same-origin GET requests, including page navigations, pass through here;
  // API, uploads and cross-origin requests use the browser's default handling.
  if (url.origin !== self.location.origin) {
    return;
  }
  if (/^\/files\/\d+(?:%2f|\/)direct-v2(?:%2f|\/)[a-f0-9-]{36}$/i.test(url.pathname)) {
    event.respondWith(downloadAttachment(request));
    return;
  }
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/files')) {
    return;
  }

  // Pass-through response; no caching, so nothing goes stale.
  event.respondWith(fetch(request));
});

// Focus (or open) the app when a system notification is clicked, and tell the
// page which room it belongs to so it can navigate there.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        const client = clientList.find((c) => 'focus' in c);
        if (client) {
          client.postMessage({ type: 'edgechat:notification-click', data });
          return client.focus();
        }
        const url = new URL('/', self.location.origin);
        if (data.roomKind && Number.isSafeInteger(Number(data.roomId)) && Number(data.roomId) > 0) {
          url.searchParams.set('notificationRoomKind', data.roomKind);
          url.searchParams.set('notificationRoomId', String(data.roomId));
        }
        return self.clients.openWindow(url.href);
      }),
  );
});
