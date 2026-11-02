<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref } from 'vue';
import { loadTurnstile } from '../turnstile.ts';

const container = ref<HTMLElement>();
const active = ref(false);
let widget: string | undefined;
let cancel: (() => void) | undefined;
let disposed = false;

function reset() {
  if (widget !== undefined) window.turnstile?.remove(widget);
  widget = undefined;
  active.value = false;
}

async function verify(siteKey: string): Promise<string> {
  await loadTurnstile();
  reset();
  active.value = true;
  await nextTick();
  const turnstile = window.turnstile;
  const element = container.value;
  if (disposed || !turnstile || !element) throw new Error('turnstile_unavailable');
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await new Promise<string>((resolve, reject) => {
      const failed = () => reject(new Error('turnstile_failed'));
      timer = setTimeout(failed, 120000);
      cancel = () => { clearTimeout(timer); failed(); };
      // 每次点击登录都创建新挑战，密码错误后的重试不能复用上一次的单次 token。
      widget = turnstile.render(element, {
        sitekey: siteKey, action: 'login', execution: 'execute', size: 'compact', retry: 'never',
        callback: (token: string) => { clearTimeout(timer); resolve(token); },
        'error-callback': () => { clearTimeout(timer); failed(); },
        'expired-callback': () => { clearTimeout(timer); failed(); },
        'timeout-callback': () => { clearTimeout(timer); failed(); },
      });
      turnstile.execute(widget);
    });
  } finally {
    clearTimeout(timer);
    cancel = undefined;
    reset();
  }
}

onBeforeUnmount(() => { disposed = true; cancel?.(); reset(); });
defineExpose({ verify });
</script>

<template>
  <div v-show="active" ref="container" class="login-verification" />
</template>

<style scoped>
.login-verification { width: 100%; min-height: 65px; }
</style>
