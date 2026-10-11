<script setup>
import { RouterView, useRoute, useRouter } from 'vue-router';
import { computed, onMounted, onUnmounted, watch } from 'vue';
import store from '../store.js';
import { canVisit, firstAdminPage } from '../authorization.ts';
import '../styles/admin.css';
import AdminSidebar from '../components/admin/AdminSidebar.vue';
import AdminTopbar from '../components/admin/AdminTopbar.vue';
import { useAdminAnchorScroll } from '../composables/useAdminAnchorScroll.js';
import { t } from '../i18n.js';

useAdminAnchorScroll();
const route = useRoute();
const router = useRouter();
const authorizationKey = computed(() => `${store.session?.authzVersion}:${store.session?.roleRevision}:${store.session?.isSuperAdmin}:${store.session?.permissions?.join(',')}`);
watch(authorizationKey, () => {
  if (!canVisit(route.path.split('/')[2])) void router.replace(firstAdminPage());
});
async function refreshAuthorization() {
  if (document.visibilityState !== 'visible') return;
  try { await store.refreshAuthorization(); } catch { void router.replace('/'); }
}
onMounted(() => {
  window.addEventListener('authorization-changed', refreshAuthorization);
  document.addEventListener('visibilitychange', refreshAuthorization);
});
onUnmounted(() => {
  window.removeEventListener('authorization-changed', refreshAuthorization);
  document.removeEventListener('visibilitychange', refreshAuthorization);
});
</script>

<template>
  <div class="admin-page">
    <a class="admin-skip-link" href="#admin-main">{{ t('admin.skipToContent') }}</a>
    <AdminSidebar />
    <section class="admin-workspace">
      <AdminTopbar />
      <main id="admin-main" class="admin-content" tabindex="-1">
        <div class="admin-content__inner">
          <RouterView :key="authorizationKey" />
        </div>
      </main>
    </section>
  </div>
</template>
