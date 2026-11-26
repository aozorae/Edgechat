<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import DOMPurify from "dompurify";
import type Vditor from "vditor";
import { t } from "../../i18n.js";
import { parseMarkdownImageUrl } from "../../markdown-image.ts";
import type { EdgeChatVditorRuntime } from "../../vditor-runtime.ts";
import type { MentionUser } from "../../mentions.ts";
import { installVditorContentSafety } from "../../vditor-content-safety.ts";
import { buildVditorMentionHints } from "../../vditor-mention-hints.ts";
import { getClipboardFiles } from "./clipboard-files.js";

const props = defineProps<{
	modelValue: string;
	disabled?: boolean;
	mentionCandidates?: MentionUser[];
	placeholder: string;
	runtime: EdgeChatVditorRuntime;
}>();
const emit = defineEmits<{
	"update:modelValue": [value: string];
	ready: [];
	"initialization-error": [];
	send: [];
	upload: [files: File[]];
}>();

const host = ref<HTMLElement | null>(null);
const imageLinkError = ref("");
let editor: Vditor | null = null;
let initialized = false;
let alive = true;
let initializationTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
let transferTarget: HTMLElement | null = null;

function mentionHints(query: string) {
	return buildVditorMentionHints(props.mentionCandidates || [], query);
}

function syncValue() {
	if (!initialized || !editor) return props.modelValue;
	const value = editor.getValue();
	if (value !== props.modelValue) emit("update:modelValue", value);
	return value;
}

function insertImageLink() {
	if (!editor || props.disabled) return;
	imageLinkError.value = "";
	const input = window.prompt(t("composer.imageLinkPrompt"));
	if (!input?.trim()) return;
	const url = parseMarkdownImageUrl(input.trim());
	if (!url) {
		imageLinkError.value = t("composer.invalidImageLink");
		return;
	}
	editor.focus();
	editor.insertMD(`![${t("composer.imageAlt")}](<${url.href}>)`);
	syncValue();
}

function stopImagePopover(event: MouseEvent) {
	// Vditor 的原生浮层直接修改 img.src，绕过编辑 DOM 的链接校验。
	if (event.target instanceof HTMLImageElement) event.stopPropagation();
}

function clipboardText(data: DataTransfer | null) {
	if (!data) return "";
	const plainText = data.getData("text/plain");
	if (plainText) return plainText;
	const html = data.getData("text/html");
	if (!html) return "";
	// 仅在剪贴板没有纯文本时处理 HTML；只保留文本和图片说明，不保留可加载的 src。
	const fragment = DOMPurify.sanitize(html, {
		ALLOWED_TAGS: ["img"],
		ALLOWED_ATTR: ["alt"],
		RETURN_DOM_FRAGMENT: true,
	});
	for (const image of fragment.querySelectorAll("img")) {
		image.replaceWith(document.createTextNode(image.getAttribute("alt") || ""));
	}
	return fragment.textContent || "";
}

function insertTransferredText(event: ClipboardEvent | DragEvent) {
	if (!editor) return;
	const data = "clipboardData" in event ? event.clipboardData : event.dataTransfer;
	const files = getClipboardFiles(data);
	const text = files.length ? data?.getData("text/plain") : clipboardText(data);
	event.preventDefault();
	event.stopImmediatePropagation();
	if (props.disabled) return;
	if (text) editor.insertMD(text);
	if (files.length) emit("upload", files);
	queueMicrotask(syncValue);
}

function applyDisabledState(disabled: boolean | undefined) {
	if (!initialized || !editor) return;
	if (disabled) editor.disabled();
	else editor.enable();
}

