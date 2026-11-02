import { computed, ref } from 'vue';

const storageKey = 'edgechat.lowEffects';
const preference = ref(false);
const systemPreference = ref(false);

export const lowEffectsPreference = computed(() => preference.value);
export const systemLowEffects = computed(() => systemPreference.value);
export const lowEffects = computed(() => preference.value || systemPreference.value);

function apply() {
  document.documentElement.dataset.effects = lowEffects.value ? 'low' : 'full';
}

export function setLowEffectsPreference(value: boolean) {
  preference.value = value;
  apply();
  try {
    if (value) localStorage.setItem(storageKey, 'true');
    else localStorage.removeItem(storageKey);
  } catch {
    // 浏览器禁止存储时仍允许当前页面降级，偏好不应阻塞聊天。
  }
}

export function initVisualEffects() {
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const transparency = window.matchMedia('(prefers-reduced-transparency: reduce)');
  try {
    preference.value = localStorage.getItem(storageKey) === 'true';
  } catch {
    preference.value = false;
  }

  function syncSystem() {
    // 系统无障碍偏好优先，取消手动低特效不会重新启用用户要求减少的效果。
    systemPreference.value = motion.matches || transparency.matches;
    apply();
  }

  function onStorage(event: StorageEvent) {
    if (event.storageArea !== localStorage || (event.key !== storageKey && event.key !== null)) return;
    preference.value = event.newValue === 'true';
    apply();
  }

  motion.addEventListener('change', syncSystem);
  transparency.addEventListener('change', syncSystem);
  window.addEventListener('storage', onStorage);
  syncSystem();

  return () => {
    motion.removeEventListener('change', syncSystem);
    transparency.removeEventListener('change', syncSystem);
    window.removeEventListener('storage', onStorage);
  };
}
