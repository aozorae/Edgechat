import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { computed, ref, watch } from 'vue';

function load(name, context, exports) {
  const source = readFileSync(new URL(`../frontend/src/${name}.ts`, import.meta.url), 'utf8');
  return runInNewContext(`${stripTypeScriptTypes(source)
    .replace(/^import .+;\r?\n/gm, '')
    .replace(/^export /gm, '')}\n({${exports}})`, { computed, ref, watch, ...context });
}

function eventTarget() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(callback);
    },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
    emit(type, event = {}) { for (const callback of listeners.get(type) || []) callback(event); },
    count(type) { return listeners.get(type)?.size || 0; }
  };
}

class ElementStub {
  constructor({ parent = null, matches = true } = {}) {
    this.parentElement = parent;
    this.matchesSelector = matches;
    this.isConnected = true;
    this.reads = 0;
    this.writes = 0;
    this.properties = new Map();
    this.style = {
      setProperty: (key, value) => { this.writes++; this.properties.set(key, value); },
      removeProperty: (key) => this.properties.delete(key)
    };
  }
  closest() { return this.matchesSelector ? this : this.parentElement?.closest() || null; }
  contains(target) {
    for (let node = target; node; node = node.parentElement) {
      if (node === this) return true;
    }
    return false;
  }
  getBoundingClientRect() { this.reads++; return { left: 10, top: 20 }; }
}

function browser({ hover = true, motion = false, transparency = false, stored = null } = {}) {
  const media = new Map();
  const window = eventTarget();
  const document = { ...eventTarget(), hidden: false, documentElement: { dataset: {} } };
  const frames = new Map();
  let id = 0;
  const storage = new Map(stored === null ? [] : [['edgechat.lowEffects', stored]]);
  const localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key)
  };
  window.matchMedia = (query) => {
    if (!media.has(query)) {
      const matches = query.includes('reduced-motion') ? motion : query.includes('reduced-transparency') ? transparency : hover;
      media.set(query, { ...eventTarget(), matches });
    }
    return media.get(query);
  };
  window.requestAnimationFrame = (callback) => { frames.set(++id, callback); return id; };
  window.cancelAnimationFrame = (frame) => frames.delete(frame);
  const context = { window, document, localStorage, Element: ElementStub, Node: ElementStub };
  const preferences = load('visual-effects', context, 'initVisualEffects,setLowEffectsPreference,lowEffects,lowEffectsPreference,systemLowEffects');
  const disposePreferences = preferences.initVisualEffects();
  const glass = load('liquid-glass', { ...context, lowEffects: preferences.lowEffects }, 'initLiquidGlass');
  const disposeGlass = glass.initLiquidGlass();
  return {
    ...context, ...preferences, ...glass, frames, media, storage,
    move(target, x = 40, pointerType = 'mouse') {
      document.emit('pointermove', { target, clientX: x, clientY: 80, pointerType });
    },
    flush() {
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach(callback => { callback(); });
    },
    changeMedia(fragment, matches) {
      const query = [...media.keys()].find(key => key.includes(fragment));
      media.get(query).matches = matches;
      media.get(query).emit('change');
    },
    dispose() { disposeGlass(); disposePreferences(); }
  };
}

test('玻璃效果重复初始化只保留一组委托监听，新增节点无需扫描或绑定', () => {
  const h = browser();
  const dispose = h.initLiquidGlass();
  assert.equal(h.initLiquidGlass(), dispose);
  for (const type of ['pointermove', 'pointerout', 'pointercancel']) assert.equal(h.document.count(type), 1);
  // stub 不实现 querySelectorAll / MutationObserver / 节点监听器；这些操作一旦回归会直接失败。
  for (let i = 0; i < 100; i++) {
    const dynamic = new ElementStub();
    h.move(dynamic);
    h.flush();
    assert.equal(dynamic.writes, 2);
  }
  assert.equal(h.document.count('pointermove'), 1);
  h.dispose();
});

test('高频指针每帧只处理最新坐标，并同时更新嵌套表面', () => {
  const h = browser();
  const panel = new ElementStub();
  const bubble = new ElementStub({ parent: panel });
  const icon = new ElementStub({ parent: bubble, matches: false });
  for (let i = 0; i < 50; i++) h.move(icon, i);
  assert.equal(h.frames.size, 1);
  assert.equal(bubble.reads, 0);
  h.flush();
  for (const element of [bubble, panel]) {
    assert.equal(element.reads, 1);
    assert.equal(element.writes, 2);
    assert.equal(element.properties.get('--m-x'), '39px');
  }
  h.move(new ElementStub({ matches: false }));
  h.flush();
  assert.equal(panel.properties.size, 0);
  assert.equal(bubble.properties.size, 0);
  h.dispose();
});

