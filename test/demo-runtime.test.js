import assert from 'node:assert/strict';
import test from 'node:test';
import { requestDemo } from '../frontend/src/demo/api.js';
import {
  connectDemoInboxSocket,
  connectDemoRoomSocket
} from '../frontend/src/demo/realtime.js';
import { createDemoFixtures } from '../frontend/src/demo/fixtures.js';
import { demoState, resetDemoState } from '../frontend/src/demo/state.js';

test('demo sample conversations follow the visitor language', () => {
  const english = createDemoFixtures('en-US');
  const traditional = createDemoFixtures('zh-TW');
  const simplified = createDemoFixtures('zh-CN');

  assert.equal(english.session.displayName, 'Demo Admin');
  assert.equal(english.channels[2].name, 'Telegram Bridge');
  assert.doesNotMatch(JSON.stringify(english.messages), /[\u4e00-\u9fff]/);
  assert.equal(traditional.channels[1].name, '產品協作');
  assert.equal(simplified.channels[1].name, '产品协作');
  assert.equal(simplified.messages['private:2'][1].mentions[0].displayName, '演示管理员');
});

test.beforeEach(() => {
  resetDemoState();
});

test('demo backend exposes chat, contacts, admin, storage and Telegram fixture data', async () => {
	const [site, session, bootstrap, contacts, overview, storage, telegram] = await Promise.all([
    requestDemo('/site'),
    requestDemo('/auth/session'),
		requestDemo('/bootstrap'),
		requestDemo('/contacts'),
    requestDemo('/admin/overview'),
    requestDemo('/admin/storage/scan', { method: 'POST', body: '{}' }),
    requestDemo('/admin/telegram')
  ]);

  assert.equal(site.site.siteName, 'EdgeChat Demo');
  assert.equal(session.session.isAdmin, true);
  assert.equal(bootstrap.channels.some((channel) => channel.isGeneral), true);
	assert.equal(bootstrap.dms.length, 1);
	assert.equal(contacts.users.some((user) => user.id === session.session.userId), true);
	assert.equal(contacts.users.some((user) => user.displayName.length > 20), true);
	assert.equal(contacts.users.filter((user) => user.displayName === 'Alice').length, 2);
	assert.equal(contacts.users.some((user) => 'bio' in user || 'isAdmin' in user), false);
	const general = await requestDemo('/channels/1/members');
	assert.equal(general.members.find((member) => member.id === 1).isAdmin, true);
	assert.equal(general.members.find((member) => member.id === 5).isDisabled, true);
  assert.equal(overview.stats.publicChannels + overview.stats.privateChannels, 4);
  assert.equal('channels' in overview, false);
  assert.equal(storage.scannedObjects, 4);
  assert.equal(storage.items.some((item) => item.ownerType === 'telegram'), true);
  assert.equal(telegram.config.configured, true);
  assert.equal(telegram.mappings[0].enabled, true);
  assert.equal(telegram.channels.some((channel) => channel.kind === 'private'), true);
  assert.equal(telegram.channels.every((channel) => channel.kind !== 'dm'), true);
});

test('demo backend keeps group and admin mutations in browser memory', async () => {
  const created = await requestDemo('/channels', {
    method: 'POST',
    body: { name: '演示项目组', kind: 'private', memberUserIds: [2] }
  });
  const invited = await requestDemo(`/channels/${created.channel.id}/invite`, {
    method: 'POST',
    body: { userIds: [3] }
  });
  const user = await requestDemo('/admin/users', {
    method: 'POST',
    body: { username: 'preview', displayName: 'Preview', password: 'demo' }
  });
  const invite = await requestDemo('/admin/register-links', {
    method: 'POST',
    body: { note: '自动化测试', maxUses: 2 }
  });

  assert.equal(created.channel.kind, 'private');
  assert.deepEqual(invited.members.map((member) => member.id), [1, 2, 3]);
  assert.equal(user.user.username, 'preview');
  assert.equal(invite.invite.remainingUses, 2);
});

test('demo admin supports temporary bans, permanent bans and unbanning', async () => {
  const temporary = await requestDemo('/admin/users/2', {
    method: 'PATCH',
    body: { isDisabled: true, banDurationMinutes: 90 }
  });
  assert.equal(temporary.user.isDisabled, true);
  assert.equal(temporary.user.isPermanentlyDisabled, false);
  assert.ok(Date.parse(temporary.user.disabledUntil) > Date.now());

  const permanent = await requestDemo('/admin/users/3', {
    method: 'PATCH',
    body: { isDisabled: true, banDurationMinutes: null }
  });
  assert.equal(permanent.user.isPermanentlyDisabled, true);
  assert.equal(permanent.user.disabledUntil, null);

  const enabled = await requestDemo('/admin/users/2', {
    method: 'PATCH',
    body: { isDisabled: false }
  });
  assert.equal(enabled.user.isDisabled, false);
  assert.equal(enabled.user.disabledUntil, null);
});

