<script setup>
import { ChevronDown } from '@lucide/vue';
import { ref } from 'vue';
import { t } from '../../i18n.js';
import UiAvatar from '../ui/Avatar.vue';

defineProps({
  items: { type: Array, default: () => [] }
});

const emit = defineEmits(['select']);
const expanded = ref(true);
</script>

<template>
  <section v-if="items.length" class="public-group-discovery">
    <button
      type="button"
      class="public-group-discovery__toggle"
      :aria-expanded="expanded"
      aria-controls="public-group-list"
      @click="expanded = !expanded"
    >
      <span>{{ t('publicGroups.notJoined') }}</span>
      <span class="public-group-discovery__count">{{ items.length }}</span>
      <ChevronDown
        :size="18"
        aria-hidden="true"
        :class="{ 'public-group-discovery__chevron--expanded': expanded }"
      />
    </button>
    <div v-show="expanded" id="public-group-list" class="public-group-discovery__list">
      <button
        v-for="item in items"
        :key="item.key"
        type="button"
        class="public-group-discovery__item"
        @click="emit('select', item)"
      >
        <UiAvatar :src="item.avatarUrl" :fallback="item.fallback?.[0] || t('publicGroups.fallback')" size="sm" />
        <span class="public-group-discovery__identity">
          <strong>{{ item.title }}</strong>
          <small>{{ item.subtitle }}</small>
        </span>
      </button>
    </div>
  </section>
</template>

<style scoped>
.public-group-discovery {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  max-height: min(42%, 320px);
  border-top: 1px solid var(--chat-line);
  background: var(--chat-paper);
}

.public-group-discovery__toggle {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 44px;
  padding: 12px 24px;
  border: 0;
  background: var(--chat-paper);
  color: var(--chat-muted);
  font-size: 13px;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
}

.public-group-discovery__toggle:hover {
  background: var(--chat-hover);
}

.public-group-discovery__count {
  min-width: 20px;
  color: var(--chat-subtle);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  text-align: center;
}

.public-group-discovery__toggle svg {
  transition: transform 150ms ease;
}

.public-group-discovery__chevron--expanded {
  transform: rotate(180deg);
}

.public-group-discovery__list {
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 4px 0 8px;
}

.public-group-discovery__item {
  display: flex;
  align-items: center;
  gap: 12px;
  width: calc(100% - 16px);
  min-height: 72px;
  margin: 2px 8px;
  padding: 9px 16px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--chat-ink);
  text-align: left;
  cursor: pointer;
  touch-action: manipulation;
  transition: background 150ms;
}

.public-group-discovery__item:hover {
  background: var(--chat-hover);
}

.public-group-discovery__identity {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.public-group-discovery__identity strong,
.public-group-discovery__identity small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.public-group-discovery__identity strong {
  font-size: 15px;
  font-weight: 500;
}

.public-group-discovery__identity small {
  color: var(--chat-muted);
  font-size: 13px;
}

.public-group-discovery button:focus-visible {
  outline: 2px solid var(--chat-accent);
  outline-offset: -2px;
}

@media (max-width: 960px) {
  .public-group-discovery {
    max-height: 46%;
    padding-bottom: env(safe-area-inset-bottom);
  }

  .public-group-discovery__toggle {
    min-height: 48px;
    padding-right: max(16px, env(safe-area-inset-right));
    padding-left: max(16px, env(safe-area-inset-left));
  }

  .public-group-discovery__item {
    width: 100%;
    min-height: 68px;
    margin: 0;
    padding: 11px max(16px, env(safe-area-inset-right)) 11px max(16px, env(safe-area-inset-left));
    border-radius: 0;
  }

  .public-group-discovery__item + .public-group-discovery__item {
    border-top: 1px solid var(--chat-hover);
  }
}

@media (prefers-reduced-motion: reduce) {
  .public-group-discovery__toggle svg,
  .public-group-discovery__item {
    transition: none;
  }
}
</style>