test('离开表面或窗口、取消指针、切换低特效均清除高光和待执行帧', () => {
  const h = browser();
  const panel = new ElementStub();
  for (const clear of [
    () => h.document.emit('pointerout', { relatedTarget: new ElementStub({ matches: false }) }),
    () => h.document.emit('pointerout', { relatedTarget: null }),
    () => h.document.emit('pointercancel'),
    () => h.window.emit('blur'),
    () => h.setLowEffectsPreference(true)
  ]) {
    h.move(panel);
    h.flush();
    h.move(panel);
    clear();
    assert.equal(h.frames.size, 0);
    assert.equal(panel.properties.size, 0);
  }
  assert.equal(h.document.count('pointermove'), 0);
  h.setLowEffectsPreference(false);
  assert.equal(h.document.count('pointermove'), 1);
  h.dispose();
});

test('表面内部切换子节点不丢帧，帧执行前移除的节点不读取布局', () => {
  const h = browser();
  const panel = new ElementStub();
  const child = new ElementStub({ parent: panel, matches: false });
  h.move(child);
  h.document.emit('pointerout', { relatedTarget: panel });
  assert.equal(h.frames.size, 1);
  panel.isConnected = false;
  h.flush();
  assert.equal(panel.reads, 0);
  h.dispose();
});

test('无悬停设备与后台页面不注册移动监听，触摸输入不安排帧', () => {
  const h = browser({ hover: false });
  assert.equal(h.document.count('pointermove'), 0);
  h.changeMedia('hover:', true);
  assert.equal(h.document.count('pointermove'), 1);
  h.move(new ElementStub(), 40, 'touch');
  assert.equal(h.frames.size, 0);
  h.move(new ElementStub());
  h.document.hidden = true;
  h.document.emit('visibilitychange');
  assert.equal(h.frames.size, 0);
  assert.equal(h.document.count('pointermove'), 0);
  h.document.hidden = false;
  h.document.emit('visibilitychange');
  assert.equal(h.document.count('pointermove'), 1);
  h.dispose();
  for (const callbacks of h.document.listeners.values()) assert.equal(callbacks.size, 0);
  for (const callbacks of h.window.listeners.values()) assert.equal(callbacks.size, 0);
  for (const query of h.media.values()) assert.equal(query.count('change'), 0);
  const dispose = h.initLiquidGlass();
  assert.equal(h.document.count('pointermove'), 1);
  dispose();
});

test('低特效偏好持久化且跟随系统动态变化，手动关闭不能覆盖无障碍偏好', () => {
  const h = browser({ stored: 'true' });
  assert.equal(h.document.documentElement.dataset.effects, 'low');
  assert.equal(h.document.count('pointermove'), 0);
  h.setLowEffectsPreference(false);
  assert.equal(h.document.documentElement.dataset.effects, 'full');
  assert.equal(h.storage.has('edgechat.lowEffects'), false);
  for (const setting of ['reduced-motion', 'reduced-transparency']) {
    h.changeMedia(setting, true);
    h.setLowEffectsPreference(false);
    assert.equal(h.document.documentElement.dataset.effects, 'low');
    assert.equal(h.systemLowEffects.value, true);
    h.changeMedia(setting, false);
    assert.equal(h.document.documentElement.dataset.effects, 'full');
  }
  h.setLowEffectsPreference(true);
  assert.equal(h.storage.get('edgechat.lowEffects'), 'true');
  h.dispose();
});

test('跨标签同步与清空偏好及时生效，不消费其他存储事件', () => {
  const h = browser();
  h.window.emit('storage', { key: 'edgechat.lowEffects', newValue: 'true', storageArea: {} });
  assert.equal(h.lowEffects.value, false);
  h.window.emit('storage', { key: 'unrelated', newValue: 'true', storageArea: h.localStorage });
  assert.equal(h.lowEffects.value, false);
  h.window.emit('storage', { key: 'edgechat.lowEffects', newValue: 'true', storageArea: h.localStorage });
  assert.equal(h.lowEffects.value, true);
  h.window.emit('storage', { key: null, newValue: null, storageArea: h.localStorage });
  assert.equal(h.lowEffects.value, false);
  h.dispose();
});

test('存储不可用仍能在当前页面启用低特效', () => {
  const h = browser();
  h.localStorage.setItem = () => { throw new Error('storage disabled'); };
  h.setLowEffectsPreference(true);
  assert.equal(h.lowEffects.value, true);
  assert.equal(h.document.documentElement.dataset.effects, 'low');
  h.dispose();
});
