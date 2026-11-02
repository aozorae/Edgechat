<script setup lang="ts">
import { useI18n } from '../../i18n.js';
import { lowEffectsPreference, setLowEffectsPreference, systemLowEffects } from '../../visual-effects.ts';

const { t } = useI18n();

function onChange(event: Event) {
  setLowEffectsPreference((event.target as HTMLInputElement).checked);
}
</script>

<template>
  <section>
    <h2>{{ t('settings.effectsTitle') }}</h2>
    <label class="effects-toggle">
      <input
        type="checkbox"
        :checked="lowEffectsPreference"
        aria-describedby="effects-description"
        @change="onChange"
      />
      <span>{{ t('settings.lowEffects') }}</span>
    </label>
    <p id="effects-description" class="effects-description">{{ t('settings.lowEffectsHint') }}</p>
    <p v-if="systemLowEffects" class="effects-description" role="status">{{ t('settings.systemLowEffects') }}</p>
  </section>
</template>

<style scoped>
h2 {
  margin: 0;
  padding-bottom: 10px;
  border-bottom: 1px solid rgba(var(--site-brand-rgb, 91, 141, 191), 0.08);
  color: var(--auth-ink, #2c4a6e);
  font-size: 14px;
  font-weight: 700;
}

.effects-toggle {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 44px;
  cursor: pointer;
}

.effects-toggle input {
  width: 18px;
  height: 18px;
  accent-color: var(--site-brand, #2d9c97);
}

.effects-description {
  margin: 0;
  color: var(--auth-muted, #6b7c93);
  font-size: 13px;
  line-height: 1.6;
}
</style>
