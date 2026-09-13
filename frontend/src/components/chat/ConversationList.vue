<script setup>
import { AtSign, BellOff } from "@lucide/vue";
import { t } from "../../i18n.js";
import UiAvatar from "../ui/Avatar.vue";

defineProps({
	items: {
		type: Array,
		default: () => [],
	},
	activeKey: {
		type: String,
		default: "",
	},
	loading: {
		type: Boolean,
		default: false,
	},
	isRoomMuted: {
		type: Function,
		default: () => false,
	},
});

const emit = defineEmits(["select"]);
</script>

<template>
	<div class="sidebar-section sidebar-list">
		<div v-if="loading" class="sidebar-hint">
			{{ t("chat.loadingConversations") }}
		</div>
		<div v-else-if="!items.length" class="sidebar-hint">
			{{ t("chat.noConversations") }}
		</div>
		<button
			v-for="item in items"
			:key="item.key"
			type="button"
			class="sidebar-item"
			:class="{ 'sidebar-item--active': activeKey === item.key, 'sidebar-item--unread': item.unreadCount > 0 }"
			:aria-current="activeKey === item.key ? 'true' : undefined"
			:title="item.title"
			@click="emit('select', item)"
		>
			<UiAvatar
				:src="item.avatarUrl"
				:fallback="item.fallback?.[0] || '?'"
				size="sm"
			/>
			<div class="sidebar-label-group">
				<div class="sidebar-item__top">
					<strong>{{ item.title }}</strong>
					<span class="sidebar-item__time">{{ item.dateLabel }}</span>
				</div>
				<div class="sidebar-item__bottom">
					<p class="sidebar-item__preview">{{ item.subtitle }}</p>
					<span
						v-if="isRoomMuted(item)"
						class="sidebar-muted-indicator"
						:title="t('chat.muted')"
						:aria-label="t('chat.muted')"
					>
						<BellOff :size="14" aria-hidden="true" />
						</span>
						<span v-if="item.mentionUnreadCount > 0" class="sidebar-mention-badge">
							<AtSign :size="13" aria-hidden="true" />
							{{ t("chat.mentionedMe") }}
						</span>
						<span v-if="item.unreadCount > 0" class="sidebar-unread-badge">
						{{ item.unreadCount > 99 ? "99+" : item.unreadCount }}
					</span>
				</div>
			</div>
		</button>
	</div>
</template>

<style scoped>
.sidebar-list {
	flex: 1;
	min-height: 0;
	overflow-y: auto;
	overflow-x: hidden;
	padding: 0 0 8px;
	scrollbar-gutter: stable;
	touch-action: pan-y;
}

.sidebar-list::-webkit-scrollbar {
	width: 4px;
}

.sidebar-list::-webkit-scrollbar-thumb {
	border-radius: 2px;
	background: var(--chat-scrollbar);
}

.sidebar-hint {
	display: flex;
	align-items: center;
	justify-content: center;
	padding: 24px 8px;
	color: var(--chat-subtle);
	font-size: 13px;
}

.sidebar-item {
	display: flex;
	align-items: center;
	gap: 12px;
	width: calc(100% - 24px);
	min-height: 80px;
	margin: 2px 12px;
	padding: 12px;
	border: none;
	border-radius: 12px;
	background: transparent;
	cursor: pointer;
	text-align: left;
	touch-action: manipulation;
	transition: background 150ms;
}

.sidebar-item:hover {
	background: var(--chat-hover);
}

.sidebar-item:active {
	background: rgba(0, 0, 0, 0.08);
}

.sidebar-item--active,
.sidebar-item--active:hover {
	background: var(--chat-selected);
	box-shadow: inset 3px 0 var(--chat-accent);
}

.sidebar-item:focus-visible {
	outline: 2px solid var(--chat-accent);
	outline-offset: -2px;
}

/* biome-ignore lint/correctness/noUnknownPseudoClass: Vue deep selector */
.sidebar-item :deep(.ui-avatar) {
	flex-shrink: 0;
	width: 44px;
	height: 44px;
	border-radius: 50%;
	box-shadow: none;
}

.sidebar-label-group {
	flex: 1;
	min-width: 0;
}

.sidebar-item__top {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
}

.sidebar-item__top strong {
	overflow: hidden;
	color: var(--chat-ink);
	font-size: 15px;
	font-weight: 500;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.sidebar-item__time {
	flex-shrink: 0;
	color: var(--chat-muted);
	font-size: 12px;
	font-variant-numeric: tabular-nums;
}

.sidebar-item__bottom {
	display: flex;
	align-items: center;
	gap: 8px;
	min-width: 0;
	margin-top: 6px;
}

.sidebar-item__preview {
	flex: 1;
	min-width: 0;
	margin: 0;
	overflow: hidden;
	color: var(--chat-muted);
	font-size: 13px;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.sidebar-item--unread .sidebar-item__preview {
	color: var(--chat-ink);
}

.sidebar-item--unread .sidebar-item__top strong {
	font-weight: 700;
}

.sidebar-item--unread .sidebar-item__time {
	color: var(--chat-accent);
	font-weight: 600;
}

.sidebar-muted-indicator {
	display: inline-flex;
	flex: 0 0 auto;
	align-items: center;
	justify-content: center;
	color: var(--chat-subtle);
}

.sidebar-unread-badge {
	display: inline-flex;
	flex-shrink: 0;
	align-items: center;
	justify-content: center;
	min-width: 22px;
	height: 22px;
	padding: 0 6px;
	border-radius: 999px;
	background: var(--chat-accent);
	color: var(--chat-paper);
	font-size: 11px;
	font-variant-numeric: tabular-nums;
	font-weight: 700;
	line-height: 1;
}

.sidebar-mention-badge {
	display: inline-flex;
	flex: 0 0 auto;
	align-items: center;
	gap: 2px;
	color: var(--chat-danger);
	font-size: 11px;
	font-weight: 700;
	white-space: nowrap;
}

@media (max-width: 960px) {
	.sidebar-list {
		padding-bottom: max(8px, env(safe-area-inset-bottom));
		overscroll-behavior: contain;
		scrollbar-gutter: auto;
	}

	.sidebar-item {
		width: 100%;
		min-height: 80px;
		margin: 0;
		padding: 11px max(16px, env(safe-area-inset-right)) 11px
			max(16px, env(safe-area-inset-left));
		border-radius: 0;
	}

	/* 分隔线从正文起笔，避免头像和内容被粗重的整行边框割开。 */
	.sidebar-item { position: relative; }
	.sidebar-item + .sidebar-item::before {
		content: "";
		position: absolute;
		top: 0;
		right: 16px;
		left: 72px;
		height: 1px;
		background: var(--chat-line);
	}
}

@media (prefers-reduced-motion: reduce) {
	.sidebar-item {
		transition: none;
	}
}
</style>
