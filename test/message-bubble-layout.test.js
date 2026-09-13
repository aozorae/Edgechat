import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const chatPage = readFileSync(
	new URL("../frontend/src/pages/ChatPage.vue", import.meta.url),
	"utf8",
).replaceAll("\r\n", "\n");
const avatarComponent = readFileSync(
	new URL("../frontend/src/components/ui/Avatar.vue", import.meta.url),
	"utf8",
).replaceAll("\r\n", "\n");
const replyPreview = readFileSync(
	new URL("../frontend/src/components/chat/MessageReplyPreview.vue", import.meta.url),
	"utf8",
).replaceAll("\r\n", "\n");
const messageMarkdown = readFileSync(
	new URL("../frontend/src/components/chat/MessageMarkdown.vue", import.meta.url),
	"utf8",
).replaceAll("\r\n", "\n");

function getStyleRule(selector) {
	const marker = `${selector} {`;
	const start = chatPage.indexOf(marker);
	assert.notEqual(start, -1, `聊天页缺少样式规则：${selector}`);
	const end = chatPage.indexOf("}", start + marker.length);
	assert.notEqual(end, -1, `聊天页样式规则未闭合：${selector}`);
	return chatPage.slice(start, end + 1);
}

test("短文本消息为右下角时间戳预留末行空间", () => {
	assert.match(
		chatPage,
		/'message-bubble--with-attachment': msg\.attachment/,
	);
	assert.match(
		chatPage,
		/'message-bubble--highlighted': Number\(highlightedMessageId\) === Number\(msg\.id\)/,
	);

	const bubble = getStyleRule(".message-bubble");
	assert.match(bubble, /padding:\s*10px 12px 8px;/);

	const attachmentBubble = getStyleRule(".message-bubble--with-attachment");
	assert.match(attachmentBubble, /padding-bottom:\s*20px;/);

	const time = getStyleRule(".message-time");
	assert.match(time, /position:\s*absolute;/);
	assert.match(time, /white-space:\s*nowrap;/);

	assert.match(
		messageMarkdown,
		/\.message-markdown::after\s*{[^}]*display:\s*inline-block;[^}]*width:\s*3\.5em;/s,
	);
});

test("非本人消息在气泡前显示圆形发送者头像", () => {
	assert.match(chatPage, /<button\s+v-if="!isOwnMessage\(msg\)"/);
	assert.match(chatPage, /class="profile-avatar-trigger message-avatar-trigger"/);
	assert.match(chatPage, /<UiAvatar class="message-avatar"/);
	assert.match(chatPage, /:src="msg\.sender\.avatarUrl"/);
	assert.match(chatPage, /:fallback="msg\.sender\.displayName"/);

	const row = getStyleRule(".message-row");
	assert.match(row, /align-items:\s*flex-end;/);
	assert.match(row, /gap:\s*10px;/);

	const avatar = getStyleRule(".message-avatar");
	assert.match(avatar, /width:\s*34px;/);
	assert.match(avatar, /height:\s*34px;/);
	assert.match(avatar, /border-radius:\s*50%;/);
});

test("远程头像加载失败时显示姓名缩写", () => {
	assert.match(avatarComponent, /const showImage = computed/);
	assert.match(avatarComponent, /failedSrc\.value !== props\.src/);
	assert.match(avatarComponent, /@error="handleImageError"/);
});

test("回复气泡显示引用预览并复用消息定位能力", () => {
	assert.match(chatPage, /<MessageReplyPreview/);
	assert.match(chatPage, /@reveal="revealMessage\(msg\.replyToMessageId\)"/);
	assert.match(chatPage, /:replying-to="replyingTo"/);
	assert.match(replyPreview, /border-left:\s*3px solid #008069;/);
	assert.match(replyPreview, /messages\.replyDeleted/);
});
