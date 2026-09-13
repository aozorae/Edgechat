<script setup lang="ts">
import { Menu, Search, UsersRound } from "@lucide/vue";
import { onBeforeUnmount, onMounted } from "vue";
import type { UserSummary } from "../../../shared/user-profile.ts";
import UiAvatar from "../components/ui/Avatar.vue";
import UiButton from "../components/ui/Button.vue";
import { useContacts } from "../composables/useContacts.ts";
import { t } from "../i18n.js";

const emit = defineEmits<{
	openNavigation: [];
	openProfile: [user: UserSummary];
}>();
const { query, loading, error, filteredUsers, load, dispose } = useContacts();

onMounted(() => void load());
onBeforeUnmount(dispose);
</script>

<template>
  <main class="contacts-page">
    <header class="contacts-page__header">
      <div class="contacts-page__title-row">
        <button type="button" class="contacts-page__menu" :aria-label="t('nav.openNavigation')" @click="emit('openNavigation')">
          <Menu :size="22" aria-hidden="true" />
        </button>
        <h1>{{ t('contacts.title') }}</h1>
      </div>
      <label class="contacts-page__search">
        <Search :size="18" aria-hidden="true" />
        <span class="sr-only">{{ t('contacts.search') }}</span>
        <input v-model="query" type="search" :placeholder="t('contacts.search')" autocomplete="off" />
      </label>
    </header>

    <section class="contacts-page__body" :aria-busy="loading">
      <div v-if="loading" class="contacts-page__state" role="status">
        <span class="contacts-page__spinner" aria-hidden="true"></span>
        <span>{{ t('contacts.loading') }}</span>
      </div>
      <div v-else-if="error" class="contacts-page__state" role="alert">
        <UsersRound :size="30" aria-hidden="true" />
        <p>{{ t('contacts.loadFailed') }}</p>
        <UiButton variant="secondary" @click="load(true)">{{ t('common.retry') }}</UiButton>
      </div>
      <div v-else-if="!filteredUsers.length" class="contacts-page__state" role="status">
        <UsersRound :size="30" aria-hidden="true" />
        <p>{{ query.trim() ? t('contacts.noResults') : t('contacts.empty') }}</p>
      </div>
      <ul v-else class="contacts-page__list" :aria-label="t('contacts.list')">
        <li v-for="user in filteredUsers" :key="user.id">
          <button
            type="button"
            class="contacts-page__row"
            :aria-label="t('profile.view', { name: user.displayName || user.username })"
            @click="emit('openProfile', user)"
          >
            <UiAvatar :src="user.avatarUrl" :fallback="user.displayName || user.username" size="md" />
            <span>{{ user.displayName || user.username }}</span>
          </button>
        </li>
      </ul>
    </section>
  </main>
</template>

<style scoped>
.contacts-page {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
  background: var(--chat-paper);
  color: var(--chat-ink);
}

.contacts-page__header {
  display: grid;
  gap: 20px;
  padding: 28px clamp(20px, 5vw, 64px) 24px;
  border-bottom: 1px solid var(--chat-line);
  background: var(--chat-paper);
}

.contacts-page__title-row { display: flex; align-items: center; gap: 8px; }
.contacts-page__title-row h1 { margin: 0; font-size: 24px; font-weight: 650; letter-spacing: 0; }

.contacts-page__menu {
  display: none;
  width: 44px;
  height: 44px;
  flex: 0 0 44px;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--chat-muted);
}

.contacts-page__search {
  display: flex;
  align-items: center;
  width: min(100%, 620px);
  height: 44px;
  gap: 10px;
  padding: 0 14px;
  border: 1px solid var(--chat-line);
  border-radius: 22px;
  background: var(--chat-hover);
  color: var(--chat-muted);
}

.contacts-page__search:focus-within { border-color: var(--chat-accent); box-shadow: 0 0 0 2px rgba(0, 128, 105, 0.14); }
.contacts-page__search input { width: 100%; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--chat-ink); font: inherit; letter-spacing: 0; }

.contacts-page__body {
  width: min(100%, 760px);
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  padding: 8px clamp(12px, 5vw, 64px) calc(24px + env(safe-area-inset-bottom));
}

.contacts-page__list { margin: 0; padding: 0; list-style: none; }
.contacts-page__list li + li { border-top: 1px solid var(--chat-hover); }

.contacts-page__row {
  display: flex;
  width: 100%;
  min-height: 80px;
  align-items: center;
  gap: 14px;
  padding: 10px 8px;
  border: 0;
  border-radius: 12px;
  background: transparent;
  color: var(--chat-ink);
  cursor: pointer;
  text-align: left;
  touch-action: manipulation;
}

.contacts-page__row:hover { background: var(--chat-hover); }
.contacts-page__row:active { background: var(--chat-selected); }
.contacts-page__row:focus-visible, .contacts-page__menu:focus-visible { outline: 2px solid var(--chat-accent); outline-offset: 2px; }
.contacts-page__row > span { min-width: 0; overflow: hidden; font-size: 15px; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
.contacts-page__row .ui-avatar { width: 42px; height: 42px; border-radius: 50%; box-shadow: none; }

.contacts-page__state {
  display: grid;
  min-height: 240px;
  place-items: center;
  align-content: center;
  gap: 12px;
  padding: 24px;
  color: var(--chat-muted);
  text-align: center;
}

.contacts-page__state p { margin: 0; }
.contacts-page__spinner { width: 26px; height: 26px; border: 2px solid var(--chat-line); border-top-color: var(--chat-accent); border-radius: 50%; animation: contacts-spin 700ms linear infinite; }
@keyframes contacts-spin { to { transform: rotate(360deg); } }

@media (max-width: 960px) {
  .contacts-page__header {
    gap: 10px;
    padding: max(8px, env(safe-area-inset-top)) max(12px, env(safe-area-inset-right)) 12px max(12px, env(safe-area-inset-left));
  }
  .contacts-page__menu { display: grid; }
  .contacts-page__title-row h1 { font-size: 21px; }
  .contacts-page__search { width: 100%; }
  .contacts-page__body { width: 100%; padding-right: max(8px, env(safe-area-inset-right)); padding-left: max(8px, env(safe-area-inset-left)); scrollbar-gutter: auto; }
}

@media (prefers-reduced-motion: reduce) {
  .contacts-page__spinner { animation: none; }
}
</style>
