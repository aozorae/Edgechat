import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function read(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

const routerSource = read('../frontend/src/router.js');
const apiSource = read('../frontend/src/api.js');
const adminApiSource = read('../worker/src/api/admin.js');
const mainSource = read('../frontend/src/main.js');
const adminPageSource = read('../frontend/src/pages/AdminPage.vue');
const navigationSource = read('../frontend/src/admin/navigation.js');
const sidebarSource = read('../frontend/src/components/admin/AdminSidebar.vue');
const dashboardSource = read('../frontend/src/pages/AdminDashboardPage.vue');
const usersSource = read('../frontend/src/pages/AdminUsersPage.vue');
const userBanDialogSource = read('../frontend/src/components/admin/UserBanDialog.vue');
const userBanDurationSource = read('../frontend/src/admin/user-ban-duration.js');
const storageSource = read('../frontend/src/pages/AdminStoragePage.vue');
const invitesSource = read('../frontend/src/pages/AdminInvitesPage.vue');
const userCreatorSource = read('../frontend/src/components/admin/AdminUserCreator.vue');
const inviteManagerSource = read('../frontend/src/components/admin/RegistrationInviteManager.vue');
const siteSource = read('../frontend/src/pages/AdminSitePage.vue');
const siteAppearanceSource = read('../frontend/src/components/admin/AdminSiteAppearance.vue');
const telegramSource = read('../frontend/src/pages/AdminTelegramPage.vue');
const adminStyles = read('../frontend/src/styles/admin.css');
const adminTokens = read('../frontend/src/styles/admin/tokens.css');
const adminLayout = read('../frontend/src/styles/admin/layout.css');
const adminSidebarStyles = read('../frontend/src/styles/admin/sidebar.css');
const userBanDialogStyles = read('../frontend/src/styles/admin/user-ban-dialog.css');
const legacyTokens = read('../frontend/src/styles/tokens.css');
const dashboardStyles = read('../frontend/src/styles/admin/dashboard.css');
const invitesPageStyles = read('../frontend/src/styles/admin/invites-page.css');
const userCreatorStyles = read('../frontend/src/styles/admin/user-creator.css');
const inviteManagerStyles = read('../frontend/src/styles/admin/invite-manager.css');

test('后台默认进入仪表盘并新增受保护的注册邀请页', () => {
  assert.match(routerSource, /component: \(\) => import\('\.\/pages\/AdminDashboardPage\.vue'\)/);
  assert.match(routerSource, /component: \(\) => import\('\.\/pages\/AdminInvitesPage\.vue'\)/);
  assert.match(routerSource, /redirect: \{ name: 'admin-dashboard' \}/);
  assert.match(routerSource, /path: 'dashboard'/);
  assert.match(routerSource, /path: 'invites'/);
  assert.match(routerSource, /adminTitleKey: 'admin\.nav\.invites'/);
  assert.match(routerSource, /meta: \{ admin: true/);
});

test('生产 Web 跨入后台时发起真实文档请求，后台内部仍使用 SPA 导航', () => {
  assert.match(routerSource, /router\.beforeEach\(async \(to, from\) =>/);
  assert.match(routerSource, /to\.meta\.admin &&[\s\S]*!from\.meta\.admin/);
  assert.match(routerSource, /from\.matched\.length > 0/);
  assert.match(routerSource, /!isDemoMode &&[\s\S]*!isCapacitorAndroid/);
  assert.match(routerSource, /window\.location\.assign\(router\.resolve\(to\.fullPath\)\.href\)/);
  assert.match(sidebarSource, /void router\.push\(location\)/);
  assert.match(dashboardSource, /void router\.push\(path\)/);
});

test('侧栏包含存储统计并移除消息查看入口', () => {
  assert.match(sidebarSource, /t\('admin\.sidebar\.brand'\)/);
  for (const id of ['dashboard', 'users', 'storage', 'invites', 'telegram', 'site']) {
    assert.match(navigationSource, new RegExp(`id: '${id}'`));
  }
  assert.match(navigationSource, /labelKey: 'admin\.nav\.createUser'/);
  assert.match(navigationSource, /labelKey: 'admin\.nav\.registrationLinks'/);
  assert.match(navigationSource, /labelKey: 'admin\.nav\.siteAppearance'/);
  assert.match(navigationSource, /labelKey: 'admin\.nav\.versionUpdate'/);
  assert.doesNotMatch(navigationSource, /信息查看|\/admin\/messages/);
  assert.match(sidebarSource, /v-if="!item\.children"/);
  assert.match(sidebarSource, /:aria-expanded="isGroupOpen\(item\)"/);
  assert.match(sidebarSource, /v-show="isGroupOpen\(item\)"/);
});

test('侧栏维护入口按导航顺序排列且不吸附到底部', () => {
  const navigationOrder = ['storage', 'invites', 'telegram', 'site', 'maintenance'].map(
    (id) => navigationSource.indexOf(`id: '${id}'`)
  );
  assert.ok(navigationOrder.every((index) => index >= 0));
  assert.deepEqual(navigationOrder, [...navigationOrder].sort((a, b) => a - b));
  assert.match(navigationSource, /id: 'maintenance'[\s\S]*separated: true/);
  assert.match(sidebarSource, /admin-nav-item--separated/);
  assert.match(adminSidebarStyles, /\.admin-nav-item--separated\s*\{[\s\S]*margin-block-start:/);
  assert.doesNotMatch(adminSidebarStyles, /\.admin-nav-item--separated\s*\{[\s\S]*margin-block-start:\s*auto/);
});

test('侧栏分组默认收起，主按钮导航且仅箭头负责展开', () => {
  assert.match(sidebarSource, /openGroups\s*=\s*ref\(new Set\(\)\)/);
  assert.doesNotMatch(sidebarSource, /watch\s*\(/);
  assert.match(sidebarSource, /class="admin-nav-item admin-nav-item--group"[\s\S]*@click="navigate\(item\.to\)"/);
  assert.match(sidebarSource, /class="admin-nav-group__toggle"[\s\S]*@click="toggleGroup\(item\.id\)"/);
  assert.match(adminSidebarStyles, /\.admin-nav-group__toggle\s*\{[\s\S]*flex:\s*0 0 44px;/);
});

test('存储统计由按钮手动刷新且四个统计列均可排序', () => {
  assert.match(routerSource, /component: \(\) => import\('\.\/pages\/AdminStoragePage\.vue'\)/);
  assert.match(routerSource, /path: 'storage'/);
  assert.match(apiSource, /adminStorageScan/);
  const storageApi = readFileSync(new URL('../worker/src/api/storage.ts', import.meta.url), 'utf8');
  assert.match(storageApi, /\/api\/admin\/storage\/scan/);
  assert.match(storageApi, /FILES\.list/);
  assert.match(storageApi, /没有绑定 R2，无法统计存储空间/);
  assert.match(storageSource, /@click="refreshStorage"/);
  assert.doesNotMatch(storageSource, /onMounted\(refreshStorage\)/);
  assert.doesNotMatch(storageSource, /尚未统计|10 GB|免费存储/);
  for (const key of ['objectCount', 'bytes', 'share', 'latestUploadedAt']) {
    assert.match(storageSource, new RegExp(`key: '${key}'`));
  }
  assert.match(storageSource, /@click="changeSort\(column\.key\)"/);
});

test('用户管理只维护用户列表，创建用户和注册链接集中在注册邀请页', () => {
  assert.match(usersSource, /t\('users\.list'\)/);
  assert.doesNotMatch(usersSource, /AdminUserCreator|RegistrationInviteManager|创建用户|注册链接/);
  assert.match(invitesSource, /import AdminUserCreator/);
  assert.match(invitesSource, /import RegistrationInviteManager/);
  assert.match(invitesSource, /id="create-user"/);
  assert.match(invitesSource, /id="registration-links"/);
});

test('用户管理通过独立弹窗选择快捷、自定义或永久封禁时长', () => {
  assert.match(usersSource, /import UserBanDialog/);
  assert.match(usersSource, /banDurationMinutes/);
  assert.match(usersSource, /@confirm="disableUser"/);
  assert.match(userBanDialogSource, /role="dialog"/);
  assert.match(userBanDialogSource, /useOverlayLifecycle/);
  assert.match(userBanDialogSource, /value="days"/);
  assert.match(userBanDialogSource, /value="hours"/);
  assert.match(userBanDialogSource, /value="minutes"/);
  assert.match(userBanDialogSource, /selection === 'custom'/);
  assert.match(userBanDialogSource, /value: 'permanent'/);
  assert.match(userBanDurationSource, /BAN_DURATION_PRESETS/);
  assert.match(adminStyles, /user-ban-dialog\.css/);
  assert.match(userBanDialogStyles, /@media \(max-width: 480px\)/);
  assert.match(usersSource, /user\.disabledUntil/);
  assert.match(adminApiSource, /disabled_until = \?/);
  assert.match(adminApiSource, /session_version = session_version \+ 1/);
});

test('注册邀请页限制内容宽度并用独立卡片组织创建工具与链接列表', () => {
  assert.match(invitesSource, /admin-invites-page/);
  assert.match(invitesPageStyles, /max-width: 1120px/);
  assert.match(userCreatorSource, /admin-user-creator__identity-grid/);
  assert.match(userCreatorStyles, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(inviteManagerSource, /invite-create-panel/);
  assert.match(inviteManagerSource, /t\('invites\.createdCount', \{ count: invites\.length \}\)/);
  assert.match(inviteManagerSource, /admin-invite-card__status/);
  assert.match(inviteManagerStyles, /border: 1px solid var\(--admin-border-strong\)/);
  assert.doesNotMatch(inviteManagerStyles, /max-height: 320px|border-block-start: 1px solid var\(--admin-border\);\s*border-radius: 0/);
});

test('网站设置只读取站点配置且不重复展示统计信息', () => {
  assert.match(siteAppearanceSource, /api\.adminSiteSettings\(\)/);
  assert.doesNotMatch(siteSource, /adminOverview|admin-metric|站内用户|公开群组|私信会话/);
  assert.match(siteSource, /id="site-appearance"/);
  assert.match(siteSource, /id="version-update"/);
});

test('仪表盘复用现有概况接口并只展示可验证统计', () => {
  assert.match(dashboardSource, /api\.adminOverview\(\)/);
  assert.match(dashboardSource, /overview\.value\.stats\.messages/);
  assert.match(dashboardSource, /overview\.value\.stats\.activeUsers/);
  assert.doesNotMatch(dashboardSource, /overview\.value\.users/);
  assert.match(dashboardSource, /t\('dashboard\.quickAccess'\)/);
  assert.match(dashboardSource, /t\('dashboard\.systemOverview'\)/);
});

test('Telegram 互通页由管理员路由保护并统一管理公开与私有群组映射', () => {
  assert.match(routerSource, /component: \(\) => import\('\.\/pages\/AdminTelegramPage\.vue'\)/);
  assert.match(routerSource, /path: 'telegram'/);
  assert.match(routerSource, /adminTitleKey: 'admin\.nav\.telegram'/);
  assert.match(telegramSource, /api\.saveAdminTelegramConfig/);
  assert.match(telegramSource, /api\.createAdminTelegramMapping/);
  assert.match(telegramSource, /type="checkbox"/);
  assert.match(telegramSource, /t\('telegram\.chatId'\)/);
  assert.match(telegramSource, /t\('telegram\.edgechatGroup'\)/);
  assert.match(telegramSource, /channel\.kind === 'private'/);
});

test('仪表盘在中等桌面宽度提前重排且快捷入口文字保持完整', () => {
  assert.match(
    dashboardStyles,
    /@media \(max-width: 64rem\)[\s\S]*\.admin-dashboard__body\s*\{\s*grid-template-columns: minmax\(0, 1fr\);/
  );
  assert.match(
    dashboardStyles,
    /@media \(max-width: 75rem\)[\s\S]*\.admin-dashboard__metrics\s*\{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/
  );
  assert.match(dashboardStyles, /\.admin-quick-link__copy strong\s*\{[\s\S]*overflow-wrap: anywhere;/);
  assert.doesNotMatch(
    dashboardStyles,
    /\.admin-quick-link__copy strong\s*\{[\s\S]*?text-overflow: ellipsis;[\s\S]*?\}/
  );
});

test('轻量后台保留按需加载、可访问导航和按权限展示的设置入口', () => {
  const topbar = read('../frontend/src/components/admin/AdminTopbar.vue');
  assert.match(topbar, /v-if="canVisit\('site'\)"/);
  assert.match(topbar, /:aria-label="t\('admin\.nav\.site'\)"/);
  assert.match(sidebarSource, /:aria-current="isChildActive\(item, child\) \? 'location'/);
  assert.match(sidebarSource, /@keydown\.esc="closeMobileNavigation"/);
  assert.match(sidebarSource, /mobileToggle\.value\?\.focus\(\)/);
  assert.match(adminPageSource, /id="admin-main"[^>]+tabindex="-1"/);
  assert.match(adminSidebarStyles, /position: fixed;\s*inset: 60px 0 0;/);
  assert.doesNotMatch(adminStyles + adminTokens, /@import url|backdrop-filter/);
});

test('用户列表搜索明确为本页且保留原分页和权限操作', () => {
  assert.match(usersSource, /filterAdminUsers\(users\.value, query\.value\)/);
  assert.match(usersSource, /t\('users\.searchPage'\)/);
  assert.match(usersSource, /users\.length < 100/);
  assert.match(usersSource, /v-for="user in visibleUsers"/);
  assert.match(usersSource, /aria-labelledby="admin-users-title"/);
  assert.match(usersSource, /class="error-text" role="alert"/);
  assert.match(usersSource, /can\('users\.delete'\) && canTarget\(user\)/);
  assert.match(dashboardSource, /loading \|\| error \? '—'/);
});

test('管理员消息正文查看的页面、客户端调用与服务端接口均已下线', () => {
  assert.doesNotMatch(routerSource, /AdminMessagesPage|AdminRoomPage|admin-messages|admin-room/);
  assert.doesNotMatch(apiSource, /adminRoomMessages|searchMessages|\/admin\/messages\/search/);
  assert.doesNotMatch(adminApiSource, /\/api\/admin\/messages|\/api\/admin\/rooms.*messages/);
  assert.doesNotMatch(dashboardSource, /消息查看|\/admin\/messages/);
});

test('后台视觉令牌匹配参考图并按职责拆分样式文件', () => {
  assert.doesNotMatch(mainSource, /styles\/admin\.css/);
  assert.match(adminPageSource, /import '\.\.\/styles\/admin\.css';/);
  assert.match(adminStyles, /@import '\.\/admin\/tokens\.css';/);
  assert.match(adminStyles, /@import '\.\/admin\/layout\.css';/);
  assert.match(adminStyles, /@import '\.\/admin\/controls\.css';/);
  assert.match(adminTokens, /--admin-workspace: #f0f3f8;/);
  assert.match(adminTokens, /--admin-panel: #ffffff;/);
  assert.match(adminTokens, /--admin-ink: #0d1731;/);
  assert.match(adminTokens, /--admin-green-bg: #f1fdfb;/);
  assert.match(adminTokens, /--admin-green: #168c87;/);
  assert.doesNotMatch(adminTokens, /backdrop-filter|linear-gradient/);
  assert.doesNotMatch(legacyTokens, /admin-shell|admin-grid--two|admin-metric-grid--wide/);
});

test('后台核心 Vue 文件保持在单一职责的可维护规模', () => {
  for (const [name, source] of [
    ['AdminSidebar', sidebarSource],
    ['AdminDashboardPage', dashboardSource],
    ['AdminUsersPage', usersSource],
    ['AdminStoragePage', storageSource],
    ['AdminTelegramPage', telegramSource],
    ['AdminSitePage', siteSource]
  ]) {
    assert.ok(source.split('\n').length < 260, `${name} 不应重新膨胀为超大文件`);
  }
});

test('移动端后台始终保留独立的纵向滚动区域', () => {
  assert.match(adminLayout, /\.admin-page\s*\{[\s\S]*?height:\s*100dvh;[\s\S]*?overflow:\s*hidden;/);
  assert.match(adminLayout, /\.admin-workspace\s*\{[\s\S]*?min-height:\s*0;/);
  assert.match(adminLayout, /\.admin-content\s*\{[\s\S]*?min-height:\s*0;[\s\S]*?overflow-y:\s*auto;[\s\S]*?touch-action:\s*pan-y;/);
  assert.match(adminSidebarStyles, /\.admin-sidebar__body\s*\{[\s\S]*?overflow-y:\s*auto;[\s\S]*?touch-action:\s*pan-y;/);
});
