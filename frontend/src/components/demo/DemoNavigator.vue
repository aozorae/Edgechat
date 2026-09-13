<script setup>
import { RotateCcw } from '@lucide/vue';
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { resetRuntime } from '../../runtime.js';
import { t } from '../../i18n.js';

const route = useRoute();
const router = useRouter();

const pages = [
  { labelKey: 'demo.chat', value: '/' },
  { labelKey: 'demo.contacts', value: '/contacts' },
  { labelKey: 'demo.settings', value: '/settings' },
  { labelKey: 'demo.dashboard', value: '/admin/dashboard' },
  { labelKey: 'demo.users', value: '/admin/users' },
  { labelKey: 'demo.invites', value: '/admin/invites' },
  { labelKey: 'demo.telegram', value: '/admin/telegram' },
  { labelKey: 'demo.site', value: '/admin/site' },
  { labelKey: 'admin.nav.maintenance', value: '/admin/maintenance' },
  { labelKey: 'demo.login', value: '/login' },
  { labelKey: 'demo.register', value: '/register/demo-invite' }
];

const currentPage = computed(() => {
  const match = pages.find((page) => page.value === route.path);
  return match?.value || '/';
});

function navigate(event) {
  void router.push(event.target.value);
}

function resetDemo() {
  resetRuntime();
  localStorage.removeItem('customBackground');
  window.location.assign('/');
}
</script>

<template>
  <aside
    class="demo-navigator"
    :class="{
      'demo-navigator--admin': route.path.startsWith('/admin'),
      'demo-navigator--contacts': route.path === '/contacts'
    }"
    :aria-label="t('demo.navigation')"
  >
    <span class="demo-navigator__badge">{{ t('demo.local') }}</span>
    <select :value="currentPage" :aria-label="t('demo.selectPage')" @change="navigate">
      <option v-for="page in pages" :key="page.value" :value="page.value">
        {{ t(page.labelKey) }}
      </option>
    </select>
    <button type="button" :title="t('demo.reset')" :aria-label="t('demo.reset')" @click="resetDemo">
      <RotateCcw :size="16" aria-hidden="true" />
    </button>
  </aside>
</template>

<style scoped>
.demo-navigator {
  position: fixed;
  top: 68px;
  right: 12px;
  z-index: 10000;
  display: flex;
  align-items: center;
  gap: 7px;
  min-height: 38px;
  padding: 5px 6px 5px 10px;
  border: 1px solid rgba(255, 255, 255, 0.78);
  border-radius: 8px;
  background: rgba(248, 251, 254, 0.88);
  box-shadow: 0 8px 24px rgba(35, 54, 76, 0.16);
  backdrop-filter: blur(18px) saturate(150%);
  color: #23405f;
}

.demo-navigator__badge {
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
}

.demo-navigator select {
  width: 138px;
  height: 28px;
  border: 1px solid rgba(70, 105, 139, 0.22);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.82);
  color: #203b57;
  font: inherit;
  font-size: 12px;
  padding: 0 24px 0 8px;
}

.demo-navigator button {
  display: grid;
  width: 28px;
  height: 28px;
  place-items: center;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: #426584;
  cursor: pointer;
}

.demo-navigator button:hover,
.demo-navigator button:focus-visible {
  background: rgba(80, 126, 167, 0.12);
  outline: none;
}

@media (max-width: 640px) {
  .demo-navigator {
    top: 68px;
    right: 8px;
  }

  .demo-navigator__badge {
    display: none;
  }

  .demo-navigator select {
    width: 124px;
  }

  .demo-navigator--admin,
  .demo-navigator--contacts {
    top: auto;
    bottom: 8px;
  }
}
</style>

<style>
@media (max-width: 640px) {
  /* 聊天页出现置顶条时把演示导航移到输入区上方，避免遮挡真实功能文案。 */
  body:has(.pinned-message-bar) .demo-navigator:not(.demo-navigator--admin) {
    top: auto;
    bottom: calc(116px + env(safe-area-inset-bottom));
  }

	/* 窄屏演示导航悬浮在输入区上方，因此给消息流留出同等空间，保证最新回复不会被遮住。 */
		body:has(.pinned-message-bar) .chat-messages {
			padding-bottom: calc(72px + env(safe-area-inset-bottom));
		}

  body:has(.contacts-page) .contacts-page__body {
    padding-bottom: calc(64px + env(safe-area-inset-bottom));
  }

  /* 成员管理使用整屏覆盖层，演示导航不能浮在其上方抢占触控区域。 */
  body:has(.room-management-layer) .demo-navigator,
  body:has(.composer-rich-editor) .demo-navigator,
  body:has(.composer-reply) .demo-navigator {
    display: none;
  }
}
</style>
