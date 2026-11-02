<script setup>
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import api from '../api.js';
import store from '../store.js';
import TelegramNotificationSettings from '../components/settings/TelegramNotificationSettings.vue';
import VisualEffectsSettings from '../components/settings/VisualEffectsSettings.vue';
import UiAvatar from '../components/ui/Avatar.vue';
import LanguageSwitch from '../components/ui/LanguageSwitch.vue';
import { isCapacitorAndroid, pickNativeFile } from '../capacitor-platform.ts';
import { useI18n } from '../i18n.js';
import { BIO_MAX_LENGTH, bioLength, normalizeBio } from '../../../shared/user-profile.ts';

const router = useRouter();
const { t } = useI18n();
const session = computed(() => store.session);
const showAdminEntry = computed(() => Boolean(session.value?.canAccessAdmin));

const profileForm = reactive({
  displayName: session.value?.displayName || '',
  bio: session.value?.bio || '',
  customBackground: localStorage.getItem('customBackground') || ''
});
const profileBioLength = computed(() => bioLength(profileForm.bio));
const passwordForm = reactive({
  currentPassword: '',
  newPassword: ''
});

const info = ref('');
const error = ref('');
const savingProfile = ref(false);
const savingPassword = ref(false);
const uploadingAvatar = ref(false);
const avatarInputEl = ref(null);
const showCropper = ref(false);
const cropperCanvas = ref(null);
const cropZoom = ref(1);
const cropFile = ref(null);
const cropImageUrl = ref('');
const cropImage = ref(null);
const cropOffset = reactive({ x: 0, y: 0 });
const cropDragging = ref(false);
const cropDragStart = reactive({ x: 0, y: 0 });
const cropOffsetStart = reactive({ x: 0, y: 0 });

const CANVAS_SIZE = 280;
const CROP_SIZE = 240;

function clearMessage() {
  info.value = '';
  error.value = '';
}

async function saveProfile() {
  clearMessage();
  if (savingProfile.value) return;
  if (profileBioLength.value > BIO_MAX_LENGTH) {
    error.value = t('profile.bioTooLong');
    return;
  }
  savingProfile.value = true;
  try {
    const submittedBio = profileForm.bio;
    const payload = await api.updateProfile({
      displayName: profileForm.displayName,
      bio: normalizeBio(submittedBio)
    });
    store.setSession(payload.session);
    // 只规范化这次已保存的输入，头像更新与请求期间的新编辑不能重置草稿。
    if (profileForm.bio === submittedBio) profileForm.bio = payload.session.bio;
    if (profileForm.customBackground) {
      localStorage.setItem('customBackground', profileForm.customBackground);
      document.body.style.background = profileForm.customBackground;
    } else {
      localStorage.removeItem('customBackground');
      document.body.style.background = '';
    }
    info.value = t('settings.profileUpdated');
  } catch (currentError) {
    error.value = currentError.message;
  } finally {
    savingProfile.value = false;
  }
}

async function openAvatarPicker() {
  if (!isCapacitorAndroid) {
    avatarInputEl.value?.click();
    return;
  }

  clearMessage();
  try {
    const file = await pickNativeFile('image/*');
    if (file) prepareAvatarFile(file);
  } catch {
    error.value = t('chat.fileSelectionFailed');
  }
}

function onAvatarFileSelected(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  prepareAvatarFile(file);
}

function prepareAvatarFile(file) {
  cropFile.value = file;
  const url = URL.createObjectURL(file);
  cropImageUrl.value = url;
  cropZoom.value = 1;
  cropOffset.x = 0;
  cropOffset.y = 0;
  showCropper.value = true;
}

watch(showCropper, async (visible) => {
  if (!visible) return;
  await nextTick();
  const img = new Image();
  img.onload = () => {
    cropImage.value = img;
    drawCropCanvas();
  };
  img.src = cropImageUrl.value;
});

