import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test, { before } from 'node:test';
import { build } from 'vite';
import { analyzeFrontendBundle } from '../frontend/bundle-analysis.js';

let analysis;
before(async () => {
  const result = await build({
    configFile: fileURLToPath(new URL('../frontend/vite.config.js', import.meta.url)),
    logLevel: 'silent',
    build: { write: false }
  });
  analysis = analyzeFrontendBundle(result.output);
});

test('login/chat first screens exclude admin, settings, contacts, dialogs and Vditor code', () => {
  for (const page of ['LoginPage', 'ChatPage']) {
    const files = analysis.pageFiles(page, '/src/locales/en-US.js');
    const modules = analysis.modules(files);
    assert.ok(modules.some((module) => module.endsWith(`/pages/${page}.vue`)));
    for (const module of modules) {
      assert.doesNotMatch(module, /\/src\/(?:pages\/Admin|components\/admin\/|admin\/|styles\/admin)/);
      assert.doesNotMatch(module, /\/src\/pages\/(?:SettingsPage|ContactsPage)\.vue/);
      assert.doesNotMatch(module, /\/src\/components\/chat\/\w*Dialog\.vue/);
      assert.doesNotMatch(module, /\/src\/(?:vditor-runtime|webmcp)\.ts|\/node_modules\/vditor\//);
    }
    if (page === 'LoginPage') assert.ok(!modules.some((module) => module.endsWith('/pages/ChatPage.vue')));
    const css = [...files].filter((name) => name.endsWith('.css'));
    assert.ok(!css.some((name) => name.includes('Admin')));
  }
});

test('each admin route and each deferred dialog remains available in its own loading graph', () => {
  for (const page of ['AdminPage', 'AdminDashboardPage', 'AdminUsersPage', 'AdminStoragePage',
    'AdminInvitesPage', 'AdminTelegramPage', 'AdminInstanceBridgePage', 'AdminStealthPage',
    'AdminMaintenancePage', 'AdminSitePage', 'SettingsPage', 'ContactsPage']) {
    assert.ok(analysis.files.has(analysis.chunkFor(`/src/pages/${page}.vue`)));
  }
  for (const dialog of ['AddConversationDialog', 'CreateGroupDialog', 'GroupSettingsDialog',
    'UserProfileDialog', 'PublicGroupJoinDialog', 'MobileNavigationDrawer', 'MemberPanel']) {
    assert.ok(analysis.files.has(analysis.chunkFor(`/src/components/chat/${dialog}.vue`)));
  }
  const adminFiles = analysis.closure([analysis.chunkFor('/src/pages/AdminPage.vue')]);
  assert.ok([...adminFiles].some((name) => /AdminPage.*\.css$/.test(name)));
});

test('all three locales stay below the first-screen target and compiled frontend budget', () => {
  for (const [page, locales] of Object.entries(analysis.pages)) {
    for (const [locale, size] of Object.entries(locales)) {
      assert.ok(size.gzip <= 300_000, `${page} (${locale}): ${size.gzip} gzip bytes`);
    }
  }
  assert.ok(analysis.compiled.gzip <= 500_000, `${analysis.compiled.gzip} compiled gzip bytes`);
});

test('admin first-screen budgets include the shell but not other admin routes or user details', () => {
  for (const page of ['AdminDashboardPage', 'AdminUsersPage']) {
    const files = analysis.pageFiles(page, '/src/locales/en-US.js');
    const modules = analysis.modules(files);
    assert.ok(modules.some((module) => module.endsWith('/pages/AdminPage.vue')));
    assert.ok(modules.some((module) => module.endsWith(`/pages/${page}.vue`)));
    assert.ok([...files].some((file) => /AdminPage.*\.css$/.test(file)));
    assert.ok(!modules.some((module) => /\/pages\/Admin(?:Rbac|Telegram|Storage|Site)Page\.vue$/.test(module)));
    assert.ok(!modules.some((module) => /UserDetailsDialog|node_modules\/bowser/.test(module)));
  }
});

test('remote font failures cannot reject a lazy route CSS preload', () => {
  for (const file of analysis.files.values()) {
    if (file.type === 'asset' && file.fileName.endsWith('.css')) {
      assert.doesNotMatch(String(file.source), /@import\s+(?:url\()?['"]?https?:/i);
    }
  }
});
