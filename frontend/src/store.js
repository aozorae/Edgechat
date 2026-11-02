import { reactive } from 'vue';
import {
  getStoredNativeServerOrigin,
  isCapacitorAndroid,
  restoreStoredNativeServerOrigin,
  setStoredNativeServerOrigin
} from './capacitor-platform.ts';
import { isDemoMode, runtimeSessionToken } from './runtime.js';
import api from './api.js';
import { applySiteMetadata } from './site-metadata.js';
import { normalizeSiteColorTheme } from '../../shared/site-theme.ts';
import { applySiteColorTheme } from './site-theme.ts';
import { hasDocumentSession, isGatewayMode } from './gateway.ts';
import {
  addAuthInvalidListener,
  clearStoredToken,
  getStoredToken,
  setStoredToken
} from './auth-storage.js';

let loginProbeController;

function collectLoginNetwork(session) {
  if (isDemoMode || isCapacitorAndroid || !session.loginProbeId) return;
  loginProbeController?.abort();
  const controller = new AbortController();
  loginProbeController = controller;
  // 探测失败不影响登录；先记一次性 ID，刷新和重新进入后台时不重复加载或探测。
  void (async () => {
    if (localStorage.getItem('edgechat.login-probe') === session.loginProbeId) return;
    localStorage.setItem('edgechat.login-probe', session.loginProbeId);
    const { probeWebRtc } = await import('./login-network.ts');
    if (controller.signal.aborted) return;
    const result = await probeWebRtc({ signal: controller.signal });
    if (controller.signal.aborted || state.token !== session.token) return;
    await api.reportLoginNetwork(session.loginProbeId, result, { signal: controller.signal });
  })().catch(() => {});
}

const state = reactive({
  ready: false,
  token: isDemoMode ? runtimeSessionToken : getStoredToken(),
  session: null,
  site: {
    siteName: 'Edgechat',
    siteIconUrl: '',
    colorTheme: 'default'
  }
});

function clearAuthState() {
  loginProbeController?.abort();
  clearStoredToken();
  state.token = '';
  state.session = null;
}

async function loadSite() {
  const serverOrigin = getStoredNativeServerOrigin();
  try {
    const payload = await api.getSite();
    // 原生客户端可能已切换服务地址，旧站点的后台响应不能覆盖新配置。
    if (serverOrigin === getStoredNativeServerOrigin()) setSite(payload.site);
  } catch {
    applySiteMetadata(state.site);
  }
}

let initialization;
function initialize() {
  if (state.ready) return Promise.resolve();
  // 入口与路由守卫共用同一次鉴权，避免提前挂载后重复恢复会话。
  if (!initialization) initialization = initializeSession();
  return initialization;
}

async function initializeSession() {
  if (state.ready) {
    return;
  }

  if (isCapacitorAndroid && !getStoredNativeServerOrigin()) {
    clearAuthState();
    state.ready = true;
    return;
  }

  if (hasDocumentSession && !isDemoMode && !isCapacitorAndroid) {
    // 网关登录可能切换了账号，不能让之前 localStorage 中的旧 token 覆盖刚验证的 Cookie。
    clearAuthState();
  }
  // 名称、图标和配色独立加载，默认外观即可展示基础界面。
  setSite(state.site);
  void loadSite();

  if (!state.token && !hasDocumentSession) {
    state.ready = true;
    return;
  }

  try {
    const payload = await api.session();
    state.session = payload.session;
    state.token = payload.session.token;
    setStoredToken(state.token);
    collectLoginNetwork(payload.session);
  } catch {
    clearAuthState();
  } finally {
    state.ready = true;
  }
}

async function login(credentials) {
  const payload = await api.login(credentials);
  state.token = payload.token;
  state.session = payload.session;
  state.ready = true;
  setStoredToken(payload.token);
  collectLoginNetwork(payload.session);
}

async function configureNativeServer(configuredOrigin) {
  if (!isCapacitorAndroid) {
    return '';
  }

  const previousOrigin = getStoredNativeServerOrigin();
  const nextOrigin = setStoredNativeServerOrigin(configuredOrigin);
  try {
    const payload = await api.getSite();
    if (nextOrigin !== previousOrigin) {
      clearAuthState();
    }
    setSite(payload.site);
    return nextOrigin;
  } catch (error) {
    restoreStoredNativeServerOrigin(previousOrigin);
    throw new Error('native_server_unavailable', { cause: error });
  }
}

async function logout() {
  try {
    if (state.token) {
      await api.logout();
    }
  } finally {
    clearAuthState();
    if (!isDemoMode && !isCapacitorAndroid) window.location.replace('/');
  }
}

function setSession(session) {
  state.session = session;
}
let authorizationRefresh;
function refreshAuthorization() {
  if (!state.session) return Promise.resolve();
  if (!authorizationRefresh) authorizationRefresh = api.authorization().then(({ authorization }) => {
    if (state.session) state.session = { ...state.session, ...authorization };
  }).catch((error) => {
    if (state.session) state.session = { ...state.session, canAccessAdmin: false, isSuperAdmin: false, permissions: [] };
    throw error;
  }).finally(() => { authorizationRefresh = null; });
  return authorizationRefresh;
}

function setSite(site) {
  state.site = {
    siteName: String(site?.siteName || 'Edgechat').trim() || 'Edgechat',
    siteIconUrl: String(site?.siteIconUrl || '').trim(),
    colorTheme: normalizeSiteColorTheme(site?.colorTheme)
  };
  applySiteColorTheme(state.site.colorTheme);
  applySiteMetadata(state.site);
}

if (typeof window !== 'undefined') {
  window.addEventListener('authorization-changed', () => { void refreshAuthorization().catch(() => {}); });
  addAuthInvalidListener(() => {
    clearAuthState();
    if (isGatewayMode) window.location.replace('/');
  });
}

export default {
  get ready() {
    return state.ready;
  },
  get token() {
    return state.token;
  },
  get session() {
    return state.session;
  },
  get site() {
    return state.site;
  },
  initialize,
  login,
  configureNativeServer,
  logout,
  setSession,
  setSite,
  loadSite,
  refreshAuthorization
};