function drawCropCanvas() {
  const canvas = cropperCanvas.value;
  if (!canvas || !cropImage.value) return;
  const ctx = canvas.getContext('2d');
  const img = cropImage.value;

  const baseScale = Math.max(CANVAS_SIZE / img.naturalWidth, CANVAS_SIZE / img.naturalHeight);
  const totalScale = baseScale * cropZoom.value;

  const drawW = img.naturalWidth * totalScale;
  const drawH = img.naturalHeight * totalScale;
  const drawX = (CANVAS_SIZE - drawW) / 2 + cropOffset.x;
  const drawY = (CANVAS_SIZE - drawH) / 2 + cropOffset.y;

  const cropLeft = (CANVAS_SIZE - CROP_SIZE) / 2;
  const cropTop = (CANVAS_SIZE - CROP_SIZE) / 2;

  ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

  ctx.save();
  ctx.beginPath();
  ctx.rect(cropLeft, cropTop, CROP_SIZE, CROP_SIZE);
  ctx.clip();
  ctx.drawImage(img, drawX, drawY, drawW, drawH);
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = '#1a2332';
  ctx.fillRect(0, 0, CANVAS_SIZE, cropTop);
  ctx.fillRect(0, cropTop + CROP_SIZE, CANVAS_SIZE, CANVAS_SIZE - cropTop - CROP_SIZE);
  ctx.fillRect(0, cropTop, cropLeft, CROP_SIZE);
  ctx.fillRect(cropLeft + CROP_SIZE, cropTop, CANVAS_SIZE - cropLeft - CROP_SIZE, CROP_SIZE);
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
  ctx.lineWidth = 2;
  ctx.strokeRect(cropLeft, cropTop, CROP_SIZE, CROP_SIZE);
  ctx.restore();
}

watch(() => cropZoom.value, () => { if (showCropper.value) drawCropCanvas(); });
watch(() => cropOffset.x, () => { if (showCropper.value) drawCropCanvas(); });
watch(() => cropOffset.y, () => { if (showCropper.value) drawCropCanvas(); });

function onCropPointerDown(event) {
  event.preventDefault();
  cropDragging.value = true;
  cropDragStart.x = event.clientX;
  cropDragStart.y = event.clientY;
  cropOffsetStart.x = cropOffset.x;
  cropOffsetStart.y = cropOffset.y;
}

function onCropPointerMove(event) {
  if (!cropDragging.value) return;
  event.preventDefault();
  cropOffset.x = cropOffsetStart.x + (event.clientX - cropDragStart.x);
  cropOffset.y = cropOffsetStart.y + (event.clientY - cropDragStart.y);
}

function onCropPointerUp() {
  cropDragging.value = false;
}

onBeforeUnmount(() => {
  cropDragging.value = false;
});

function getCroppedBlob() {
  const exportCanvas = document.createElement('canvas');
  exportCanvas.width = CROP_SIZE;
  exportCanvas.height = CROP_SIZE;
  const ctx = exportCanvas.getContext('2d');
  const img = cropImage.value;

  const baseScale = Math.max(CANVAS_SIZE / img.naturalWidth, CANVAS_SIZE / img.naturalHeight);
  const totalScale = baseScale * cropZoom.value;

  const drawW = img.naturalWidth * totalScale;
  const drawH = img.naturalHeight * totalScale;
  const drawX = (CANVAS_SIZE - drawW) / 2 + cropOffset.x;
  const drawY = (CANVAS_SIZE - drawH) / 2 + cropOffset.y;

  const cropLeft = (CANVAS_SIZE - CROP_SIZE) / 2;
  const cropTop = (CANVAS_SIZE - CROP_SIZE) / 2;

  const sourceX = Math.max(0, (cropLeft - drawX) / totalScale);
  const sourceY = Math.max(0, (cropTop - drawY) / totalScale);
  const sourceW = Math.min(img.naturalWidth - sourceX, CROP_SIZE / totalScale);
  const sourceH = Math.min(img.naturalHeight - sourceY, CROP_SIZE / totalScale);

  ctx.drawImage(img, sourceX, sourceY, sourceW, sourceH, 0, 0, CROP_SIZE, CROP_SIZE);

  return new Promise((resolve) => {
    exportCanvas.toBlob((blob) => resolve(blob), 'image/png', 0.92);
  });
}

async function confirmCrop() {
  clearMessage();
  uploadingAvatar.value = true;
  showCropper.value = false;
  try {
    const blob = await getCroppedBlob();
    const file = new File([blob], 'avatar.png', { type: 'image/png' });
    const upload = await api.uploadFile(file);
    const payload = await api.updateProfile({
      avatarKey: upload.file.key
    });
    store.setSession(payload.session);
    info.value = t('settings.avatarUpdated');
  } catch (currentError) {
    error.value = currentError.message;
  } finally {
    uploadingAvatar.value = false;
    cleanupCrop();
  }
}

