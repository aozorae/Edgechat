<script setup>
import { ChevronDown, LoaderCircle, Mic, Paperclip, Send, Trash2, Type, X } from "@lucide/vue";
import { computed, markRaw, nextTick, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { isCapacitorAndroid, openNativeAppSettings, pickNativeFile } from "../../capacitor-platform.ts";
import { getLocale, t } from "../../i18n.js";
import { useVoiceRecorder } from "../../composables/useVoiceRecorder.ts";
import { formatVoiceDuration } from "../../voice-message.js";
import UiTextarea from "../ui/Textarea.vue";
import UiAvatar from "../ui/Avatar.vue";
import PendingAttachmentPreview from "./PendingAttachmentPreview.vue";
import MessageReplyPreview from "./MessageReplyPreview.vue";

const props = defineProps({
	modelValue: {
		type: String,
		default: "",
	},
	pendingAttachment: {
		type: Object,
		default: null,
	},
	sending: {
		type: Boolean,
		default: false,
	},
	disabled: {
		type: Boolean,
		default: false,
	},
	error: {
		type: String,
		default: "",
	},
	mentionCandidates: {
		type: Array,
		default: () => [],
	},
	replyingTo: {
		type: Object,
		default: null,
	},
	contextKey: {
		type: String,
		default: "",
	},
});

const emit = defineEmits([
	"update:modelValue",
	"send",
	"upload",
	"clear-attachment",
	"voice-recorded",
	"cancel-reply",
]);
const fileInput = ref(null);
const textarea = ref(null);
const mentionStart = ref(-1);
const mentionQuery = ref("");
const activeMentionIndex = ref(0);
const recordingError = ref("");
const pickerError = ref("");
const showPermissionSettings = ref(false);
const finishingRecording = ref(false);
const composing = ref(false);
const richEditor = ref(null);
const richEditorComponent = shallowRef(null);
const richEditorRuntime = shallowRef(null);
const richEditorOpen = ref(false);
const richEditorReady = ref(false);
const richEditorLoading = ref(false);
const richEditorLoadError = ref("");
let richEditorLoadGeneration = 0;
let componentAlive = true;
const { recording, starting, elapsedMs, liveWaveform, start, finish, cancel } = useVoiceRecorder();
const filteredMentions = computed(() => {
	const query = mentionQuery.value.toLocaleLowerCase();
	return props.mentionCandidates
		.filter((member) => {
			if (!query) return true;
			return [member.username, member.displayName].some((value) =>
				String(value || "").toLocaleLowerCase().includes(query),
			);
		})
		.slice(0, 8);
});
const mentionMenuOpen = computed(
	() => mentionStart.value >= 0 && filteredMentions.value.length > 0,
);
const sendDisabled = computed(
	() =>
		props.disabled ||
		props.sending ||
		starting.value ||
		(!props.modelValue.trim() && !props.pendingAttachment),
);
// 房间切换或连接失效时不允许继续采集上一段语音。
watch(() => props.disabled, (disabled) => {
	if (disabled) void cancel();
});

function handleKeydown(event) {
	// 输入法的 Enter 用来确认候选，不应触发发送或选择 @成员。
	if (composing.value || event.isComposing || event.keyCode === 229) return;
	if (mentionMenuOpen.value) {
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			const direction = event.key === "ArrowDown" ? 1 : -1;
			activeMentionIndex.value =
				(activeMentionIndex.value + direction + filteredMentions.value.length) %
				filteredMentions.value.length;
			return;
		}
		if (event.key === "Enter" || event.key === "Tab") {
			event.preventDefault();
			selectMention(filteredMentions.value[activeMentionIndex.value]);
			return;
		}
		if (event.key === "Escape") {
			event.preventDefault();
			closeMentionMenu();
			return;
		}
	}
	if (event.key === "Enter" && !event.shiftKey) {
		event.preventDefault();
		if (sendDisabled.value) {
			return;
		}
			void requestSend();
	}
	if (event.key === "Escape" && props.replyingTo) {
		event.preventDefault();
		emit("cancel-reply");
	}
}

