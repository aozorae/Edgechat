<script setup>
import { Gauge, Settings } from '@lucide/vue';
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { adminRouteIcons } from '../../admin/navigation.js';
import { t } from '../../i18n.js';
import LanguageSwitch from '../ui/LanguageSwitch.vue';
import { canVisit } from '../../authorization.ts';

const route = useRoute();
const router = useRouter();

const currentIcon = computed(() => adminRouteIcons[route.meta.adminIcon] || Gauge);
const currentTitle = computed(() => t(route.meta.adminTitleKey || 'admin.topbar.defaultTitle'));
</script>

<template>
  <header class="admin-topbar">
    <div class="admin-topbar__title">
      <component :is="currentIcon" :size="23" aria-hidden="true" />
      <h1>{{ currentTitle }}</h1>
    </div>
    <div class="admin-topbar__actions">
      <LanguageSwitch />
      <button v-if="canVisit('site')" type="button" class="admin-topbar__settings" :aria-label="t('admin.nav.site')" :title="t('admin.nav.site')" @click="router.push('/admin/site')">
        <Settings :size="19" aria-hidden="true" />
        <span>{{ t('admin.topbar.settings') }}</span>
      </button>
    </div>
  </header>
</template>

<style scoped src="../../styles/admin/topbar.css"></style>