async function removeAvatar() {
  clearMessage();
  uploadingAvatar.value = true;
  try {
    const payload = await api.updateProfile({
      avatarKey: null
    });
    store.setSession(payload.session);
    info.value = t('settings.avatarRemoved');
  } catch (currentError) {
    error.value = currentError.message;
  } finally {
    uploadingAvatar.value = false;
  }
}

function cancelCrop() {
  showCropper.value = false;
  cleanupCrop();
}

function cleanupCrop() {
  if (cropImageUrl.value) {
    URL.revokeObjectURL(cropImageUrl.value);
  }
  cropImageUrl.value = '';
  cropImage.value = null;
  cropFile.value = null;
  cropZoom.value = 1;
  cropOffset.x = 0;
  cropOffset.y = 0;
}

async function changePassword() {
  clearMessage();
  savingPassword.value = true;
  try {
    await api.changePassword(passwordForm);
    passwordForm.currentPassword = '';
    passwordForm.newPassword = '';
    info.value = t('settings.passwordUpdated');
  } catch (currentError) {
    error.value = currentError.message;
  } finally {
    savingPassword.value = false;
  }
}
</script>

<template>
  <div class="settings-page">
    <div class="settings-container">
      <header class="settings-header">
        <div class="settings-header__left">
          <h1>{{ t('settings.title') }}</h1>
          <span class="settings-kicker">{{ t('settings.profileKicker') }}</span>
        </div>
        <div class="settings-header__right">
          <LanguageSwitch />
          <div class="avatar-block">
            <button type="button" class="avatar-trigger" @click="openAvatarPicker" :title="t('settings.changeAvatarTitle')">
              <UiAvatar
                :src="session?.avatarUrl"
                :alt="t('settings.avatarAlt')"
                :fallback="session?.displayName || session?.username || 'U'"
                size="md"
              />
              <span class="avatar-overlay">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><title>{{ t('settings.changeAvatar') }}</title><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
              </span>
            </button>
            <input
              ref="avatarInputEl"
              type="file"
              class="avatar-input"
              accept="image/*"
              @change="onAvatarFileSelected"
            />
            <div class="avatar-actions">
              <span class="avatar-hint">{{ uploadingAvatar ? t('common.processing') : t('settings.changeAvatarHint') }}</span>
              <button
                v-if="session?.avatarUrl"
                type="button"
                class="avatar-remove"
                :disabled="uploadingAvatar"
                @click="removeAvatar"
              >
                {{ t('settings.removeAvatar') }}
              </button>
            </div>
          </div>
        </div>
      </header>

      <Transition name="banner">
        <div v-if="info" class="info-banner" role="status">{{ info }}</div>
      </Transition>
      <Transition name="banner">
        <div v-if="error" class="error-banner" role="alert">{{ error }}</div>
      </Transition>

      <div class="settings-grid">
        <section class="settings-section">
          <h2>{{ t('settings.profileSection') }}</h2>
          <label class="field-compact">
            <span>{{ t('auth.displayName') }}</span>
            <input
              v-model.trim="profileForm.displayName"
              :placeholder="t('settings.displayNameHint')"
              autocomplete="nickname"
            />
          </label>
          <label class="field-compact">
            <span>{{ t('profile.bio') }}</span>
            <textarea
              v-model="profileForm.bio"
              class="ui-input profile-bio-input"
              rows="4"
              aria-describedby="profile-bio-help profile-bio-count"
              :aria-invalid="profileBioLength > BIO_MAX_LENGTH"
            />
          </label>
          <small id="profile-bio-count">{{ profileBioLength }} / {{ BIO_MAX_LENGTH }}</small>
          <p id="profile-bio-help" class="profile-bio-help">{{ t('profile.visibility') }}</p>
          <label class="field-compact">
            <span>{{ t('settings.customBackground') }}</span>
            <input
              v-model.trim="profileForm.customBackground"
              :placeholder="t('settings.customBackgroundHint')"
            />
          </label>
          <button type="button" class="save-btn" :disabled="savingProfile" @click="saveProfile">
            {{ savingProfile ? t('settings.savingProfile') : t('settings.saveProfile') }}
          </button>
        </section>

        <section class="settings-section">
          <h2>{{ t('settings.securitySection') }}</h2>
          <label class="field-compact">
            <span>{{ t('settings.currentPassword') }}</span>
            <input
              v-model="passwordForm.currentPassword"
              type="password"
              autocomplete="current-password"
            />
          </label>
          <label class="field-compact">
            <span>{{ t('settings.newPassword') }}</span>
            <input
              v-model="passwordForm.newPassword"
              type="password"
              autocomplete="new-password"
            />
          </label>
          <button type="button" class="save-btn" :disabled="savingPassword" @click="changePassword">
            {{ savingPassword ? t('settings.updatingPassword') : t('settings.updatePassword') }}
          </button>
        </section>
        <VisualEffectsSettings class="settings-section" />
        <TelegramNotificationSettings class="settings-section" />
      </div>

      <nav class="settings-nav">
        <button type="button" class="nav-link" @click="router.push('/')">
          <svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          {{ t('settings.backToChat') }}
        </button>
        <button
          v-if="showAdminEntry"
          type="button"
          class="nav-link"
          @click="router.push('/admin')"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" />
            <rect x="14" y="14" width="7" height="7" rx="1" />
          </svg>
          {{ t('settings.adminConsole') }}
        </button>
      </nav>
    </div>

    <Transition name="modal">
      <div v-if="showCropper" class="crop-modal" @click.self="cancelCrop">
        <div class="crop-panel">
          <h3>{{ t('settings.cropAvatar') }}</h3>
          <div class="crop-stage">
            <canvas
              ref="cropperCanvas"
              :width="CANVAS_SIZE"
              :height="CANVAS_SIZE"
              class="crop-canvas"
              @pointerdown="onCropPointerDown"
              @pointermove="onCropPointerMove"
              @pointerup="onCropPointerUp"
              @pointerleave="onCropPointerUp"
            />
          </div>
          <div class="crop-controls">
            <span>{{ t('settings.zoom') }}</span>
            <input
              v-model.number="cropZoom"
              type="range"
              min="0.5"
              max="5"
              step="0.05"
              class="crop-zoom"
            />
          </div>
          <p class="crop-hint">{{ t('settings.cropHint') }}</p>
          <div class="crop-actions">
            <button type="button" class="crop-cancel" @click="cancelCrop">{{ t('common.cancel') }}</button>
            <button type="button" class="crop-confirm" @click="confirmCrop">{{ t('settings.confirmCrop') }}</button>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.settings-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px;
  background: var(--site-background, linear-gradient(135deg, #f5f7fa 0%, #e8ecf1 100%));
}

.settings-container {
  width: min(900px, 100%);
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 28px;
  border-radius: 24px;
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.82), rgba(247, 250, 253, 0.68)),
    rgba(255, 255, 255, 0.4);
  border: 1px solid rgba(255, 255, 255, 0.7);
  box-shadow:
    0 24px 60px rgba(var(--site-brand-rgb, 91, 141, 191), 0.1),
    inset 0 1px 0 rgba(255, 255, 255, 0.8);
  backdrop-filter: blur(24px) saturate(180%);
  -webkit-backdrop-filter: blur(24px) saturate(180%);
  opacity: 0;
  animation: containerRise 0.5s cubic-bezier(0.22, 1, 0.36, 1) 0.1s forwards;
}

