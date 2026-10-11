import assert from 'node:assert/strict';
import test from 'node:test';
import { filterAdminUsers } from '../frontend/src/admin/user-list.ts';

const users = [
  { id: 1, displayName: 'Alice 张', username: 'alice' },
  { id: 2, displayName: '管理员', username: 'admin' },
  { id: 3, displayName: 'Alice', username: 'alicia' }
];

test('后台本页搜索支持名字、用户名、@前缀和大小写', () => {
  assert.deepEqual(filterAdminUsers(users, ' ALICE ').map(({ id }) => id), [1, 3]);
  assert.deepEqual(filterAdminUsers(users, '@ADMIN').map(({ id }) => id), [2]);
  assert.deepEqual(filterAdminUsers(users, '张').map(({ id }) => id), [1]);
  assert.deepEqual(filterAdminUsers(users, '不存在'), []);
});

test('后台本页搜索保留数据和排序，清空后恢复当前页', () => {
  const before = structuredClone(users);
  assert.equal(filterAdminUsers(users, '  '), users);
  assert.equal(filterAdminUsers(users, 'alicia')[0], users[2]);
  assert.deepEqual(users, before);
  assert.deepEqual(filterAdminUsers([], 'Alice'), []);
});
