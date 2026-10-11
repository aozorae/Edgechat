<script setup>
import { ChevronDown, CircleUserRound, Home, Menu, Search, Settings, X } from '@lucide/vue';
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { adminNavigation } from '../../admin/navigation.js';
import { useI18n } from '../../i18n.js';
import store from '../../store.js';
import { canVisit, can, firstAdminPage } from '../../authorization.ts';

const route = useRoute();
const router = useRouter();
const { locale, t } = useI18n();
const query = ref('');
const mobileOpen = ref(false);
const mobileToggle = ref(null);
// 页面导航与菜单展开分开操作；进入栏目也保持收起，避免挤占其它导航入口。
const openGroups = ref(new Set());

const localizedNavigation = computed(() =>
  adminNavigation.filter((item) => canVisit(item.id)).map((item) => ({
    ...item,
    label: t(item.labelKey),
    description: t(item.descriptionKey),
    children: item.children?.filter((child) => !child.permission || can(child.permission)).map((child) => ({ ...child, label: t(child.labelKey) }))
  }))
);

const filteredNavigation = computed(() => {
  const keyword = query.value.trim().toLocaleLowerCase(locale.value);
  if (!keyword) {
    return localizedNavigation.value;
  }

  return localizedNavigation.value
    .map((item) => {
      const parentMatches = `${item.label} ${item.description}`.toLocaleLowerCase(locale.value).includes(keyword);
      if (!item.children) {
        return parentMatches ? item : null;
      }

      const children = parentMatches
        ? item.children
        : item.children.filter((child) => child.label.toLocaleLowerCase(locale.value).includes(keyword));
      return children.length ? { ...item, children } : null;
    })
    .filter(Boolean);
});

const adminName = computed(() => store.session?.displayName || store.session?.username || t('admin.sidebar.administrator'));

function isPrimaryActive(item) {
  return route.path === item.to || route.path.startsWith(`${item.to}/`);
}

function isChildActive(item, child) {
  return route.path === item.to && route.hash === child.hash;
}

function isGroupOpen(item) {
  return Boolean(query.value.trim()) || openGroups.value.has(item.id);
}

function toggleGroup(groupId) {
  const next = new Set(openGroups.value);
  if (next.has(groupId)) {
    next.delete(groupId);
  } else {
    next.add(groupId);
  }
  openGroups.value = next;
}

function closeMobileNavigation() {
  if (!mobileOpen.value) return;
  mobileOpen.value = false;
  // 收起后原导航项会隐藏，把焦点交还始终可见的开关，避免键盘位置丢失。
  mobileToggle.value?.focus();
}

function navigate(location) {
  closeMobileNavigation();
  void router.push(location);
}

</script>

<template>
  <aside class="admin-sidebar" :class="{ 'admin-sidebar--open': mobileOpen }" @keydown.esc="closeMobileNavigation">
    <div class="admin-sidebar__brand-row">
      <button type="button" class="admin-brand" :aria-label="t('admin.sidebar.openDashboard')" @click="navigate(firstAdminPage())">
        {{ t('admin.sidebar.brand') }}
      </button>
      <button
        type="button"
        ref="mobileToggle"
        class="admin-mobile-toggle"
        :aria-expanded="mobileOpen"
        aria-controls="admin-sidebar-body"
        :aria-label="mobileOpen ? t('admin.sidebar.collapseNavigation') : t('admin.sidebar.expandNavigation')"
        @click="mobileOpen = !mobileOpen"
      >
        <X v-if="mobileOpen" :size="20" aria-hidden="true" />
        <Menu v-else :size="20" aria-hidden="true" />
      </button>
    </div>

    <div id="admin-sidebar-body" class="admin-sidebar__body">
      <label class="admin-nav-search">
        <Search :size="18" aria-hidden="true" />
        <span class="sr-only">{{ t('admin.sidebar.searchNavigation') }}</span>
        <input v-model="query" type="search" :placeholder="t('admin.sidebar.search')" />
      </label>

      <nav class="admin-nav" :aria-label="t('admin.sidebar.navigation')">
        <template v-for="item in filteredNavigation" :key="item.id">
          <button
            v-if="!item.children"
            type="button"
            class="admin-nav-item"
            :class="{ 'admin-nav-item--active': isPrimaryActive(item), 'admin-nav-item--separated': item.separated }"
            :aria-current="isPrimaryActive(item) ? 'page' : undefined"
            @click="navigate(item.to)"
          >
            <component :is="item.icon" :size="19" aria-hidden="true" />
            <span>{{ item.label }}</span>
          </button>

          <section v-else class="admin-nav-group" :aria-label="item.label">
            <div class="admin-nav-group__header">
              <button
                type="button"
                class="admin-nav-item admin-nav-item--group"
                :class="{ 'admin-nav-item--active': isPrimaryActive(item) }"
                :aria-current="isPrimaryActive(item) ? 'page' : undefined"
                @click="navigate(item.to)"
              >
                <component :is="item.icon" :size="19" aria-hidden="true" />
                <span>{{ item.label }}</span>
              </button>
              <button
                type="button"
                class="admin-nav-group__toggle"
                :aria-expanded="isGroupOpen(item)"
                :aria-controls="`admin-nav-children-${item.id}`"
                :aria-label="t(isGroupOpen(item) ? 'admin.sidebar.collapseGroup' : 'admin.sidebar.expandGroup', { name: item.label })"
                @click="toggleGroup(item.id)"
              >
                <ChevronDown
                  :size="16"
                  aria-hidden="true"
                  :class="{ 'admin-nav-group__chevron--open': isGroupOpen(item) }"
                />
              </button>
            </div>

            <div v-show="isGroupOpen(item)" :id="`admin-nav-children-${item.id}`" class="admin-nav-group__items">
              <button
                v-for="child in item.children"
                :key="child.id"
                type="button"
                class="admin-nav-subitem"
                :class="{ 'admin-nav-subitem--active': isChildActive(item, child) }"
                :aria-current="isChildActive(item, child) ? 'location' : undefined"
                @click="navigate({ path: item.to, hash: child.hash })"
              >
                {{ child.label }}
              </button>
            </div>
          </section>
        </template>

        <p v-if="!filteredNavigation.length" class="admin-nav-empty">{{ t('admin.sidebar.noResults') }}</p>
      </nav>

      <div class="admin-sidebar__footer">
        <div class="admin-identity">
          <CircleUserRound :size="20" aria-hidden="true" />
          <div>
            <strong>{{ adminName }}</strong>
            <span>{{ t(store.session?.isSuperAdmin ? 'admin.sidebar.superAdmin' : 'rbac.subAdmin') }}</span>
          </div>
        </div>
        <div class="admin-sidebar__shortcuts">
          <button type="button" :title="t('nav.backToChat')" :aria-label="t('nav.backToChat')" @click="navigate('/')">
            <Home :size="19" aria-hidden="true" />
          </button>
          <button type="button" :title="t('nav.personalSettings')" :aria-label="t('nav.personalSettings')" @click="navigate('/settings')">
            <Settings :size="19" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  </aside>
</template>

<style scoped src="../../styles/admin/sidebar.css"></style>