function cancelRichEditorLoad() {
	richEditorLoadGeneration += 1;
	richEditorLoading.value = false;
}

async function openRichEditor() {
	if (richEditorOpen.value || richEditorLoading.value || props.disabled) return;
	const generation = ++richEditorLoadGeneration;
	richEditorLoading.value = true;
	richEditorLoadError.value = "";
	closeMentionMenu();

	try {
		const [runtimeModule, componentModule] = await Promise.all([
			import("../../vditor-runtime.ts"),
			import("./VditorComposerEditor.vue"),
		]);
		const runtime = await runtimeModule.loadVditorRuntime(getLocale());
		if (!componentAlive || generation !== richEditorLoadGeneration) return;
		richEditorRuntime.value = markRaw(runtime);
		richEditorComponent.value = markRaw(componentModule.default);
		richEditorReady.value = false;
		richEditorOpen.value = true;
	} catch {
		if (!componentAlive || generation !== richEditorLoadGeneration) return;
		richEditorLoadError.value = t("composer.richEditorLoadFailed");
	} finally {
		if (componentAlive && generation === richEditorLoadGeneration) {
			richEditorLoading.value = false;
		}
	}
}

function collapseRichEditor({ restoreFocus = true } = {}) {
	richEditorLoadGeneration += 1;
	richEditorLoading.value = false;
	richEditor.value?.syncValue();
	richEditorOpen.value = false;
	richEditorReady.value = false;
	if (restoreFocus) nextTick(() => textarea.value?.focus());
}

function toggleRichEditor() {
	if (richEditorLoading.value) {
		cancelRichEditorLoad();
		return;
	}
	if (richEditorOpen.value) collapseRichEditor();
	else void openRichEditor();
}

function handleRichEditorInitializationError() {
	collapseRichEditor({ restoreFocus: false });
	richEditorLoadError.value = t("composer.richEditorLoadFailed");
}

async function requestSend() {
	if (richEditorOpen.value) {
		richEditor.value?.syncValue();
		await nextTick();
	}
	if (!sendDisabled.value) emit("send");
}

