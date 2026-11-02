<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { Save, ShieldCheck } from '@lucide/vue';
import api from '../api.js';
import UiButton from '../components/ui/Button.vue';
import UiSurface from '../components/ui/Surface.vue';
import UiInput from '../components/ui/Input.vue';
import { t } from '../i18n.js';
import { isDemoMode } from '../runtime.js';

const settings = reactive({ enabled: false, siteKey: '', secretConfigured: false });
const loaded = ref(false);
const busy = ref(false);
const error = ref('');
const saved = ref(false);

async function load() {
  busy.value = true;
  error.value = '';
  try {
    Object.assign(settings, await api.adminLoginVerification());
    loaded.value = true;
  } catch { error.value = t('verification.loadFailed'); }
  finally { busy.value = false; }
}

async function save() {
  busy.value = true;
  error.value = '';
  saved.value = false;
  try {
    Object.assign(settings, await api.saveAdminLoginVerification({ enabled: settings.enabled, siteKey: settings.siteKey }));
    saved.value = true;
  } catch (cause) { error.value = cause.message; }
  finally { busy.value = false; }
}
onMounted(load);
</script>

<template>
  <div class="admin-section">
    <UiSurface class="panel verification-panel" :aria-busy="busy">
      <form v-if="loaded" class="verification-form" @submit.prevent="save">
        <div class="verification-heading"><ShieldCheck :size="24" aria-hidden="true" /><h2>Cloudflare Turnstile</h2></div>
        <label class="verification-toggle"><input v-model="settings.enabled" type="checkbox" :disabled="busy" />{{ t('verification.enable') }}</label>
        <label class="verification-field" for="turnstile-site-key">Site Key
          <UiInput id="turnstile-site-key" v-model="settings.siteKey" type="text" autocomplete="off" :disabled="busy" :required="settings.enabled" />
        </label>
        <p class="verification-secret">Secret Key: {{ t(settings.secretConfigured ? 'verification.configured' : 'verification.missing') }}</p>
        <p v-if="isDemoMode" class="muted">{{ t('verification.demo') }}</p>
        <UiButton type="submit" :disabled="busy"><Save :size="16" aria-hidden="true" />{{ t(busy ? 'common.saving' : 'common.save') }}</UiButton>
        <p v-if="saved" role="status">{{ t('verification.saved') }}</p>
      </form>
      <p v-else>{{ t(busy ? 'common.loading' : 'verification.loadFailed') }}</p>
      <UiButton v-if="!loaded && !busy" variant="secondary" @click="load">{{ t('common.retry') }}</UiButton>
      <p v-if="error" role="alert" class="error-text">{{ error }}</p>
    </UiSurface>
  </div>
</template>

<style scoped>
.verification-panel { max-width: 720px; width: 100%; box-sizing: border-box; }
.verification-form { display: grid; gap: 20px; }
.verification-heading { display: flex; align-items: center; gap: 12px; }
.verification-heading svg { flex-shrink: 0; color: var(--admin-green); }
.verification-heading h2 { font-size: 20px; margin: 0; overflow-wrap: anywhere; }
.verification-toggle { display: flex; align-items: center; gap: 10px; min-height: 44px; }
.verification-toggle input { width: 20px; height: 20px; accent-color: var(--admin-green); }
.verification-field { display: grid; gap: 8px; }
.verification-field input { width: 100%; min-height: 44px; box-sizing: border-box; }
.verification-secret { margin: 0; font-size: 14px; color: var(--admin-muted); overflow-wrap: anywhere; }
.verification-form > button { justify-self: start; }
</style>
