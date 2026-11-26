import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildStorageRows,
  formatByteSize,
  mergeStorageSummary,
  sortStorageRows
} from '../frontend/src/storage-statistics.js';
import {
  storageOwnerFromObjectKey,
  summarizeR2Objects
} from '../worker/src/storage-statistics.js';
import { registerStorageRoutes } from '../worker/src/api/storage.ts';

function storageScanHandler() {
  let handler;
  const app = {
    get() {},
    put() {},
    post(path, candidate) {
      if (path === '/api/admin/storage/scan') handler = candidate;
    },
    patch() {},
    delete() {}
  };
  registerStorageRoutes(app);
  return handler;
}

test('R2 object keys resolve to users, Telegram, and unknown owners', () => {
  assert.deepEqual(storageOwnerFromObjectKey('12/file.png'), {
    key: 'user:12',
    type: 'user',
    userId: 12
  });
  assert.deepEqual(storageOwnerFromObjectKey('telegram/chat/file.bin'), {
    key: 'system:telegram',
    type: 'telegram',
    userId: null
  });
  assert.deepEqual(storageOwnerFromObjectKey('legacy/file.bin'), {
    key: 'system:unknown',
    type: 'unknown',
    userId: null
  });
});

test('one R2 page is aggregated without exposing object keys', () => {
  const items = summarizeR2Objects([
    { key: '2/a.bin', size: 100, uploaded: new Date('2026-08-11T00:00:00Z') },
    { key: '2/b.bin', size: 250, uploaded: new Date('2026-08-12T00:00:00Z') },
    { key: 'telegram/1/c.bin', size: 50, uploaded: new Date('2026-08-10T00:00:00Z') }
  ]);

  assert.deepEqual(items, [
    {
      ownerKey: 'user:2',
      ownerType: 'user',
      ownerId: 2,
      objectCount: 2,
      bytes: 350,
      latestUploadedAt: '2026-08-12T00:00:00.000Z'
    },
    {
      ownerKey: 'system:telegram',
      ownerType: 'telegram',
      ownerId: null,
      objectCount: 1,
      bytes: 50,
      latestUploadedAt: '2026-08-10T00:00:00.000Z'
    }
  ]);
  assert.equal('key' in items[0], false);
});

test('storage scan returns a structured 503 response when R2 is unavailable', async () => {
  await assert.rejects(() => storageScanHandler()({
    env: {},
    req: { url: 'https://edgechat.example/api/admin/storage/scan' }
  }), (error) => error.status === 503 && error.message === '当前部署没有绑定 R2，无法统计存储空间');
});

test('paged summaries merge and include active zero-usage users', () => {
  const summaries = new Map();
  mergeStorageSummary(summaries, [
    {
      ownerKey: 'user:1',
      ownerType: 'user',
      ownerId: 1,
      objectCount: 1,
      bytes: 10,
      latestUploadedAt: '2026-08-11T00:00:00Z'
    }
  ]);
  mergeStorageSummary(summaries, [
    {
      ownerKey: 'user:1',
      ownerType: 'user',
      ownerId: 1,
      objectCount: 2,
      bytes: 20,
      latestUploadedAt: '2026-08-12T00:00:00Z'
    }
  ]);

  const rows = buildStorageRows(
    [
      { id: 1, username: 'one', displayName: 'One', isDeleted: false },
      { id: 2, username: 'two', displayName: 'Two', isDeleted: false }
    ],
    summaries
  );
  assert.equal(rows.find((row) => row.ownerKey === 'user:1').bytes, 30);
  assert.equal(rows.find((row) => row.ownerKey === 'user:1').objectCount, 3);
  assert.equal(rows.find((row) => row.ownerKey === 'user:2').bytes, 0);
  assert.equal(rows.find((row) => row.ownerKey === 'user:1').share, 1);
});

test('storage rows sort numerically and missing upload times stay last', () => {
  const rows = [
    { displayName: 'A', bytes: 2, objectCount: 2, share: 0.2, latestUploadedAt: null },
    {
      displayName: 'B',
      bytes: 10,
      objectCount: 1,
      share: 0.8,
      latestUploadedAt: '2026-08-12T00:00:00Z'
    }
  ];
  assert.deepEqual(
    sortStorageRows(rows, { key: 'bytes', direction: 'desc' }).map((row) => row.displayName),
    ['B', 'A']
  );
  assert.deepEqual(
    sortStorageRows(rows, { key: 'objectCount', direction: 'desc' }).map(
      (row) => row.displayName
    ),
    ['A', 'B']
  );
  assert.deepEqual(
    sortStorageRows(rows, { key: 'latestUploadedAt', direction: 'asc' }).map(
      (row) => row.displayName
    ),
    ['B', 'A']
  );
  assert.equal(formatByteSize(10 * 1024 * 1024), '10.0 MiB');
});