function syncMentionQuery(event) {
	const input = event.target;
	const cursor = input.selectionStart;
	const match = input.value.slice(0, cursor).match(/(^|[\s([{])@([^\s@]*)$/u);
	if (!match || props.mentionCandidates.length === 0) {
		closeMentionMenu();
		return;
	}
	mentionQuery.value = match[2];
	mentionStart.value = cursor - match[2].length - 1;
	activeMentionIndex.value = 0;
}

function closeMentionMenu() {
	mentionStart.value = -1;
	mentionQuery.value = "";
	activeMentionIndex.value = 0;
}

function selectMention(member) {
	if (!member || mentionStart.value < 0) return;
	const input = textarea.value?.element;
	const cursor = input?.selectionStart ?? props.modelValue.length;
	const replacement = `@${member.username} `;
	const nextValue =
		props.modelValue.slice(0, mentionStart.value) +
		replacement +
		props.modelValue.slice(cursor);
	const nextCursor = mentionStart.value + replacement.length;
	emit("update:modelValue", nextValue);
	closeMentionMenu();
	nextTick(() => {
		textarea.value?.focus();
		textarea.value?.element?.setSelectionRange(nextCursor, nextCursor);
	});
}

async function openPicker() {
	pickerError.value = "";
	if (!isCapacitorAndroid) {
		fileInput.value?.click();
		return;
	}

	try {
		const file = await pickNativeFile();
		if (file) emit("upload", file);
	} catch {
		pickerError.value = t("chat.fileSelectionFailed");
	}
}

function handleFileSelected(event) {
	const file = event.target.files?.[0];
	if (file) emit("upload", file);
	event.target.value = "";
}

async function startVoiceRecording() {
	recordingError.value = "";
	showPermissionSettings.value = false;
	closeMentionMenu();
	richEditor.value?.syncValue();
	try {
		await start();
	} catch (error) {
		const permissionDenied =
			error?.message === "native_microphone_permission_denied" ||
			error?.name === "NotAllowedError" ||
			error?.name === "SecurityError";
		showPermissionSettings.value = isCapacitorAndroid && permissionDenied;
		recordingError.value = t(
			error?.message === "voice_recording_unsupported"
				? "voice.unsupported"
				: permissionDenied
					? isCapacitorAndroid ? "voice.nativePermissionDenied" : "voice.permissionDenied"
					: error?.name === "NotFoundError"
						? "voice.noMicrophone"
						: "voice.startFailed",
		);
	}
}

async function openMicrophoneSettings() {
	try {
		await openNativeAppSettings();
	} catch {
		recordingError.value = t("voice.settingsFailed");
	}
}

async function cancelVoiceRecording() {
	await cancel();
}

async function sendVoiceRecording() {
	if (finishingRecording.value || props.disabled || props.sending) return;
	finishingRecording.value = true;
	try {
		const result = await finish();
		if (!result) return;
		if (result.durationMs < 500) {
			recordingError.value = t("voice.tooShort");
			return;
		}
		emit("voice-recorded", result);
	} catch {
		await cancel();
		recordingError.value = t("voice.startFailed");
	} finally {
		finishingRecording.value = false;
	}
}

defineExpose({
	focus() {
		if (richEditorOpen.value) richEditor.value?.focus();
		else textarea.value?.focus();
	},
});

watch(
	() => props.contextKey,
	() => {
		richEditorLoadError.value = "";
		if (richEditorOpen.value) collapseRichEditor({ restoreFocus: false });
		else cancelRichEditorLoad();
	},
);

onBeforeUnmount(() => {
	componentAlive = false;
	richEditorLoadGeneration += 1;
	richEditor.value?.syncValue();
});
</script>

<template>
	<footer class="message-composer">
		<div v-if="replyingTo" class="composer-reply">
			<MessageReplyPreview :reply="replyingTo" />
			<button
				type="button"
				class="composer-reply__cancel"
				:title="t('messages.cancelReply')"
				:aria-label="t('messages.cancelReply')"
				@click="emit('cancel-reply')"
			>
				<X :size="18" aria-hidden="true" />
			</button>
		</div>
			<div v-if="pendingAttachment" class="composer-attachment">
			<PendingAttachmentPreview
				:attachment="pendingAttachment"
				@clear="emit('clear-attachment')"
			/>
		</div>
			<div v-if="error || recordingError || pickerError" class="composer-error" role="alert">
				<span>{{ error || recordingError || pickerError }}</span>
				<button v-if="showPermissionSettings" type="button" class="composer-settings" @click="openMicrophoneSettings">{{ t('voice.openSettings') }}</button>
			</div>
			<div v-if="starting" class="composer-permission" role="status">
				<span>{{ t('voice.requestingPermission') }}</span>
				<button type="button" class="composer-btn" :aria-label="t('voice.cancel')" @click="cancelVoiceRecording">
					<X :size="20" aria-hidden="true" />
				</button>
			</div>
			<div v-if="mentionMenuOpen && !richEditorOpen" class="mention-menu" role="listbox">
			<button
				v-for="(member, index) in filteredMentions"
				:key="member.id"
				type="button"
				class="mention-option"
				:class="{ 'mention-option--active': index === activeMentionIndex }"
				role="option"
				:aria-selected="index === activeMentionIndex"
				@mousedown.prevent
				@click="selectMention(member)"
			>
				<UiAvatar
					:src="member.avatarUrl"
					:fallback="member.displayName || member.username"
					size="xs"
				/>
				<span class="mention-option__label">
					<strong>{{ member.displayName }}</strong>
					<small>@{{ member.username }}</small>
				</span>
			</button>
		</div>
			<div v-if="richEditorLoading" class="composer-editor-status" role="status">
				<LoaderCircle :size="16" class="composer-spinner" aria-hidden="true" />
				<span>{{ t('composer.richEditorLoading') }}</span>
				<button type="button" @click="cancelRichEditorLoad">{{ t('common.cancel') }}</button>
			</div>
			<div v-else-if="richEditorLoadError" class="composer-editor-status composer-editor-status--error" role="alert">
				<span>{{ richEditorLoadError }}</span>
				<button type="button" @click="openRichEditor">{{ t('common.retry') }}</button>
			</div>
			<input
				ref="fileInput"
				type="file"
				class="composer-file-input"
				@change="handleFileSelected"
			/>
			<div v-if="recording" class="composer-recording" :aria-label="t('voice.recording')">
					<button type="button" class="composer-btn composer-recording__cancel" :disabled="finishingRecording" :title="t('voice.cancel')" :aria-label="t('voice.cancel')" @click="cancelVoiceRecording">
					<Trash2 :size="20" aria-hidden="true" />
				</button>
					<div class="composer-recording__status">
						<span class="composer-recording__dot" aria-hidden="true"></span>
						<span>{{ t('voice.recordingShort') }}</span>
						<span class="composer-recording__time">{{ formatVoiceDuration(elapsedMs) }}</span>
					</div>
				<div class="composer-recording__wave" aria-hidden="true">
					<span v-for="(sample, index) in liveWaveform" :key="index" :style="{ height: `${Math.max(18, sample)}%` }"></span>
				</div>
					<button type="button" class="composer-send composer-recording__send" :disabled="disabled || sending || finishingRecording" :title="t('voice.send')" :aria-label="t('voice.send')" @click="sendVoiceRecording">
						<Send :size="20" aria-hidden="true" />
						<span>{{ t('chat.send') }}</span>
				</button>
			</div>
			<div v-else-if="richEditorOpen" class="composer-rich-editor">
				<component
					:is="richEditorComponent"
					ref="richEditor"
					:model-value="modelValue"
					:disabled="disabled || starting"
					:mention-candidates="mentionCandidates"
					:placeholder="t('chat.messagePlaceholder')"
					:runtime="richEditorRuntime"
					@update:model-value="emit('update:modelValue', $event)"
					@ready="richEditorReady = true"
					@initialization-error="handleRichEditorInitializationError"
					@send="requestSend"
				/>
				<div v-if="!richEditorReady" class="composer-editor-initializing" role="status">
					<LoaderCircle :size="17" class="composer-spinner" aria-hidden="true" />
					{{ t('composer.richEditorInitializing') }}
				</div>
				<div class="composer-rich-editor__actions">
					<button
						type="button"
						class="composer-btn composer-rich-editor__attachment"
						:disabled="disabled || starting"
						:title="t('chat.addAttachment')"
						:aria-label="t('chat.addAttachment')"
						@click="openPicker"
					>
						<Paperclip :size="20" aria-hidden="true" />
					</button>
					<button
						type="button"
						class="composer-btn composer-btn--active"
						:title="t('composer.collapseRichEditor')"
						:aria-label="t('composer.collapseRichEditor')"
						@click="collapseRichEditor()"
					>
						<ChevronDown :size="21" aria-hidden="true" />
					</button>
					<button
						type="button"
						class="composer-btn composer-voice"
						:disabled="disabled || sending || starting"
						:title="t('voice.record')"
						:aria-label="t('voice.record')"
						@click="startVoiceRecording"
					>
						<Mic :size="21" aria-hidden="true" />
					</button>
					<button
						type="button"
						class="composer-send"
						:disabled="sendDisabled"
						:title="t('chat.sendMessage')"
						:aria-label="t('chat.sendMessage')"
						@click="requestSend"
					>
						<LoaderCircle v-if="sending" :size="20" class="composer-spinner" aria-hidden="true" />
						<Send v-else :size="20" aria-hidden="true" />
						<span>{{ t('chat.send') }}</span>
					</button>
				</div>
			</div>
			<div v-else class="composer-row">
					<button
					type="button"
				class="composer-btn"
				:disabled="disabled || starting"
				:title="t('chat.addAttachment')"
				:aria-label="t('chat.addAttachment')"
				@click="openPicker"
			>
					<Paperclip :size="20" aria-hidden="true" />
				</button>
				<button
					type="button"
					class="composer-btn"
					:class="{ 'composer-btn--active': richEditorLoading }"
					:disabled="disabled || starting"
					:aria-busy="richEditorLoading"
					:title="richEditorLoading ? t('composer.cancelRichEditorLoading') : t('composer.openRichEditor')"
					:aria-label="richEditorLoading ? t('composer.cancelRichEditorLoading') : t('composer.openRichEditor')"
					@click="toggleRichEditor"
				>
					<LoaderCircle v-if="richEditorLoading" :size="20" class="composer-spinner" aria-hidden="true" />
					<Type v-else :size="20" aria-hidden="true" />
				</button>
			<UiTextarea
				ref="textarea"
				:model-value="modelValue"
				class="composer-input"
				auto-grow
				:max-height="120"
				rows="1"
				:disabled="disabled || starting"
				:placeholder="t('chat.messagePlaceholder')"
				:aria-label="t('chat.messagePlaceholder')"
				@update:model-value="emit('update:modelValue', $event)"
				@input="syncMentionQuery"
				@keydown="handleKeydown"
				@compositionstart="composing = true"
				@compositionend="composing = false"
				/>
				<button
					type="button"
					class="composer-btn composer-voice"
					:disabled="disabled || sending || starting"
					:aria-busy="starting"
					:title="t('voice.record')"
					:aria-label="t('voice.record')"
					@click="startVoiceRecording"
				>
					<LoaderCircle v-if="starting" :size="21" class="composer-spinner" aria-hidden="true" />
					<Mic v-else :size="21" aria-hidden="true" />
				</button>
				<button
					type="button"
				class="composer-send"
				:disabled="sendDisabled"
				:title="t('chat.sendMessage')"
				:aria-label="t('chat.sendMessage')"
					@click="requestSend"
			>
				<LoaderCircle v-if="sending" :size="20" class="composer-spinner" aria-hidden="true" />
				<Send v-else :size="20" aria-hidden="true" />
				<span>{{ t('chat.send') }}</span>
			</button>
		</div>
	</footer>
</template>

<style scoped>
.message-composer {
	position: relative;
	z-index: 2;
	flex-shrink: 0;
	min-width: 0;
	margin: auto 0 0;
	padding: 16px 24px 20px;
	border-top: 1px solid var(--chat-line);
	border-radius: 0;
	background: var(--chat-canvas);
}

.composer-attachment {
	min-width: 0;
	margin-bottom: 10px;
}

.composer-reply {
	display: grid;
	grid-template-columns: minmax(0, 1fr) 44px;
	align-items: center;
	gap: 8px;
	margin-bottom: 8px;
}

.composer-reply__cancel {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 44px;
	height: 44px;
	padding: 0;
	border: 0;
	border-radius: 50%;
	background: transparent;
	color: var(--chat-muted);
	cursor: pointer;
}

.composer-reply__cancel:hover,
.composer-reply__cancel:focus-visible {
	background: rgba(0, 0, 0, 0.08);
}

.composer-error {
	margin-bottom: 8px;
	color: var(--chat-danger);
	font-size: 12px;
	text-align: center;
}

.composer-editor-status {
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 8px;
	min-height: 28px;
	margin-bottom: 8px;
	color: var(--chat-muted);
	font-size: 12px;
}

.composer-editor-status--error {
	color: var(--chat-danger);
}

.composer-editor-status button {
	min-height: 44px;
	padding: 2px 8px;
	border: 0;
	border-radius: 4px;
	background: rgba(0, 128, 105, 0.1);
	color: var(--chat-accent);
	font: inherit;
	font-weight: 600;
	cursor: pointer;
}

.composer-settings {
	display: block;
	min-height: 44px;
	margin: 4px auto 0;
	padding: 8px 12px;
	border: 1px solid currentColor;
	border-radius: 8px;
	background: transparent;
	color: inherit;
	font: inherit;
	cursor: pointer;
}

.composer-permission {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
	margin-bottom: 8px;
	color: var(--chat-muted);
	font-size: 14px;
}

.mention-menu {
	position: absolute;
	right: 68px;
	bottom: calc(100% - 2px);
	left: 68px;
	z-index: 4;
	max-height: 280px;
	padding: 6px;
	overflow-y: auto;
	border: 1px solid var(--chat-line);
	border-radius: 8px;
	background: var(--chat-paper);
	box-shadow: 0 10px 28px rgba(17, 27, 33, 0.14);
}

.mention-option {
	display: flex;
	align-items: center;
	gap: 10px;
	width: 100%;
	min-height: 44px;
	padding: 6px 10px;
	border: 0;
	border-radius: 6px;
	background: transparent;
	cursor: pointer;
	text-align: left;
}

.mention-option:hover,
.mention-option--active {
	background: #edf8f2;
}

.mention-option__label {
	display: grid;
	min-width: 0;
}

.mention-option__label strong,
.mention-option__label small {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.mention-option__label strong {
	color: var(--chat-ink);
	font-size: 14px;
	font-weight: 600;
}

.mention-option__label small {
	color: var(--chat-muted);
	font-size: 12px;
}

.composer-row {
	display: flex;
	align-items: flex-end;
	gap: 8px;
	min-width: 0;
	padding: 8px;
	border: 1px solid var(--chat-line);
	border-radius: 24px;
	background: var(--chat-paper);
	box-shadow: var(--chat-shadow);
}

/* 整体焦点边框让输入位置清楚可见，不改变面板大小。 */
.composer-row:focus-within {
	border-color: var(--chat-accent);
}

.composer-rich-editor {
	display: grid;
	gap: 8px;
	min-width: 0;
	padding: 8px;
	border: 1px solid var(--chat-line);
	border-radius: 16px;
	background: var(--chat-paper);
}

.composer-editor-initializing {
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 7px;
	min-height: 32px;
	color: var(--chat-muted);
	font-size: 12px;
}

.composer-rich-editor__actions {
	display: flex;
	align-items: center;
	justify-content: flex-end;
	gap: 8px;
	min-width: 0;
}

.composer-rich-editor__attachment {
	margin-right: auto;
}

.composer-recording {
	display: grid;
	grid-template-columns: 44px minmax(0, 1fr) auto;
	align-items: center;
	gap: 4px 8px;
	min-height: 56px;
}

.composer-recording__cancel {
	grid-row: 1 / 3;
	color: var(--chat-danger);
}

.composer-recording__status {
	display: flex;
	align-items: center;
	gap: 6px;
	min-width: 0;
	color: var(--chat-muted);
	font-size: 12px;
}

.composer-recording__send {
	grid-column: 3;
	grid-row: 1 / 3;
}

.composer-recording__dot {
	width: 8px;
	height: 8px;
	border-radius: 50%;
	background: var(--chat-danger);
	animation: recording-pulse 1.2s ease-in-out infinite;
}

.composer-recording__time {
	min-width: 38px;
	color: var(--chat-ink);
	font-size: 14px;
	font-variant-numeric: tabular-nums;
}

.composer-recording__wave {
	grid-column: 2;
	display: flex;
	align-items: center;
	gap: 2px;
	min-width: 0;
	height: 22px;
	overflow: hidden;
}

.composer-recording__wave span {
	flex: 1 1 2px;
	min-width: 2px;
	max-width: 4px;
	border-radius: 2px;
	background: var(--chat-accent);
}

.composer-voice {
	color: var(--chat-accent);
}

@keyframes recording-pulse {
	50% { opacity: 0.35; }
}

.composer-spinner {
	animation: composer-spin 1s linear infinite;
}

@keyframes composer-spin {
	to { transform: rotate(360deg); }
}

.composer-file-input {
	display: none;
}

.composer-btn,
.composer-send {
	display: flex;
	flex-shrink: 0;
	align-items: center;
	justify-content: center;
	width: 44px;
	height: 44px;
	padding: 0;
	border: none;
	border-radius: 50%;
	background: transparent;
	cursor: pointer;
	touch-action: manipulation;
}

.composer-btn {
	color: var(--chat-muted);
	transition: background 150ms, color 150ms;
}

.composer-btn--active {
	background: rgba(0, 128, 105, 0.1);
	color: var(--chat-accent);
}

.composer-btn:hover:not(:disabled) {
	background: rgba(0, 0, 0, 0.05);
	color: var(--chat-ink);
}

.composer-send {
	width: auto;
	min-width: 72px;
	gap: 6px;
	padding: 0 12px;
	border-radius: 22px;
	background: var(--chat-accent);
	color: var(--chat-paper);
	font: inherit;
	font-size: 14px;
	font-weight: 600;
	white-space: nowrap;
	transition: background 150ms;
}

.composer-send:hover:not(:disabled) {
	background: var(--chat-accent-hover);
}

.composer-btn:active:not(:disabled) {
	background: rgba(0, 0, 0, 0.08);
}

.composer-send:active:not(:disabled) {
	background: var(--chat-accent-pressed);
}

.composer-btn:focus-visible,
.composer-reply__cancel:focus-visible,
.composer-editor-status button:focus-visible,
.mention-option:focus-visible,
.composer-send:focus-visible,
.composer-settings:focus-visible {
	outline: 2px solid var(--chat-accent);
	outline-offset: 2px;
}

.composer-btn:disabled {
	cursor: not-allowed;
	opacity: 0.4;
}

.composer-send:disabled {
	cursor: not-allowed;
	background: var(--chat-disabled);
	color: var(--chat-muted);
}

.composer-input {
	flex: 1;
	min-width: 0;
}

/* biome-ignore lint/correctness/noUnknownPseudoClass: Vue deep selector */
:deep(.composer-input.ui-textarea) {
	width: 100%;
	min-width: 0;
	min-height: 44px;
	padding: 11px 4px;
	border: none;
	border-radius: 8px;
	background: var(--chat-paper);
	box-shadow: none;
	color: var(--chat-ink);
	font-size: 16px;
	line-height: 1.4;
	resize: none;
}

/* biome-ignore lint/correctness/noUnknownPseudoClass: Vue deep selector */
:deep(.composer-input.ui-textarea:focus) {
	border-color: transparent;
	box-shadow: none;
}

/* biome-ignore lint/correctness/noUnknownPseudoClass: Vue deep selector */
:deep(.composer-input.ui-textarea::placeholder) {
	color: var(--chat-subtle);
}

@media (max-width: 960px) {
	.message-composer {
		padding: 8px max(8px, env(safe-area-inset-right))
			max(8px, env(safe-area-inset-bottom))
			max(8px, env(safe-area-inset-left));
	}

	.mention-menu {
		right: max(56px, env(safe-area-inset-right));
		left: max(56px, env(safe-area-inset-left));
	}

		.composer-row {
			gap: 4px;
			padding: 4px;
			border-radius: 20px;
		}

	.composer-rich-editor__actions {
		gap: 4px;
	}

		.composer-recording {
			gap: 4px 8px;
		}

	.composer-btn {
		width: 44px;
		height: 44px;
	}

	/* biome-ignore lint/correctness/noUnknownPseudoClass: Vue deep selector */
	:deep(.composer-input.ui-textarea) {
		min-height: 44px;
		padding: 11px 4px;
		font-size: 16px;
	}
}

@media (max-width: 480px) {
	/* 窄屏输入单独占一行，防止四个工具按钮把 320px 的文字区挤到不可用。 */
	.composer-row {
		display: grid;
		grid-template-columns: 44px 44px minmax(0, 1fr) auto;
		gap: 4px;
	}
	.composer-input { grid-column: 1 / -1; grid-row: 1; }
	.composer-row .composer-voice { justify-self: end; }
	/* biome-ignore lint/correctness/noUnknownPseudoClass: Vue deep selector */
	:deep(.composer-input.ui-textarea) { padding: 11px 12px; }
	.mention-menu { left: 8px; right: 8px; }
}

@media (prefers-reduced-motion: reduce) {
	.composer-btn,
		.composer-send,
		.composer-spinner,
	.composer-recording__dot {
		transition: none;
		animation: none;
	}
}
</style>
