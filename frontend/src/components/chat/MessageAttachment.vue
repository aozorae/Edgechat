<script setup>
import { computed, ref, watch } from 'vue';
import api from '../../api.js';
import { useOverlayLifecycle } from '../../composables/useOverlayLifecycle.js';
import { t } from '../../i18n.js';
import { isPdfAttachment, isPreviewableImageAttachment, isVideoAttachment } from './attachment-utils.js';
import { isAudioAttachment } from '../../voice-message.js';
import FileAttachmentCard from './FileAttachmentCard.vue';
import VoiceMessage from './VoiceMessage.vue';

const props = defineProps({
  attachment: {
    type: Object,
    required: true
  }
});

const previewOpen = ref(false);
const previewEl = ref(null);
const imageFailed = ref(false);
const isImage = computed(() => isPreviewableImageAttachment(props.attachment));
const isAudio = computed(() => isAudioAttachment(props.attachment));
const isVideo = computed(() => isVideoAttachment(props.attachment));
const isPdf = computed(() => isPdfAttachment(props.attachment));
const mediaFailed = ref(false);
const displayName = computed(() => props.attachment?.name || t('attachments.fallback'));
const openOriginalLabel = computed(() => t('attachments.openOriginalNamed', { name: displayName.value }));
const attachmentUrl = computed(() => api.getFileUrl(props.attachment?.key || props.attachment?.url));

useOverlayLifecycle({
  open: previewOpen,
  onClose: closePreview,
  focusTarget: previewEl
});

function openPreview() {
  if (!isImage.value || imageFailed.value) {
    return;
  }

  previewOpen.value = true;
}

function closePreview() {
  previewOpen.value = false;
}

watch(
  () => props.attachment?.key || props.attachment?.url,
  () => {
    imageFailed.value = false;
    mediaFailed.value = false;
  }
);
</script>

<template>
	  <div class="message-attachment" :class="{ 'message-attachment--image': isImage, 'message-attachment--audio': isAudio }">
	    <VoiceMessage v-if="isAudio" :attachment="attachment" />
	    <template v-else-if="isImage">
      <button
        v-if="!imageFailed"
        type="button"
        class="message-attachment__image-button"
        :aria-label="t('attachments.previewNamed', { name: displayName })"
        @click="openPreview"
      >
        <img
          class="message-attachment__image"
          :src="attachmentUrl"
          :alt="displayName"
          loading="lazy"
          @error="imageFailed = true"
        />
      </button>
      <a
        v-else
        :href="attachmentUrl"
        target="_blank"
        rel="noreferrer"
        class="chat-bubble__attachment message-attachment__file"
      >
        {{ displayName }}
      </a>

      <Teleport to="body">
        <div
          v-if="previewOpen"
          ref="previewEl"
          class="image-preview-overlay"
          role="dialog"
          aria-modal="true"
          :aria-label="t('attachments.imagePreviewNamed', { name: displayName })"
          tabindex="-1"
          @click.self="closePreview"
        >
          <div class="image-preview-overlay__toolbar">
            <span class="image-preview-overlay__title">{{ displayName }}</span>
            <a
              class="image-preview-overlay__action"
              :href="attachmentUrl"
              target="_blank"
              rel="noreferrer"
              :aria-label="openOriginalLabel"
            >
              {{ t('attachments.openOriginal') }}
            </a>
            <button type="button" class="image-preview-overlay__close" :aria-label="t('attachments.closePreview')" @click="closePreview">
              {{ t('common.close') }}
            </button>
          </div>
          <img class="image-preview-overlay__image" :src="attachmentUrl" :alt="displayName" />
        </div>
      </Teleport>
    </template>

    <template v-else-if="isVideo || isPdf">
      <!-- biome-ignore lint/a11y/useMediaCaption: Uploaded files do not include caption tracks. -->
      <video
        v-if="isVideo && !mediaFailed"
        class="message-attachment__video"
        :src="attachmentUrl"
        controls
        playsinline
        preload="metadata"
        :aria-label="displayName"
        @error="mediaFailed = true"
      ></video>
      <!-- biome-ignore lint/a11y/useIframeTitle: Vue binds the attachment filename as the title. -->
      <iframe
        v-else-if="isPdf"
        class="message-attachment__pdf"
        :src="attachmentUrl"
        :title="displayName"
        loading="lazy"
        referrerpolicy="no-referrer"
      ></iframe>
      <FileAttachmentCard v-if="isPdf" class="message-attachment__pdf-download" :attachment="attachment" :href="attachmentUrl" :name="displayName" />
      <a v-else :href="attachmentUrl" target="_blank" rel="noreferrer" class="chat-bubble__attachment message-attachment__file">{{ displayName }}</a>
    </template>
    <FileAttachmentCard v-else :attachment="attachment" :href="attachmentUrl" :name="displayName" />
  </div>
</template>
