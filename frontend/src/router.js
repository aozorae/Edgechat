import { createRouter, createWebHashHistory, createWebHistory } from 'vue-router';
import { isCapacitorAndroid } from './capacitor-platform.ts';
import { isDemoMode } from './runtime.js';
import store from './store.js';
import { addAuthInvalidListener } from './auth-storage.js';
import { canVisit, firstAdminPage } from './authorization.ts';

const router = createRouter({
  history: isCapacitorAndroid ? createWebHashHistory() : createWebHistory(),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('./pages/LoginPage.vue'),
      meta: { public: true, transition: 'page' }
    },
    {
      path: '/register/:token',
      name: 'register',
      component: () => import('./pages/RegisterPage.vue'),
      meta: { public: true, transition: 'page' }
    },
    {
      path: '/',
      name: 'chat',
      component: () => import('./pages/ChatPage.vue'),
      meta: { transition: 'page', workspace: true }
    },
    {
      path: '/contacts',
      name: 'contacts',
      component: () => import('./pages/ChatPage.vue'),
      meta: { transition: 'page', workspace: true }
    },
    {
      path: '/admin',
      component: () => import('./pages/AdminPage.vue'),
      meta: { admin: true, transition: 'page' },
      children: [
        {
          path: 'rbac', name: 'admin-rbac', component: () => import('./pages/AdminRbacPage.vue'),
          meta: { admin: true, adminTitleKey: 'rbac.title', adminIcon: 'rbac', transition: 'page' }
        },
        {
          path: 'channels', name: 'admin-channels', component: () => import('./pages/AdminChannelsPage.vue'),
          meta: { admin: true, adminTitleKey: 'rbac.channels', adminIcon: 'channels', transition: 'page' }
        },
        {
          path: '',
          redirect: { name: 'admin-dashboard' }
        },
        {
          path: 'dashboard',
          name: 'admin-dashboard',
          component: () => import('./pages/AdminDashboardPage.vue'),
          meta: { admin: true, adminTitleKey: 'admin.nav.dashboard', adminIcon: 'dashboard', transition: 'page' }
        },
        {
          path: 'users',
          name: 'admin-users',
          component: () => import('./pages/AdminUsersPage.vue'),
          meta: { admin: true, adminTitleKey: 'admin.nav.users', adminIcon: 'users', transition: 'page' }
        },
        {
          path: 'storage',
          name: 'admin-storage',
          component: () => import('./pages/AdminStoragePage.vue'),
          meta: { admin: true, adminTitleKey: 'admin.nav.storage', adminIcon: 'storage', transition: 'page' }
        },
        {
          path: 'invites',
          name: 'admin-invites',
          component: () => import('./pages/AdminInvitesPage.vue'),
          meta: { admin: true, adminTitleKey: 'admin.nav.invites', adminIcon: 'invites', transition: 'page' }
        },
        {
          path: 'distribution',
          name: 'admin-distribution',
          component: () => import('./pages/AdminDistributionPage.vue'),
          meta: { admin: true, adminTitleKey: 'admin.nav.distribution', adminIcon: 'distribution', transition: 'page' }
        },
        {
          path: 'telegram',
          name: 'admin-telegram',
          component: () => import('./pages/AdminTelegramPage.vue'),
          meta: { admin: true, adminTitleKey: 'admin.nav.telegram', adminIcon: 'telegram', transition: 'page' }
        },
        {
          path: 'instance-bridge',
          name: 'admin-instance-bridge',
          component: () => import('./pages/AdminInstanceBridgePage.vue'),
          meta: { admin: true, adminTitleKey: 'bridge.title', adminIcon: 'instance-bridge', transition: 'page' }
        },
        {
          path: 'stealth',
          name: 'admin-stealth',
          component: () => import('./pages/AdminStealthPage.vue'),
          meta: { admin: true, adminTitleKey: 'stealth.title', adminIcon: 'stealth', transition: 'page' }
        },
        {
          path: 'maintenance',
          name: 'admin-maintenance',
          component: () => import('./pages/AdminMaintenancePage.vue'),
          meta: { admin: true, adminTitleKey: 'admin.nav.maintenance', adminIcon: 'maintenance', transition: 'page' }
        },
        {
          path: 'site',
          name: 'admin-site',
          component: () => import('./pages/AdminSitePage.vue'),
          meta: { admin: true, adminTitleKey: 'admin.nav.site', adminIcon: 'site', transition: 'page' }
        }
      ]
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('./pages/SettingsPage.vue'),
      meta: { transition: 'page' }
    }
  ]
});

if (typeof window !== 'undefined') {
  addAuthInvalidListener(() => {
    if (router.currentRoute.value.path !== '/login') {
      void router.push('/login');
    }
  });
}

router.beforeEach(async (to, from) => {
  if (!store.ready) {
    await store.initialize();
  }

  if (to.meta.public) {
    if (!isDemoMode && store.session && to.path === '/login') {
      return '/';
    }
    return true;
  }

  if (!store.session) {
    return '/login';
  }

  if (to.meta.admin) {
    try { await store.refreshAuthorization(); } catch { return '/'; }
    if (!canVisit(to.path.split('/')[2])) return firstAdminPage();
  }

  if (
    to.meta.admin &&
    !from.meta.admin &&
    from.matched.length > 0 &&
    !isDemoMode &&
    !isCapacitorAndroid
  ) {
    // Cloudflare Access 按文档请求判定路径；跨入后台必须离开 SPA，才能让 /admin 经过边缘访问策略。
    window.location.assign(router.resolve(to.fullPath).href);
    return false;
  }

  return true;
});

export default router;
