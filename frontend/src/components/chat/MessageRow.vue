<script setup lang="ts">
import { computed } from "vue";
import { Clock3, RotateCw } from "@lucide/vue";
import { formatTime, t } from "../../i18n.js";
import UiAvatar from "../ui/Avatar.vue";
import MessageAttachment from "./MessageAttachment.vue";
import MessageMarkdown from "./MessageMarkdown.vue";
import MessageReplyPreview from "./MessageReplyPreview.vue";
import SenderSourceBadge from "./SenderSourceBadge.vue";
import SenderTitleBadge from "./SenderTitleBadge.vue";
import type { MessageSender, MessageView } from "./message-view.ts";

const props = defineProps<{
	msg: MessageView;
	currentUserId?: number;
	isDirect: boolean;
	highlighted: boolean;
}>();
const emit = defineEmits<{
	profile: [sender: MessageSender];
	retry: [clientMessageId: string];
	reveal: [messageId: number | string | null | undefined];
	contextmenu: [event: MouseEvent, message: MessageView];
	"long-press": [event: PointerEvent, message: MessageView];
	"track-press": [event: PointerEvent];
	"cancel-press": [];
}>();

// 每行依赖自身消息，而不是整个列表；追加消息时旧行无需重新生成气泡。
const own = computed(() => props.msg.sender.kind !== "external"
	&& Number(props.msg.sender.id) === Number(props.currentUserId));
const time = computed(() => props.msg.createdAt ? formatTime(props.msg.createdAt) : "");
</script>

<template>
	<article :data-message-id="msg.id" class="message-row message-row--actionable" :class="{ 'message-row--own': own }">
		<button
			v-if="!own"
			type="button"
			class="profile-avatar-trigger message-avatar-trigger"
			:aria-label="t('profile.view', { name: msg.sender.displayName })"
			@click="emit('profile', msg.sender)"
		>
			<UiAvatar class="message-avatar" :src="msg.sender.avatarUrl" :alt="msg.sender.displayName" :fallback="msg.sender.displayName" size="sm" />
		</button>
		<div
			class="message-bubble"
			:class="{ 'message-bubble--with-attachment': msg.attachment, 'message-bubble--highlighted': highlighted }"
			@contextmenu="!msg.sendStatus && emit('contextmenu', $event, msg)"
			@pointerdown="!msg.sendStatus && emit('long-press', $event, msg)"
			@pointermove="emit('track-press', $event)"
			@pointerup="emit('cancel-press')"
			@pointercancel="emit('cancel-press')"
		>
			<div v-if="!isDirect && !own" class="message-sender-name">
				<span>{{ msg.sender.displayName }}</span>
				<SenderTitleBadge :identity="msg.sender" />
				<SenderSourceBadge :source="msg.sender.source" :instance="msg.sender.sourceInstance" />
			</div>
			<MessageReplyPreview
				v-if="msg.replyTo"
				class="message-bubble__reply"
				:reply="msg.replyTo"
				:clickable="!msg.replyTo.deleted"
				@reveal="emit('reveal', msg.replyToMessageId)"
			/>
			<MessageMarkdown v-if="msg.content" :content="msg.content" :mentions="msg.mentions" :current-user-id="currentUserId" />
			<MessageAttachment v-if="msg.attachment" :attachment="msg.attachment" />
			<div v-if="msg.sendStatus" class="message-delivery" role="status">
				<template v-if="msg.sendStatus === 'pending'"><Clock3 :size="13" /><span>{{ t('chat.messagePending') }}</span></template>
				<template v-else>
					<span>{{ msg.sendError || t('chat.messageUnconfirmed') }}</span>
					<button type="button" :aria-label="t('chat.retryMessage')" :title="t('chat.retryMessage')" @click="emit('retry', msg.clientMessageId!)"><RotateCw :size="16" /></button>
				</template>
			</div>
			<span v-else class="message-time">{{ time }}</span>
		</div>
	</article>
</template>

<style scoped>
.message-row {
  display: flex;
  align-items: flex-end;
  gap: 10px;
  margin-bottom: 16px;
  width: 100%;
  justify-content: flex-start;
}
.message-row--own { justify-content: flex-end; }
.message-bubble--highlighted {
  outline: 3px solid rgba(var(--site-brand-rgb, 0, 128, 105), 0.3);
  outline-offset: 3px;
  transition: outline-color 180ms ease;
}
.message-avatar-trigger {
  position: relative;
  min-width: 34px;
  min-height: 34px;
}
/* 扩大触摸命中区域，但保留原有 34px 头像与气泡排版。 */
.message-avatar-trigger::before {
  content: "";
  position: absolute;
  inset: -5px;
  border-radius: 50%;
}
.message-avatar {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  box-shadow: none;
}
.message-bubble {
  min-width: 0;
  max-width: min(76%, 620px);
  padding: 10px 12px 8px;
  border-radius: 14px 14px 14px 4px;
  background: var(--chat-paper);
  border: none;
  position: relative;
  word-break: break-word;
  box-shadow: var(--chat-shadow);
}
.message-row--actionable .message-bubble {
  touch-action: pan-y;
  -webkit-touch-callout: none;
}
.message-bubble--with-attachment { padding-bottom: 20px; }
.message-row--own .message-bubble {
  background: var(--chat-outgoing);
  border-radius: 14px 14px 4px 14px;
}
.message-sender-name {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--chat-accent);
  margin-bottom: 4px;
  overflow-wrap: anywhere;
  min-width: 0;
}
.message-time {
  position: absolute;
  right: 8px;
  bottom: 6px;
  font-size: 11px;
  line-height: 1;
  color: var(--chat-muted);
  white-space: nowrap;
  user-select: none;
}
.message-bubble__reply { margin-bottom: 5px; }
.message-delivery {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  margin-top: 6px;
  font-size: 12px;
  color: var(--chat-muted);
}
.message-delivery svg { flex-shrink: 0; }
.message-delivery button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 44px;
  height: 44px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--chat-accent);
  cursor: pointer;
}
.message-delivery button:hover { background: var(--chat-paper); }
.message-delivery button:focus-visible { outline: 2px solid var(--chat-accent); }
@media (max-width: 960px) {
  .message-row { gap: 8px; margin-bottom: 12px; }
  .message-bubble { max-width: calc(100% - 44px); }
}
@media (max-width: 380px) {
  .message-bubble { max-width: calc(100% - 40px); }
}
@media (prefers-reduced-motion: reduce) {
  .message-bubble--highlighted { transition: none; }
}
</style>
