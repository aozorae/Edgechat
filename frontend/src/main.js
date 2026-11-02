import { createApp } from 'vue';
import { Capacitor } from '@capacitor/core';
import App from './App.vue';
import router from './router.js';
import store from './store.js';
import {
  installCapacitorIntegration,
  queueNativeRoomTarget
} from './capacitor-platform.ts';
import './styles/base.css';
import './styles.css';
import './styles-liquid.css';
import './styles/tokens.css';
import './styles/layout.css';
import './styles/ui.css';
import './styles/color-themes.css';
import { initLiquidGlass } from './liquid-glass.js';
import { initializeI18n } from './i18n.js';
import { parseNotificationRoomTarget, takeNotificationRoomTarget } from './notification-target.js';
import { installChunkLoadRecovery } from './chunk-load.ts';

installChunkLoadRecovery(window);

// 点击通知后新打开的窗口从 URL 恢复会话；登录后聊天页也能消费这个目标。
const isCapacitorNative = Capacitor.isNativePlatform();
const initialNotificationTarget = isCapacitorNative ? null : takeNotificationRoomTarget(window);
if (initialNotificationTarget) queueNativeRoomTarget(initialNotificationTarget);

// 注册 Service Worker，使 Chrome/Edge 满足 PWA 可安装条件（地址栏安装按钮）。
// 仅在浏览器支持且非 Capacitor 原生环境下注册。
if ('serviceWorker' in navigator && !isCapacitorNative) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // 注册失败不影响应用功能，忽略即可。
    });
  });

  // 系统通知（Service Worker 弹出）被点击时，打开对应会话。
  navigator.serviceWorker.addEventListener('message', (event) => {
    const payload = event.data;
    if (payload?.type !== 'edgechat:notification-click') return;
    const target = parseNotificationRoomTarget(payload.data);
    if (!target) return;
    queueNativeRoomTarget(target);
    void router.push('/');
  });
}

// 应用自定义背景
const customBg = localStorage.getItem('customBackground');
if (customBg) {
  document.body.style.background = customBg;
}

initializeI18n().finally(() => {
  void store.initialize();
  const app = createApp(App);
  app.use(router);
  app.mount('#app');
  if (typeof document.modelContext?.registerTool === 'function') {
    void import('./webmcp.ts').then(({ registerEdgeChatWebMcp }) => registerEdgeChatWebMcp()).catch(() => {
      // 实验性浏览器集成不可用时，普通聊天仍应正常启动。
    });
  }
  void installCapacitorIntegration({
    async onOpenRoom(target) {
      await router.push('/');
      queueNativeRoomTarget(target);
    }
  });

  // 初始化 Liquid Glass 效果
  setTimeout(initLiquidGlass, 100);
});
