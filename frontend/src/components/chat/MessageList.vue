<script setup lang="ts">
import MessageRow from "./MessageRow.vue";
import type { MessageSender, MessageView } from "./message-view.ts";

defineProps<{
	messages: MessageView[];
	currentUserId?: number;
	isDirect: boolean;
	highlightedMessageId: number | null;
}>();

// 将列表与草稿、通话计时、菜单等页面状态隔开，避免每次输入都遍历历史消息。
const emit = defineEmits<{
	profile: [sender: MessageSender];
	retry: [clientMessageId: string];
	reveal: [messageId: number | string | null | undefined];
	contextmenu: [event: MouseEvent, message: MessageView];
	"long-press": [event: PointerEvent, message: MessageView];
	"track-press": [event: PointerEvent];
	"cancel-press": [];
}>();
</script>

<template>
	<MessageRow
		v-for="msg in messages"
		:key="msg.clientMessageId ? `${msg.sender.kind === 'external' ? 'external' : 'local'}:${msg.sender.id}:${msg.clientMessageId}` : msg.id"
		:msg="msg"
		:current-user-id="currentUserId"
		:is-direct="isDirect"
		:highlighted="Number(highlightedMessageId) === Number(msg.id)"
		@profile="emit('profile', $event)"
		@retry="emit('retry', $event)"
		@reveal="emit('reveal', $event)"
		@contextmenu="(event, message) => emit('contextmenu', event, message)"
		@long-press="(event, message) => emit('long-press', event, message)"
		@track-press="emit('track-press', $event)"
		@cancel-press="emit('cancel-press')"
	/>
</template>