test('demo groups use the signed-in user as their owner', async () => {
  await requestDemo('/auth/login', {
    method: 'POST',
    body: { username: 'alice', password: 'demo' }
  });
  const created = await requestDemo('/channels', {
    method: 'POST',
    body: { name: 'Alice 的项目组', kind: 'private', memberUserIds: [3] }
  });
  const members = await requestDemo(`/channels/${created.channel.id}/members`);

  assert.deepEqual(members.members.map((member) => member.id), [2, 3]);
  assert.equal(members.members[0].role, 'owner');
  assert.equal(created.channel.ownerDisplayName, 'Alice');
});

test('demo public groups can be created, discovered and joined', async () => {
  const created = await requestDemo('/channels', {
    method: 'POST',
    body: { name: '公开演示群', kind: 'public', memberUserIds: [] }
  });
  const beforeJoin = await requestDemo('/bootstrap');
  const discoverable = beforeJoin.channels.find((channel) => channel.id === 4);
  const joined = await requestDemo('/channels/4/join', { method: 'POST' });

  assert.equal(created.channel.kind, 'public');
  assert.equal(discoverable.isMember, false);
  assert.equal(joined.channel.isMember, true);
  assert.equal(joined.channel.memberCount, 3);

  await assert.rejects(
    requestDemo('/channels/2/join', { method: 'POST' }),
    /公开群组不存在/
  );
});

test('demo room socket echoes sent messages through the real-time contract', async () => {
  const frames = [];
  const inboxFrames = [];
  const inboxSocket = connectDemoInboxSocket({
    onMessage(frame) {
      inboxFrames.push(JSON.parse(frame));
    },
    onStatus() {}
  });
  let socket;
  await new Promise((resolve) => {
    socket = connectDemoRoomSocket({
      kind: 'public',
      roomId: 1,
      onMessage(frame) {
        frames.push(JSON.parse(frame));
      },
      onStatus(event) {
        if (event.status === 'open') resolve();
      }
    });
  });

	  socket.send(JSON.stringify({
	    type: 'send',
	    content: '@alice 浏览器本地消息',
	    attachment: null,
	    mentionUserIds: [2]
	  }));

  assert.equal(frames.length, 1);
  assert.equal(frames[0].type, 'message');
	  assert.equal(frames[0].message.content, '@alice 浏览器本地消息');
	  assert.equal(frames[0].message.sender.id, 1);
	  assert.deepEqual(frames[0].message.mentionUserIds, [2]);

  const history = await requestDemo('/messages?kind=public&roomId=1');
	  assert.equal(history.messages.at(-1).content, '@alice 浏览器本地消息');
	  assert.equal(history.messages.at(-1).mentions[0].username, 'alice');
  assert.deepEqual(inboxFrames, []);
  socket.close();
  inboxSocket.close();
});

test('demo direct messages honor blocking and resume after unblocking', async () => {
	await requestDemo('/users/2/block', { method: 'PUT' });
	assert.equal((await requestDemo('/bootstrap')).dms[0].isBlockedByMe, true);
	const blocked = (await requestDemo('/users/blocked')).users;
	assert.deepEqual(blocked.map((user) => user.id), [2]);
	assert.deepEqual(Object.keys(blocked[0]).sort(), ['avatarUrl', 'displayName', 'id', 'username']);

	await requestDemo('/auth/login', {
		method: 'POST',
		body: { username: 'alice', password: 'demo' }
	});
	assert.deepEqual((await requestDemo('/users/blocked')).users, [], '反向拉黑不属于本人的列表');
	const frames = [];
	let socket;
	await new Promise((resolve) => {
		socket = connectDemoRoomSocket({
			kind: 'dm',
			roomId: 10,
			onMessage(frame) {
				frames.push(JSON.parse(frame));
			},
			onStatus(event) {
				if (event.status === 'open') resolve();
			}
		});
	});
	const before = (await requestDemo('/messages?kind=dm&roomId=10')).messages.length;
	socket.send(JSON.stringify({ type: 'send', content: 'blocked message' }));
	assert.deepEqual(frames.at(-1), {
		type: 'error',
		error: '发送被拒，你已经被拉黑'
	});
	assert.equal((await requestDemo('/messages?kind=dm&roomId=10')).messages.length, before);

	await requestDemo('/auth/login', {
		method: 'POST',
		body: { username: 'admin', password: 'demo' }
	});
	await requestDemo('/users/2/block', { method: 'DELETE' });
	assert.deepEqual((await requestDemo('/users/blocked')).users, []);
	assert.equal((await requestDemo('/bootstrap')).dms[0].isBlockedByMe, false);
	await requestDemo('/auth/login', {
		method: 'POST',
		body: { username: 'alice', password: 'demo' }
	});
	socket.send(JSON.stringify({ type: 'send', content: 'restored message' }));
	assert.equal(frames.at(-1).type, 'message');
	assert.equal(frames.at(-1).message.content, 'restored message');
	socket.close();
});