onMounted(() => {
	if (!host.value) return;
	initializationTimer = globalThis.setTimeout(() => {
		if (alive && !initialized) emit("initialization-error");
	}, 12_000);

	try {
		editor = new props.runtime.Vditor(host.value, {
			cache: { enable: false },
			cdn: props.runtime.cdn,
			height: window.matchMedia("(max-width: 600px)").matches ? 220 : 260,
			hint: {
				delay: 100,
				emoji: {},
				extend: [{ key: "@", hint: mentionHints }],
				// 让补全与草稿、粘贴共用已安装的 Lute 净化出口，不允许直接插入原始 HTML。
				parse: true,
			},
			i18n: props.runtime.i18n,
			icon: undefined,
			image: { isPreview: false },
			link: { isOpen: false },
			minHeight: 180,
			mode: "wysiwyg",
			placeholder: props.placeholder,
			preview: {
				mode: "editor",
				markdown: {
					codeBlockPreview: false,
					footnotes: false,
					mathBlockPreview: false,
					sanitize: true,
					toc: false,
				},
				render: { media: { enable: false } },
			},
			resize: { enable: false },
			toolbar: [
				"bold",
				"italic",
				"strike",
				"headings",
				"|",
				"list",
				"ordered-list",
				"quote",
				"inline-code",
				"code",
				"link",
				{
					name: "image-link",
					tip: t("composer.insertImageLink"),
					tipPosition: "s",
					icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>',
					click: insertImageLink,
				},
				"table",
				"|",
				"undo",
				"redo",
			],
			value: "",
			after() {
				if (!editor) return;
				if (!alive) {
					editor.destroy();
					editor = null;
					return;
				}
				if (initializationTimer !== null) globalThis.clearTimeout(initializationTimer);
				installVditorContentSafety(editor.vditor.lute);
				transferTarget = editor.vditor.wysiwyg.element;
				// 必须在真实编辑节点的捕获阶段截断，才能早于 Vditor 自身的冒泡监听器处理不可信 HTML。
				transferTarget.addEventListener("paste", insertTransferredText, true);
				transferTarget.addEventListener("drop", insertTransferredText, true);
				editor.setValue(props.modelValue, true);
				initialized = true;
				applyDisabledState(props.disabled);
				syncValue();
				editor.focus();
				emit("ready");
			},
			input(value) {
				if (alive && initialized && value !== props.modelValue) {
					emit("update:modelValue", value);
				}
			},
			ctrlEnter(value) {
				if (!alive || props.disabled) return;
				if (value !== props.modelValue) emit("update:modelValue", value);
				emit("send");
			},
		});
	} catch {
		emit("initialization-error");
	}
});

watch(
	() => props.modelValue,
	(value) => {
		if (initialized && editor && value !== editor.getValue()) {
			editor.setValue(value, value.length === 0);
		}
	},
);
watch(() => props.disabled, applyDisabledState);

onBeforeUnmount(() => {
	alive = false;
	if (initializationTimer !== null) globalThis.clearTimeout(initializationTimer);
	syncValue();
	if (transferTarget) {
		transferTarget.removeEventListener("paste", insertTransferredText, true);
		transferTarget.removeEventListener("drop", insertTransferredText, true);
		transferTarget = null;
	}
	if (editor?.vditor) editor.destroy();
	editor = null;
});

defineExpose({
	focus() {
		editor?.focus();
	},
	syncValue,
});
</script>

<template>
	<div ref="host" class="composer-vditor" @click.capture="stopImagePopover"></div>
	<p v-if="imageLinkError" class="composer-image-error" role="alert">{{ imageLinkError }}</p>
</template>

<style scoped>
.composer-vditor {
	width: 100%;
	min-width: 0;
}

.composer-image-error {
	margin: 0.25rem 0;
	color: var(--vditor-error-color, #d23f31);
	font-size: 0.875rem;
}

/* 工具栏在窄屏内部横向滚动，发送与收起按钮始终留在编辑器外部。 */
/* biome-ignore lint/correctness/noUnknownPseudoClass: Vue deep selector */
.composer-vditor :deep(.vditor-toolbar) {
	display: flex;
	flex-wrap: nowrap;
	overflow-x: auto;
	overflow-y: hidden;
	border-radius: 6px 6px 0 0;
	-webkit-overflow-scrolling: touch;
}

/* biome-ignore lint/correctness/noUnknownPseudoClass: Vue deep selector */
.composer-vditor :deep(.vditor-toolbar__item) {
	flex: 0 0 auto;
}

.composer-vditor.vditor {
	border-color: #d8e0dd;
	border-radius: 7px;
	background: #ffffff;
}

/* biome-ignore lint/correctness/noUnknownPseudoClass: Vue deep selector */
.composer-vditor :deep(.vditor-wysiwyg) {
	overflow-x: auto;
	font-size: 15px;
}

</style>
