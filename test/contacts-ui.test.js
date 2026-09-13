import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { useContacts } from "../frontend/src/composables/useContacts.ts";

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("通讯录摘要按名称稳定排序并同时搜索显示名与用户名", async () => {
	let calls = 0;
	const contacts = useContacts({
		async getContacts() {
			calls += 1;
			return { users: [
				{ id: 4, username: "zulu", displayName: "Same", avatarUrl: "" },
				{ id: 2, username: "alpha", displayName: "Same", avatarUrl: "" },
				{ id: 3, username: "needle-account", displayName: "Beta", avatarUrl: "" },
			] };
		},
	});
	await contacts.load();
	await contacts.load();
	assert.equal(calls, 1, "首次加载后不重复读取目录");
	assert.deepEqual(contacts.filteredUsers.value.map((user) => user.id), [3, 2, 4]);
	contacts.query.value = "NEEDLE";
	assert.deepEqual(contacts.filteredUsers.value.map((user) => user.id), [3]);
	contacts.query.value = "same";
	assert.deepEqual(contacts.filteredUsers.value.map((user) => user.id), [2, 4]);
	contacts.query.value = "";
	assert.equal(contacts.filteredUsers.value.length, 3);
});

test("通讯录失败状态可重试且不会把失败投影为空列表", async () => {
	let calls = 0;
	const contacts = useContacts({
		async getContacts() {
			calls += 1;
			if (calls === 1) throw new Error("offline");
			return { users: [{ id: 1, username: "self", displayName: "Self", avatarUrl: "" }] };
		},
	});
	await contacts.load();
	assert.equal(contacts.error.value, "offline");
	assert.equal(contacts.loading.value, false);
	await contacts.load(true);
	assert.equal(contacts.error.value, "");
	assert.equal(contacts.filteredUsers.value.length, 1);
	contacts.dispose();
	await flush();
});

test("通讯录页面只渲染头像和一个名字并复用资料卡与工作区生命周期", () => {
	const read = (path) => readFileSync(new URL(`../frontend/src/${path}`, import.meta.url), "utf8");
	const page = read("pages/ContactsPage.vue");
	const chat = read("pages/ChatPage.vue");
	const app = read("App.vue");
	const router = read("router.js");
	assert.match(page, /<UiAvatar/);
	assert.match(page, /<span>\{\{ user\.displayName \|\| user\.username \}\}<\/span>/);
	assert.doesNotMatch(page, /user\.bio|createdAt|lastActive|send-message/);
	assert.match(page, /@click="emit\('openProfile', user\)"/);
	assert.match(page, /min-height:\s*80px/);
	assert.match(page, /text-overflow:\s*ellipsis/);
	assert.match(page, /safe-area-inset-bottom/);
	assert.match(router, /path:\s*'\/contacts'[\s\S]*component:\s*ChatPage/);
	assert.match(app, /route\.meta\.workspace \? 'workspace' : route\.path/);
	assert.match(chat, /activeRoom:\s*inboxActiveRoom/);
	assert.match(chat, /roomVisible:\s*computed\(\(\) => !isContactsView\.value\)/);
	assert.match(chat, /inboxActiveRoom = computed\(\(\) => isContactsView\.value \? null : activeRoom\.value\)/);
	assert.match(chat, /watch\(isContactsView,[\s\S]*pauseRoom\(\)[\s\S]*activateRoom\(\)/);
	assert.match(chat, /v-if="!isContactsView" class="chat-main"/);
	assert.match(chat, /v-if="contactsVisited"[\s\S]*v-show="isContactsView"/);
});
