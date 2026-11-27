<script setup lang="ts">
import { Download, File, FileArchive, FileSpreadsheet, FileText, Presentation } from "@lucide/vue";
import { computed } from "vue";
import { formatByteSize } from "../../file-size.ts";
import { t } from "../../i18n.js";
import { describeFileAttachment } from "./file-attachment.ts";
import type { MessageAttachmentView } from "./message-view.ts";

const props = defineProps<{ attachment: MessageAttachmentView; href: string; name: string }>();

const icons = {
	archive: FileArchive,
	document: FileText,
	spreadsheet: FileSpreadsheet,
	presentation: Presentation,
	pdf: FileText,
	file: File,
};

const file = computed(() => describeFileAttachment(props.attachment));
const size = computed(() => props.attachment.size == null ? "" : formatByteSize(props.attachment.size));
</script>

<template>
	<a class="file-attachment-card" :data-file-group="file.group" :href="href" :title="name" :download="name" target="_blank" rel="noreferrer">
		<span class="file-attachment-card__icon" aria-hidden="true">
			<component :is="icons[file.group]" :size="23" :stroke-width="1.8" />
		</span>
		<span class="file-attachment-card__details">
			<span class="file-attachment-card__name" dir="auto">{{ name }}</span>
			<span class="file-attachment-card__meta">
				{{ file.format || t('attachments.fallback') }}<template v-if="size"> · {{ size }}</template>
			</span>
		</span>
		<Download class="file-attachment-card__download" :size="17" aria-hidden="true" />
	</a>
</template>

<style scoped>
.file-attachment-card {
	--file-accent: #526275;
	display: flex;
	align-items: center;
	gap: 10px;
	box-sizing: border-box;
	width: 260px;
	max-width: 100%;
	padding: 7px 10px 7px 7px;
	border: 1px solid var(--chat-line);
	border-radius: 12px;
	background: var(--chat-hover);
	color: var(--chat-ink);
	text-decoration: none;
}

.file-attachment-card[data-file-group="archive"] { --file-accent: #98601d; }
.file-attachment-card[data-file-group="document"] { --file-accent: #2e65a5; }
.file-attachment-card[data-file-group="spreadsheet"] { --file-accent: #267456; }
.file-attachment-card[data-file-group="presentation"],
.file-attachment-card[data-file-group="pdf"] { --file-accent: #a84939; }

.file-attachment-card:hover { background: var(--chat-selected); }
.file-attachment-card:focus-visible {
	outline: 2px solid var(--chat-accent);
	outline-offset: 2px;
}

.file-attachment-card__icon {
	display: grid;
	flex: 0 0 42px;
	place-items: center;
	height: 42px;
	border-radius: 50%;
	background: var(--file-accent);
	color: #fff;
}

.file-attachment-card__details {
	display: grid;
	flex: 1;
	gap: 3px;
	min-width: 0;
}

.file-attachment-card__name,
.file-attachment-card__meta {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.file-attachment-card__name {
	font-size: 14px;
	font-weight: 600;
	line-height: 1.25;
}

.file-attachment-card__meta {
	color: var(--chat-muted);
	font-size: 12px;
	line-height: 1.25;
}

.file-attachment-card__download {
	flex: none;
	color: var(--chat-muted);
}
</style>
