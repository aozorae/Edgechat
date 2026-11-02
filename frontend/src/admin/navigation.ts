import { Database, Gauge, Ghost, Link2, MessagesSquare, Palette, Send, Share2, ShieldCheck, UserPlus, Users, Wrench } from '@lucide/vue';

interface NavigationItem {
  id: string;
  labelKey: string;
  descriptionKey: string;
  to: string;
  icon: typeof Gauge;
  children?: { id: string; labelKey: string; hash: string; permission?: string }[];
}

interface NavigationSection {
  id: string;
  labelKey?: string;
  separated?: boolean;
  items: NavigationItem[];
}

export const adminNavigation: NavigationSection[] = [
  {
    id: 'overview',
    items: [
      { id: 'dashboard', labelKey: 'admin.nav.dashboard', descriptionKey: 'admin.nav.dashboardDescription', to: '/admin/dashboard', icon: Gauge }
    ]
  },
  {
    id: 'users-access',
    labelKey: 'admin.nav.usersAccess',
    items: [
      { id: 'rbac', labelKey: 'rbac.title', descriptionKey: 'rbac.description', to: '/admin/rbac', icon: ShieldCheck },
      { id: 'channels', labelKey: 'rbac.channels', descriptionKey: 'rbac.channelDescription', to: '/admin/channels', icon: MessagesSquare },
      { id: 'users', labelKey: 'admin.nav.users', descriptionKey: 'admin.nav.usersDescription', to: '/admin/users', icon: Users },
      {
        id: 'invites',
        labelKey: 'admin.nav.invites',
        descriptionKey: 'admin.nav.invitesDescription',
        to: '/admin/invites',
        icon: UserPlus,
        children: [
          { id: 'create-user', labelKey: 'admin.nav.createUser', hash: '#create-user', permission: 'users.create' },
          { id: 'registration-links', labelKey: 'admin.nav.registrationLinks', hash: '#registration-links', permission: 'invites.read' }
        ]
      },
      { id: 'distribution', labelKey: 'admin.nav.distribution', descriptionKey: 'admin.nav.distributionDescription', to: '/admin/distribution', icon: Share2 }
    ]
  },
  {
    id: 'integrations',
    labelKey: 'admin.nav.integrations',
    items: [
      { id: 'login-verification', labelKey: 'verification.title', descriptionKey: 'verification.description', to: '/admin/login-verification', icon: ShieldCheck },
      { id: 'telegram', labelKey: 'admin.nav.telegram', descriptionKey: 'admin.nav.telegramDescription', to: '/admin/telegram', icon: Send },
      { id: 'instance-bridge', labelKey: 'bridge.title', descriptionKey: 'bridge.description', to: '/admin/instance-bridge', icon: Link2 }
    ]
  },
  {
    id: 'site-system',
    separated: true,
    items: [
      {
        id: 'site',
        labelKey: 'admin.nav.site',
        descriptionKey: 'admin.nav.siteDescription',
        to: '/admin/site',
        icon: Palette,
        children: [
          { id: 'site-appearance', labelKey: 'admin.nav.siteAppearance', hash: '#site-appearance' },
          { id: 'version-update', labelKey: 'admin.nav.versionUpdate', hash: '#version-update' }
        ]
      },
      { id: 'storage', labelKey: 'admin.nav.storage', descriptionKey: 'admin.nav.storageDescription', to: '/admin/storage', icon: Database },
      { id: 'maintenance', labelKey: 'admin.nav.maintenance', descriptionKey: 'admin.nav.maintenanceDescription', to: '/admin/maintenance', icon: Wrench },
      { id: 'stealth', labelKey: 'stealth.title', descriptionKey: 'stealth.description', to: '/admin/stealth', icon: Ghost }
    ]
  }
];

// 顶栏与侧栏共用图标来源，避免新增页面后两处图标不一致。
export const adminRouteIcons = Object.fromEntries(
  adminNavigation.flatMap((section) => section.items.map((item) => [item.id, item.icon]))
);
