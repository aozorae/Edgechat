import { createApp } from 'vue';
import App from './App.vue';
import router from './router.js';
import store from './store.js';
import { registerEdgeChatWebMcp } from './webmcp.ts';
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
import './styles/admin.css';
import './styles/chat.css';
import './styles/chat-messages.css';
import './styles/chat-attachments.css';
import './styles/chat-theme.css';
import { initLiquidGlass } from './liquid-glass.js';

// 应用自定义背景
const customBg = localStorage.getItem('customBackground');
if (customBg) {
  document.body.style.background = customBg;
}

store.initialize().finally(() => {
  const app = createApp(App);
  app.use(router);
  app.mount('#app');
  void registerEdgeChatWebMcp();
  void installCapacitorIntegration({
    async onOpenRoom(target) {
      await router.push('/');
      queueNativeRoomTarget(target);
    }
  });

  // 初始化 Liquid Glass 效果
  setTimeout(initLiquidGlass, 100);
});
