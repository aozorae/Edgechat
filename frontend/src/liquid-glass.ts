import { watch } from 'vue';
import { lowEffects } from './visual-effects.ts';

const selector = '.ui-surface, .chat-bubble, .liquid-glass-panel';
let dispose: (() => void) | undefined;

export function initLiquidGlass() {
  if (dispose) return dispose;

  const hover = window.matchMedia('(hover: hover) and (pointer: fine)');
  let frame: number | null = null;
  let pending: PointerEvent | null = null;
  let active: HTMLElement[] = [];
  let tracking = false;

  function reset(element: HTMLElement) {
    element.style.removeProperty('--m-x');
    element.style.removeProperty('--m-y');
  }

  function clear() {
    if (frame !== null) window.cancelAnimationFrame(frame);
    frame = null;
    pending = null;
    active.forEach(reset);
    active = [];
  }

  function render() {
    frame = null;
    const event = pending;
    pending = null;
    if (!event) return;

    const targets: HTMLElement[] = [];
    let element = event.target instanceof Element ? event.target.closest<HTMLElement>(selector) : null;
    while (element?.isConnected) {
      targets.push(element);
      element = element.parentElement?.closest<HTMLElement>(selector) ?? null;
    }

    // 只沿当前命中路径更新，先读完布局再写样式，避免逐个读写造成重复布局计算。
    const positions = targets.map((target) => {
      const rect = target.getBoundingClientRect();
      return { target, x: event.clientX - rect.left, y: event.clientY - rect.top };
    });
    for (const target of active) {
      if (!targets.includes(target)) reset(target);
    }
    for (const { target, x, y } of positions) {
      target.style.setProperty('--m-x', `${x}px`);
      target.style.setProperty('--m-y', `${y}px`);
    }
    active = targets;
  }

  function onMove(event: PointerEvent) {
    // 混合输入设备可能同时有触摸和鼠标，触摸不需要悬停高光。
    if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') return;
    pending = event;
    if (frame === null) frame = window.requestAnimationFrame(render);
  }

  function onOut(event: PointerEvent) {
    // 子节点之间移动不清空父面板；离开命中的面板则立即撤销旧高光与未执行帧。
    const next = event.relatedTarget;
    if (!(next instanceof Node)) {
      clear();
      return;
    }
    active = active.filter((target) => {
      if (target.contains(next)) return true;
      reset(target);
      return false;
    });
    const pendingSurface = pending?.target instanceof Element ? pending.target.closest(selector) : null;
    if (pendingSurface && !pendingSurface.contains(next)) {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = null;
      pending = null;
    }
  }

  function syncTracking() {
    const enabled = hover.matches && !lowEffects.value && !document.hidden;
    if (tracking === enabled) return;
    tracking = enabled;
    if (enabled) {
      // 委托给 document，一次注册即可覆盖未来节点，不再观察或扫描 DOM 子树。
      document.addEventListener('pointermove', onMove, { capture: true, passive: true });
      document.addEventListener('pointerout', onOut, true);
      document.addEventListener('pointercancel', clear, true);
    } else {
      document.removeEventListener('pointermove', onMove, true);
      document.removeEventListener('pointerout', onOut, true);
      document.removeEventListener('pointercancel', clear, true);
      clear();
    }
  }

  const stopWatch = watch(lowEffects, syncTracking, { flush: 'sync' });
  hover.addEventListener('change', syncTracking);
  document.addEventListener('visibilitychange', syncTracking);
  window.addEventListener('blur', clear);
  syncTracking();

  dispose = () => {
    stopWatch();
    hover.removeEventListener('change', syncTracking);
    document.removeEventListener('visibilitychange', syncTracking);
    window.removeEventListener('blur', clear);
    document.removeEventListener('pointermove', onMove, true);
    document.removeEventListener('pointerout', onOut, true);
    document.removeEventListener('pointercancel', clear, true);
    clear();
    dispose = undefined;
  };
  return dispose;
}
