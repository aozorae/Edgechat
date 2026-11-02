import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { compileScript, parse } from "@vue/compiler-sfc";
import { stripTypeScriptTypes } from "node:module";
import { createRenderer, h, nextTick, ref } from "vue";
import { formatTime, setLocale } from "../frontend/src/i18n.js";

// 编译真实 SFC 到 Vue 自定义 renderer；无需给生产或 CI 增加 DOM/浏览器依赖。
const componentUrls = new Map();
async function componentUrl(name) {
	if (componentUrls.has(name)) return componentUrls.get(name);
	const url = new URL(`../frontend/src/components/${name}.vue`, import.meta.url);
	const { descriptor } = parse(await readFile(url, "utf8"), { filename: url.pathname });
	const script = compileScript(descriptor, { id: name, inlineTemplate: true });
	let code = stripTypeScriptTypes(script.content);
	for (const match of [...code.matchAll(/from (["'])([^"']+)\1/g)]) {
		const specifier = match[2];
		let target;
		if (!specifier.startsWith(".")) target = import.meta.resolve(specifier);
		else if (specifier.endsWith("/MessageRow.vue")) target = await componentUrl("chat/MessageRow");
		else if (specifier.endsWith(".vue")) {
			// 子功能已有独立测试，此处只隔离 DOMPurify/音频等浏览器能力，不替换列表和行。
			const childName = specifier.split("/").pop().replace(".vue", "");
			target = `data:text/javascript,${encodeURIComponent(`import { h } from ${JSON.stringify(import.meta.resolve("vue"))}; export default { inheritAttrs: false, render() { return h(${JSON.stringify(childName)}, this.$attrs); } }`)}`;
		} else target = new URL(specifier, url).href;
		code = code.replace(match[0], `from ${JSON.stringify(target)}`);
	}
	const result = `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
	componentUrls.set(name, result);
	return result;
}

function node(type, text = "") {
	return { type, text, children: [], props: {}, style: {}, parent: null };
}
function remove(element) {
	element.parent.children.splice(element.parent.children.indexOf(element), 1);
	element.parent = null;
}
const renderer = createRenderer({
	createElement: node,
	createText: text => node("#text", text),
	createComment: text => node("#comment", text),
	setText: (element, text) => { element.text = text; },
	setElementText: (element, text) => { element.text = text; element.children = []; },
	patchProp: (element, key, _previous, value) => { element.props[key] = value; },
	insert(element, parent, anchor) {
		if (element.parent) remove(element);
		const index = parent.children.indexOf(anchor);
		parent.children.splice(index < 0 ? parent.children.length : index, 0, element);
		element.parent = parent;
	},
	remove,
	parentNode: element => element.parent,
	nextSibling: element => element.parent?.children[element.parent.children.indexOf(element) + 1] || null,
});

function descendants(element, predicate) {
	return [element, ...element.children.flatMap(child => descendants(child, () => true))].filter(predicate);
}
function byClass(root, name) {
	return descendants(root, element => String(element.props.class).split(" ").includes(name));
}
function message(id) {
	return { id, content: `消息 ${id}`, createdAt: "2026-10-11 02:03:00", sender: { kind: "local", id: 2, displayName: "Alice" } };
}

test("真实消息列表隔离草稿更新，追加/高亮/嵌套变更只更新受影响消息行", async () => {
	const { default: MessageList } = await import(await componentUrl("chat/MessageList"));
	const messages = ref(Array.from({ length: 500 }, (_, i) => message(i + 1)));
	const draft = ref("");
	const highlightedMessageId = ref(null);
	const root = node("root");
	const updates = [];
	const app = renderer.createApp({
		setup: () => () => h("main", [
			h("textarea", { value: draft.value }),
			h(MessageList, { messages: messages.value, currentUserId: 1, isDirect: false, highlightedMessageId: highlightedMessageId.value }),
		]),
	});
	app.mixin({ updated() { updates.push(this.$options.__name); } });
	app.mount(root);
	try {
		for (let i = 0; i < 30; i++) {
			draft.value = `draft ${i}`;
			await nextTick();
		}
		assert.equal(updates.filter(name => name === "MessageList").length, 0);
		assert.equal(updates.filter(name => name === "MessageRow").length, 0);
		assert.equal(byClass(root, "message-row").length, 500);
		updates.length = 0;
		messages.value = [...messages.value, message(501)];
		await nextTick();
		assert.equal(updates.filter(name => name === "MessageList").length, 1);
		assert.equal(updates.filter(name => name === "MessageRow").length, 0);
		assert.equal(byClass(root, "message-row").length, 501);
		updates.length = 0;
		highlightedMessageId.value = 1;
		await nextTick();
		assert.equal(updates.filter(name => name === "MessageRow").length, 1);
		assert.equal(byClass(root, "message-bubble--highlighted").length, 1);
		updates.length = 0;
		highlightedMessageId.value = 2;
		await nextTick();
		assert.equal(updates.filter(name => name === "MessageRow").length, 2);
		updates.length = 0;
		messages.value[0].sender.displayName = "Updated";
		await nextTick();
		assert.equal(updates.filter(name => name === "MessageRow").length, 1);
		assert.ok(descendants(root, element => element.text === "Updated").length);
		updates.length = 0;
		messages.value = [message(0), ...messages.value];
		await nextTick();
		assert.equal(updates.filter(name => name === "MessageRow").length, 0);
		assert.deepEqual(byClass(root, "message-row").slice(0, 3).map(row => row.props["data-message-id"]), [0, 1, 2]);
		messages.value = messages.value.slice(1);
		await nextTick();
		assert.equal(byClass(root, "message-row").length, 501);
	} finally {
		app.unmount();
	}
});

test("消息行保留本人/外部身份、私聊姓名隐藏、语言切换及全部交互事件", async () => {
	const { default: MessageList } = await import(await componentUrl("chat/MessageList"));
	const messages = ref([message(1)]);
	const isDirect = ref(false);
	const currentUserId = ref(1);
	const events = [];
	const root = node("root");
	const app = renderer.createApp({
		setup: () => () => h(MessageList, {
			messages: messages.value, isDirect: isDirect.value, currentUserId: currentUserId.value, highlightedMessageId: null,
			onProfile: sender => events.push(["profile", sender]),
			onContextmenu: (event, msg) => events.push(["contextmenu", event, msg]),
			onLongPress: (event, msg) => events.push(["long-press", event, msg]),
			onTrackPress: event => events.push(["track-press", event]),
			onCancelPress: () => events.push(["cancel-press"]),
			onReveal: id => events.push(["reveal", id]),
		}),
	});
	app.mount(root);
	try {
		const event = { clientX: 12, clientY: 24 };
		byClass(root, "message-avatar-trigger")[0].props.onClick();
		const bubble = byClass(root, "message-bubble")[0];
		bubble.props.onContextmenu(event);
		bubble.props.onPointerdown(event);
		bubble.props.onPointermove(event);
		bubble.props.onPointerup();
		bubble.props.onPointercancel();
		assert.deepEqual(events.map(([name]) => name), ["profile", "contextmenu", "long-press", "track-press", "cancel-press", "cancel-press"]);
		assert.equal(events[0][1], messages.value[0].sender);
		assert.equal(events[1][1], event);
		assert.equal(events[1][2], messages.value[0]);
		messages.value[0].replyTo = { id: 7, content: "original", sender: message(7).sender };
		messages.value[0].replyToMessageId = 7;
		messages.value[0].attachment = { name: "clip.webm", type: "audio/webm", kind: "voice" };
		messages.value[0].mentions = [{ userId: 1, username: "self" }];
		await nextTick();
		const child = name => descendants(root, element => element.type === name)[0];
		child("MessageReplyPreview").props.onReveal();
		assert.deepEqual(events.at(-1), ["reveal", 7]);
		assert.equal(child("MessageAttachment").props.attachment, messages.value[0].attachment);
		assert.equal(child("MessageMarkdown").props.mentions, messages.value[0].mentions);
		messages.value[0] = { ...messages.value[0], content: "changed", replyTo: { id: 7, deleted: true }, attachment: null };
		await nextTick();
		assert.equal(child("MessageReplyPreview").props.clickable, false);
		assert.equal(child("MessageReplyPreview").props.reply.deleted, true);
		assert.equal(child("MessageMarkdown").props.content, "changed");
		assert.equal(child("MessageAttachment"), undefined);
		assert.equal(byClass(root, "message-sender-name").length, 1);
		isDirect.value = true;
		await nextTick();
		assert.equal(byClass(root, "message-sender-name").length, 0);
		currentUserId.value = 2;
		await nextTick();
		assert.equal(byClass(root, "message-row--own").length, 1);
		assert.equal(byClass(root, "message-avatar-trigger").length, 0);
		messages.value[0].sender.kind = "external";
		await nextTick();
		assert.equal(byClass(root, "message-row--own").length, 0);
		for (const locale of ["en-US", "zh-TW", "zh-CN"]) {
			await setLocale(locale);
			await nextTick();
			assert.equal(byClass(root, "message-time")[0].text, formatTime(messages.value[0].createdAt));
		}
	} finally {
		app.unmount();
	}
});

test("乐观消息状态可见、禁用管理动作，重试事件贯通且确认不重建气泡", async () => {
	const { default: MessageList } = await import(await componentUrl("chat/MessageList"));
	const messages = ref([{ ...message("local:uuid"), clientMessageId: "uuid", sendStatus: "pending" }]);
	const events = [];
	const root = node("root");
	const app = renderer.createApp({ setup: () => () => h(MessageList, {
		messages: messages.value, currentUserId: 2, isDirect: true, highlightedMessageId: null,
		onRetry: id => events.push(["retry", id]),
		onContextmenu: () => events.push(["contextmenu"]),
		onLongPress: () => events.push(["long-press"]),
	}) });
	app.mount(root);
	try {
		const bubble = byClass(root, "message-bubble")[0];
		assert.equal(byClass(root, "message-delivery").length, 1);
		assert.equal(byClass(root, "message-time").length, 0);
		bubble.props.onContextmenu({});
		bubble.props.onPointerdown({});
		assert.deepEqual(events, []);
		messages.value[0] = { ...messages.value[0], sendStatus: "failed", sendError: "Try again" };
		await nextTick();
		const button = descendants(root, element => element.type === "button")[0];
		assert.ok(button.props["aria-label"]);
		button.props.onClick();
		assert.deepEqual(events, [["retry", "uuid"]]);
		messages.value[0] = { ...message(12), clientMessageId: "uuid" };
		await nextTick();
		assert.equal(byClass(root, "message-bubble")[0], bubble);
		assert.equal(byClass(root, "message-delivery").length, 0);
		assert.equal(byClass(root, "message-time").length, 1);
	} finally { app.unmount(); }
});

test("真实 Textarea 每次输入只读取一次高度，外部清空和恢复草稿仍自动增高", async () => {
	const { default: Textarea } = await import(await componentUrl("ui/Textarea"));
	const value = ref("");
	const root = node("root");
	const app = renderer.createApp({
		setup: () => () => h(Textarea, { modelValue: value.value, autoGrow: true, maxHeight: 100, "onUpdate:modelValue": next => { value.value = next; } }),
	});
	app.mount(root);
	try {
		const textarea = root.children[0];
		let reads = 0;
		Object.defineProperty(textarea, "scrollHeight", { get() { reads++; return value.value ? 150 : 30; } });
		textarea.props.onInput({ target: { value: "多行草稿" } });
		await nextTick();
		assert.equal(reads, 1);
		assert.equal(textarea.style.height, "100px");
		assert.equal(textarea.style.overflowY, "auto");
		value.value = "";
		await nextTick();
		assert.equal(reads, 2);
		assert.equal(textarea.style.height, "30px");
		assert.equal(textarea.style.overflowY, "hidden");
		value.value = "恢复草稿";
		await nextTick();
		assert.equal(reads, 3);
		assert.equal(textarea.style.height, "100px");
	} finally {
		app.unmount();
	}
});
