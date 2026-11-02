<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import store from '../store.js';
import { useCursor } from '../composables/useCursor.js';
import { useI18n } from '../i18n.js';
import LanguageSwitch from '../components/ui/LanguageSwitch.vue';
import { getStoredNativeServerOrigin, isCapacitorAndroid } from '../capacitor-platform.ts';
import { readLoginSubmission } from '../login-submission.ts';
import { loadAuthFonts } from '../auth-fonts.js';

onMounted(loadAuthFonts);

const route = useRoute();
const router = useRouter();
const { t } = useI18n();
const loading = ref(false);
const error = ref('');
const form = reactive({
  serverOrigin: getStoredNativeServerOrigin(),
  username: '',
  password: ''
});
const registered = computed(() => route.query.registered === '1');

const usernameInput = ref(null);
const passwordInput = ref(null);
const serverInput = ref(null);
const usernameCursor = ref(null);
const passwordCursor = ref(null);
const serverCursor = ref(null);

useCursor([
  [serverInput, serverCursor],
  [usernameInput, usernameCursor],
  [passwordInput, passwordCursor]
]);

async function submit(event) {
  loading.value = true;
  error.value = '';
  try {
    // Android WebView 的自动填充不一定触发 input 事件，提交时以输入框当前值为准。
    const submitted = new FormData(event.currentTarget);
    const { serverOrigin, credentials } = readLoginSubmission(submitted);
    if (isCapacitorAndroid) {
      await store.configureNativeServer(serverOrigin);
    }
    await store.login(credentials);
    router.push('/');
  } catch (currentError) {
    error.value = currentError.message === 'native_server_https_required'
      ? t('auth.serverHttpsRequired')
      : currentError.message === 'native_server_unavailable'
        ? t('auth.serverUnavailable')
        : currentError.message;
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="login-page">
    <LanguageSwitch class="login-language-switch" />
    <div class="login-container">
      <div class="title-group">
        <h1 class="welcome-text">{{ t('auth.welcomeBack') }}</h1>
        <h2 class="brand-name">{{ store.site.siteName }}</h2>
      </div>

      <p v-if="registered" class="success-hint">{{ t('auth.registerSuccess') }}</p>

      <form class="login-form" @submit.prevent="submit">
        <div v-if="isCapacitorAndroid" class="input-wrapper">
          <span ref="serverCursor" class="custom-cursor"></span>
          <input
            ref="serverInput"
            v-model.trim="form.serverOrigin"
            class="login-input"
            :placeholder="t('auth.serverOrigin')"
            autocomplete="url"
            inputmode="url"
            name="serverOrigin"
            required
            type="url"
          />
        </div>
        <div class="input-wrapper">
          <span ref="usernameCursor" class="custom-cursor"></span>
          <input
            ref="usernameInput"
            v-model.trim="form.username"
            class="login-input"
            :placeholder="t('auth.account')"
            autocomplete="username"
            name="username"
            required
            type="text"
          />
        </div>
        <div class="input-wrapper">
          <span ref="passwordCursor" class="custom-cursor"></span>
          <input
            ref="passwordInput"
            v-model="form.password"
            class="login-input"
            :placeholder="t('auth.password')"
            autocomplete="current-password"
            name="password"
            required
            type="password"
          />
        </div>

        <button class="login-btn" :disabled="loading" type="submit">
          {{ loading ? t('auth.signingIn') : t('auth.signIn') }}
        </button>

        <p v-if="error" class="error-text">{{ error }}</p>
      </form>
    </div>
  </div>
</template>

<style scoped>
.login-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background-color: var(--auth-canvas, #f5f5f5);
  position: relative;
  overflow: hidden;
}

.login-page::before {
  content: '';
  position: fixed;
  inset: 0;
  z-index: 0;
  background: var(--auth-tide, linear-gradient(to bottom, transparent 0%, #e1ecf5 25%, #e6eff6 100%));
  transform: translateY(100%);
  animation: tideRise 1.2s cubic-bezier(0.16, 1, 0.3, 1) forwards;
  pointer-events: none;
}

@keyframes tideRise {
  to { transform: translateY(0); }
}

.login-container {
  width: 100%;
  max-width: 420px;
  display: flex;
  flex-direction: column;
  align-items: center;
  position: relative;
  z-index: 1;
}

.title-group {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.welcome-text {
  font-family: 'Dancing Script', cursive;
  font-size: 56px;
  font-weight: 700;
  color: var(--auth-ink, #2c4a6e);
  margin: 0 0 10px;
  letter-spacing: 1px;
  opacity: 0;
  animation: fadeUp 0.7s ease-out 0.8s forwards;
}

.brand-name {
  font-family: 'Great Vibes', cursive;
  font-size: 52px;
  font-weight: 400;
  color: var(--auth-brand, #5b8dbf);
  margin: -8px 0 48px;
  letter-spacing: 2px;
  opacity: 0;
  animation: fadeUp 0.7s ease-out 1s forwards;
  text-shadow: 0 2px 8px rgba(91, 141, 191, 0.15);
}

@keyframes fadeUp {
  0% { opacity: 0; transform: translateY(18px); }
  100% { opacity: 1; transform: translateY(0); }
}

.success-hint {
  font-size: 13px;
  color: #4a8d6e;
  margin: 0 0 20px;
  text-align: center;
}

.login-form {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.input-wrapper {
  position: relative;
  width: 100%;
}

.custom-cursor {
  position: absolute;
  width: 3px;
  background-color: var(--auth-ink, #2c4a6e);
  border-radius: 2px;
  opacity: 0;
  pointer-events: none;
  z-index: 2;
}

.custom-cursor.visible {
  animation: blink 1s infinite;
}

@keyframes blink {
  0%, 50% { opacity: 1; }
  51%, 100% { opacity: 0; }
}

.login-input {
  width: 100%;
  height: 56px;
  padding: 0 4px;
  border: none;
  background: transparent;
  font-size: 18px;
  font-weight: 500;
  color: var(--auth-ink, #2c4a6e);
  outline: none;
  caret-color: transparent;
}

.login-input::placeholder {
  color: var(--auth-ink, #2c4a6e);
  text-decoration: underline;
  text-decoration-color: var(--auth-brand, #5b8dbf);
  text-decoration-thickness: 3px;
  text-underline-offset: 8px;
}

.login-btn {
  width: fit-content;
  height: auto;
  border: none;
  border-bottom: 3px solid var(--auth-brand, #5b8dbf);
  background: transparent;
  color: var(--auth-ink, #2c4a6e);
  font-size: 24px;
  font-weight: 700;
  cursor: pointer;
  transition: border-color 0.2s, transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
  margin: 8px auto 0;
  letter-spacing: 2px;
  padding: 0 4px 8px;
}

.login-btn:hover:not(:disabled) {
  border-bottom-color: var(--auth-ink, #2c4a6e);
  transform: scale(1.04);
}

.login-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.error-text {
  font-size: 13px;
  color: #d9534f;
  margin: 0;
  text-align: center;
}

.login-language-switch {
  position: absolute;
  top: max(16px, env(safe-area-inset-top));
  right: max(16px, env(safe-area-inset-right));
  z-index: 2;
  color: var(--auth-ink, #2c4a6e);
}

@media (prefers-reduced-motion: reduce) {
  .login-page::before,
  .welcome-text,
  .brand-name {
    animation: none;
    opacity: 1;
    transform: none;
  }

  .login-btn {
    transition: none;
  }

  .login-btn:hover:not(:disabled) {
    transform: none;
  }

  .custom-cursor.visible {
    animation: none;
    opacity: 1;
  }
}
</style>