.settings-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.settings-header__left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.settings-header__left h1 {
  margin: 0;
  font-size: 22px;
  font-weight: 700;
  color: var(--auth-ink, #2c4a6e);
  letter-spacing: -0.02em;
}

.settings-kicker {
  padding: 4px 12px;
  border-radius: 999px;
  background: rgba(var(--site-brand-rgb, 91, 141, 191), 0.08);
  border: 1px solid rgba(var(--site-brand-rgb, 91, 141, 191), 0.12);
  color: var(--site-brand, #5b8dbf);
  font-size: 11px;
  font-weight: 600;
}

.avatar-block {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-direction: row;
}

.avatar-trigger {
  position: relative;
  border: none;
  background: none;
  cursor: pointer;
  padding: 0;
  border-radius: 16px;
  overflow: hidden;
  transition: transform 0.2s ease;
}

.avatar-trigger:hover {
  transform: scale(1.05);
}

.avatar-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(26, 35, 50, 0.45);
  color: #fff;
  opacity: 0;
  transition: opacity 0.2s ease;
  border-radius: 16px;
}

.settings-header__right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.avatar-trigger:hover .avatar-overlay {
  opacity: 1;
}

.avatar-input {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.avatar-hint {
  font-size: 11px;
  color: var(--auth-muted, #6b8aab);
  white-space: nowrap;
}

.avatar-actions {
  display: flex;
  align-items: flex-start;
  flex-direction: column;
  gap: 2px;
}

.avatar-remove {
  border: 0;
  padding: 0;
  background: transparent;
  color: #b34a57;
  font-size: 11px;
  cursor: pointer;
}

.avatar-remove:disabled {
  cursor: default;
  opacity: 0.5;
}

.info-banner,
.error-banner {
  padding: 10px 16px;
  border-radius: 12px;
  font-size: 13px;
}

.info-banner {
  background: rgba(var(--site-brand-rgb, 91, 141, 191), 0.08);
  border: 1px solid rgba(var(--site-brand-rgb, 91, 141, 191), 0.15);
  color: var(--site-brand, #5b8dbf);
}

.error-banner {
  background: rgba(217, 83, 79, 0.08);
  border: 1px solid rgba(217, 83, 79, 0.15);
  color: #d9534f;
}

.banner-enter-active,
.banner-leave-active {
  transition: opacity 200ms ease, transform 200ms ease;
}

.banner-enter-from,
.banner-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

.settings-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

.settings-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 20px;
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.5);
  border: 1px solid rgba(255, 255, 255, 0.5);
  box-shadow:
    0 4px 16px rgba(var(--site-brand-rgb, 91, 141, 191), 0.04),
    inset 0 1px 0 rgba(255, 255, 255, 0.6);
  opacity: 0;
  animation: sectionRise 0.4s cubic-bezier(0.22, 1, 0.36, 1) forwards;
}

.settings-section:nth-child(1) {
  animation-delay: 0.2s;
}

.settings-section:nth-child(2) {
  animation-delay: 0.3s;
}

.settings-section h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
  color: var(--auth-ink, #2c4a6e);
  padding-bottom: 10px;
  border-bottom: 1px solid rgba(var(--site-brand-rgb, 91, 141, 191), 0.08);
}

.field-compact {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.field-compact span {
  font-size: 11px;
  font-weight: 600;
  color: var(--auth-muted, #6b8aab);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.field-compact input {
  width: 100%;
  padding: 10px 14px;
  border-radius: 12px;
  border: 1px solid rgba(0, 0, 0, 0.08);
  background: rgba(255, 255, 255, 0.6);
  color: var(--auth-ink, #2c4a6e);
  font-size: 14px;
  outline: none;
  transition: border-color 0.2s ease, box-shadow 0.2s ease, background 0.2s ease;
  box-sizing: border-box;
}

.field-compact input:focus {
  border-color: rgba(var(--site-brand-rgb, 91, 141, 191), 0.35);
  box-shadow: 0 0 0 3px rgba(var(--site-brand-rgb, 91, 141, 191), 0.08);
  background: rgba(255, 255, 255, 0.9);
}

.field-compact input::placeholder {
  color: rgba(107, 138, 171, 0.5);
  font-size: 13px;
}

.save-btn {
  margin-top: 6px;
  padding: 10px 20px;
  border: none;
  border-radius: 12px;
  background: var(--site-button-background, linear-gradient(135deg, rgba(91, 141, 191, 0.85), rgba(69, 121, 186, 0.8)));
  color: var(--site-on-action, #fff);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
  box-shadow: 0 2px 8px rgba(var(--site-brand-rgb, 91, 141, 191), 0.2);
}

.save-btn:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(var(--site-brand-rgb, 91, 141, 191), 0.3);
}

.save-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.settings-nav {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  opacity: 0;
  animation: sectionRise 0.4s cubic-bezier(0.22, 1, 0.36, 1) 0.4s forwards;
}

.nav-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border-radius: 999px;
  border: 1px solid rgba(var(--site-brand-rgb, 91, 141, 191), 0.1);
  background: rgba(255, 255, 255, 0.4);
  color: var(--auth-muted, #6b8aab);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.nav-link:hover {
  background: rgba(255, 255, 255, 0.7);
  border-color: rgba(var(--site-brand-rgb, 91, 141, 191), 0.2);
  color: var(--auth-ink, #2c4a6e);
  transform: translateY(-1px);
}

.nav-link svg {
  width: 13px;
  height: 13px;
}

.crop-modal {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(26, 35, 50, 0.5);
  backdrop-filter: blur(8px);
  z-index: 100;
  padding: 24px;
}

.crop-panel {
  width: min(480px, 100%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 20px;
  padding: 36px;
  border-radius: 28px;
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.88), rgba(247, 250, 253, 0.72)),
    rgba(255, 255, 255, 0.5);
  border: 1px solid rgba(255, 255, 255, 0.7);
  box-shadow:
    0 30px 80px rgba(26, 35, 50, 0.2),
    inset 0 1px 0 rgba(255, 255, 255, 0.8);
  backdrop-filter: blur(24px) saturate(180%);
}

.crop-panel h3 {
  margin: 0;
  font-size: 20px;
  font-weight: 700;
  color: var(--auth-ink, #2c4a6e);
}

.crop-stage {
  width: 280px;
  height: 280px;
  border-radius: 16px;
  overflow: hidden;
  box-shadow:
    0 8px 32px rgba(var(--site-brand-rgb, 91, 141, 191), 0.15),
    inset 0 0 0 2px rgba(255, 255, 255, 0.3);
}

.crop-canvas {
  display: block;
  cursor: grab;
  touch-action: none;
}

.crop-canvas:active {
  cursor: grabbing;
}

.crop-controls {
  display: flex;
  align-items: center;
  gap: 16px;
  width: 100%;
  padding: 0 8px;
}

.crop-controls span {
  font-size: 15px;
  font-weight: 600;
  color: var(--auth-muted, #6b8aab);
  flex-shrink: 0;
}

.crop-zoom {
  flex: 1;
  height: 6px;
  appearance: none;
  border-radius: 3px;
  background: rgba(var(--site-brand-rgb, 91, 141, 191), 0.15);
  outline: none;
}

.crop-zoom::-webkit-slider-thumb {
  appearance: none;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--site-button-background, linear-gradient(135deg, #5b8dbf, #4579ba));
  box-shadow: 0 2px 6px rgba(var(--site-brand-rgb, 91, 141, 191), 0.3);
  cursor: pointer;
  transition: transform 0.15s ease;
}

.crop-zoom::-webkit-slider-thumb:hover {
  transform: scale(1.15);
}

.crop-hint {
  margin: 0;
  font-size: 13px;
  color: var(--auth-muted, #6b8aab);
  text-align: center;
}

.crop-actions {
  display: flex;
  gap: 12px;
  width: 100%;
}

.crop-cancel {
  flex: 1;
  padding: 14px;
  border: 1px solid rgba(var(--site-brand-rgb, 91, 141, 191), 0.15);
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.5);
  color: var(--auth-muted, #6b8aab);
  font-size: 16px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.crop-cancel:hover {
  background: rgba(255, 255, 255, 0.8);
  color: var(--auth-ink, #2c4a6e);
}

.crop-confirm {
  flex: 1;
  padding: 14px;
  border: none;
  border-radius: 14px;
  background: var(--site-button-background, linear-gradient(135deg, rgba(91, 141, 191, 0.85), rgba(69, 121, 186, 0.8)));
  color: var(--site-on-action, #fff);
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(var(--site-brand-rgb, 91, 141, 191), 0.2);
  transition: all 0.2s ease;
}

.crop-confirm:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(var(--site-brand-rgb, 91, 141, 191), 0.3);
}

.modal-enter-active {
  transition: opacity 250ms ease;
}

.modal-enter-active .crop-panel {
  transition: transform 300ms cubic-bezier(0.22, 1, 0.36, 1), opacity 250ms ease;
}

.modal-leave-active {
  transition: opacity 200ms ease;
}

.modal-leave-active .crop-panel {
  transition: transform 200ms ease, opacity 200ms ease;
}

.modal-enter-from {
  opacity: 0;
}

.modal-enter-from .crop-panel {
  transform: scale(0.92) translateY(12px);
  opacity: 0;
}

.modal-leave-to {
  opacity: 0;
}

.modal-leave-to .crop-panel {
  transform: scale(0.96);
  opacity: 0;
}

@keyframes containerRise {
  from {
    opacity: 0;
    transform: translateY(16px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

@keyframes sectionRise {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (max-width: 640px) {
  .settings-page {
    padding: 16px;
  }

  .settings-container {
    padding: 24px;
    gap: 20px;
  }

  .settings-grid {
    grid-template-columns: 1fr;
    gap: 16px;
  }

  .settings-header {
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
  }

  .settings-header__right {
    width: 100%;
    justify-content: space-between;
  }

  .avatar-compact {
    width: 100%;
  }
}

@media (prefers-reduced-motion: reduce) {
  .settings-container,
  .settings-section,
  .settings-nav {
    animation: none;
    opacity: 1;
    transform: none;
  }
}
</style>