test('demo retries confirm one canonical message without rebroadcasting', async () => {
  const frames = [];
  const peerFrames = [];
  const connect = target => new Promise(resolve => {
    const socket = connectDemoRoomSocket({ kind: 'dm', roomId: 10,
      onMessage: frame => target.push(JSON.parse(frame)),
      onStatus: event => { if (event.status === 'open') resolve(socket); }
    });
  });
  const socket = await connect(frames);
  const peer = await connect(peerFrames);
  const frame = JSON.stringify({ type: 'send', content: 'optimistic', clientMessageId: crypto.randomUUID() });
  socket.send(frame);
  socket.send(frame);
  assert.equal(frames.length, 2);
  assert.equal(peerFrames.length, 1);
  assert.deepEqual(frames[0], frames[1]);
  assert.equal(frames[0].message.clientMessageId, JSON.parse(frame).clientMessageId);
  socket.close();
  peer.close();
});

test('demo room socket persists pin, unpin and pinned-message deletion', async () => {
  const frames = [];
  let socket;
  await new Promise((resolve) => {
    socket = connectDemoRoomSocket({
      kind: 'public',
      roomId: 1,
      onMessage(frame) {
        frames.push(JSON.parse(frame));
      },
      onStatus(event) {
        if (event.status === 'open') resolve();
      }
    });
  });

  socket.send(JSON.stringify({ type: 'pin_message', messageId: 104 }));
  assert.equal(frames.at(-1).type, 'message_pinned');
  assert.equal((await requestDemo('/messages?kind=public&roomId=1')).pinnedMessage.id, 104);

  socket.send(JSON.stringify({ type: 'unpin_message', messageId: 104 }));
  assert.equal(frames.at(-1).type, 'message_unpinned');
  assert.equal((await requestDemo('/messages?kind=public&roomId=1')).pinnedMessage, null);

  socket.send(JSON.stringify({ type: 'pin_message', messageId: 103 }));
  socket.send(JSON.stringify({ type: 'delete_message', messageId: 103 }));
  assert.equal((await requestDemo('/messages?kind=public&roomId=1')).pinnedMessage, null);
  socket.close();
});

test('Telegram replies increment the inbox unread projection', async () => {
  const inboxFrames = [];
  await requestDemo('/messages/read', {
    method: 'POST',
    body: { kind: 'public', roomId: 3 }
  });
  const inboxSocket = connectDemoInboxSocket({
    onMessage(frame) {
      inboxFrames.push(JSON.parse(frame));
    },
    onStatus() {}
  });
  let roomSocket;
  await new Promise((resolve) => {
    roomSocket = connectDemoRoomSocket({
      kind: 'public',
      roomId: 3,
      onMessage() {},
      onStatus(event) {
        if (event.status === 'open') resolve();
      }
    });
  });

  roomSocket.send(JSON.stringify({ type: 'send', content: 'Telegram 未读测试' }));
  await new Promise((resolve) => setTimeout(resolve, 720));

	  assert.equal(inboxFrames.at(-1).unreadCount, 1);
	  assert.equal(inboxFrames.at(-1).mentionUnreadCount, 1);
	  assert.equal(inboxFrames.at(-1).replyToMe, true);
	  assert.equal(inboxFrames.at(-1).mentionsMe, false);
  assert.equal(inboxFrames.at(-1).room.name, demoState.copy.telegramName);
  roomSocket.close();
  inboxSocket.close();
});

test('demo Telegram bridge accepts a private group mapping', async () => {
  const state = await requestDemo('/admin/telegram/mappings', {
    method: 'POST',
    body: { channelId: 2, telegramChatId: '-1002345678902' }
  });
  assert.equal(state.mappings.at(-1).channelKind, 'private');

  const frames = [];
  let roomSocket;
  await new Promise((resolve) => {
    roomSocket = connectDemoRoomSocket({
      kind: 'private',
      roomId: 2,
      onMessage(frame) {
        frames.push(JSON.parse(frame));
      },
      onStatus(event) {
        if (event.status === 'open') resolve();
      }
    });
  });

  roomSocket.send(JSON.stringify({ type: 'send', content: '私有群桥接测试' }));
  await new Promise((resolve) => setTimeout(resolve, 720));

  assert.equal(
    frames.some((frame) => frame.message?.sender?.source === 'telegram'),
    true
  );
  roomSocket.close();
});
