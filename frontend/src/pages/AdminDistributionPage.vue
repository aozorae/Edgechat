<script setup>
import { computed, onMounted, ref } from 'vue';
import { t } from '../i18n.js';
import api from '../api.js';

const loading = ref(true);
const error = ref('');
const saving = ref(false);
const savedHint = ref('');
const config = ref({ gateEnabled: true, treeVisible: true });
const tree = ref([]);
const query = ref('');

const filteredTree = computed(() => {
  const keyword = query.value.trim().toLowerCase();
  if (!keyword) return tree.value;
  return tree.value
    .map((root) => {
      const rootHit = [root.username, root.displayName].some((value) =>
        String(value || '').toLowerCase().includes(keyword)
      );
      const children = root.children.filter((child) =>
        [child.username, child.displayName].some((value) =>
          String(value || '').toLowerCase().includes(keyword)
        )
      );
      return rootHit ? root : children.length ? { ...root, children } : null;
    })
    .filter(Boolean);
});

const totalInvitees = computed(() =>
  tree.value.reduce((sum, root) => sum + (root.children?.length || 0), 0)
);

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [configResult, treeResult] = await Promise.all([
      api.getAdminDistributionConfig(),
      api.getAdminDistributionTree()
    ]);
    if (configResult) {
      config.value = {
        gateEnabled: configResult.gateEnabled !== false,
        treeVisible: configResult.treeVisible !== false
      };
    }
    tree.value = treeResult?.roots || [];
  } catch (exception) {
    error.value = exception?.message || t('distribution.loadFailed');
  } finally {
    loading.value = false;
  }
}

async function saveSwitches() {
  saving.value = true;
  savedHint.value = '';
  try {
    const result = await api.updateAdminDistributionConfig({
      gateEnabled: config.value.gateEnabled,
      treeVisible: config.value.treeVisible
    });
    if (result) {
      config.value = {
        gateEnabled: result.gateEnabled !== false,
        treeVisible: result.treeVisible !== false
      };
    }
    savedHint.value = t('distribution.saved');
  } catch (exception) {
    error.value = exception?.message || t('distribution.saveFailed');
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="admin-section admin-distribution-page">
    <p class="admin-distribution-page__intro">{{ t('distribution.description') }}</p>

    <section class="admin-distribution-page__card">
      <h2 class="admin-distribution-page__title">{{ t('distribution.switches') }}</h2>
      <label class="admin-distribution-page__switch">
        <input v-model="config.gateEnabled" type="checkbox" />
        <span>
          <strong>{{ t('distribution.gateEnabled') }}</strong>
          <small>{{ t('distribution.gateEnabledHint') }}</small>
        </span>
      </label>
      <label class="admin-distribution-page__switch">
        <input v-model="config.treeVisible" type="checkbox" />
        <span>
          <strong>{{ t('distribution.treeVisible') }}</strong>
          <small>{{ t('distribution.treeVisibleHint') }}</small>
        </span>
      </label>
      <div class="admin-distribution-page__actions">
        <button type="button" :disabled="saving" @click="saveSwitches">
          {{ saving ? t('distribution.saving') : t('distribution.save') }}
        </button>
        <span v-if="savedHint" class="admin-distribution-page__saved">{{ savedHint }}</span>
      </div>
    </section>

    <section class="admin-distribution-page__card">
      <div class="admin-distribution-page__tree-header">
        <div>
          <h2 class="admin-distribution-page__title">{{ t('distribution.tree') }}</h2>
          <p class="admin-distribution-page__hint">{{ t('distribution.treeDescription') }}</p>
        </div>
        <input v-model="query" type="search" :placeholder="t('distribution.search')" />
      </div>

      <p v-if="loading" class="admin-distribution-page__hint">{{ t('distribution.loading') }}</p>
      <p v-else-if="error" class="admin-distribution-page__error">{{ error }}</p>
      <p v-else-if="!filteredTree.length" class="admin-distribution-page__hint">
        {{ t('distribution.empty') }}
      </p>

      <div v-else class="admin-distribution-page__tree">
        <article v-for="root in filteredTree" :key="root.userId" class="admin-distribution-root">
          <header class="admin-distribution-root__header">
            <span class="admin-distribution-root__name">
              {{ root.displayName || root.username }}
              <small>@{{ root.username }}</small>
            </span>
            <span class="admin-distribution-root__count">
              {{ t('distribution.inviteeCount', { count: root.children?.length || 0 }) }}
            </span>
          </header>
          <ul class="admin-distribution-root__children">
            <li v-for="child in root.children" :key="child.userId">
              <span>
                {{ child.displayName || child.username }}
                <small>@{{ child.username }}</small>
              </span>
              <time>{{ child.invitedAt || '-' }}</time>
            </li>
          </ul>
        </article>
      </div>
      <p class="admin-distribution-page__hint">
        {{ t('distribution.total', { count: totalInvitees }) }}
      </p>
    </section>
  </div>
</template>

<style scoped>
.admin-distribution-page__intro {
  margin: 0 0 16px;
  color: var(--admin-muted, #6b7280);
}

.admin-distribution-page__card {
  background: var(--admin-surface, #fff);
  border: 1px solid var(--admin-border, #e5e7eb);
  border-radius: 12px;
  padding: 16px;
  margin-bottom: 16px;
}

.admin-distribution-page__title {
  font-size: 16px;
  margin: 0 0 12px;
}

.admin-distribution-page__switch {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 10px 0;
  border-bottom: 1px dashed var(--admin-border, #e5e7eb);
}

.admin-distribution-page__switch small {
  display: block;
  color: var(--admin-muted, #6b7280);
  margin-top: 2px;
}

.admin-distribution-page__actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 12px;
}

.admin-distribution-page__actions button {
  padding: 8px 16px;
  border-radius: 8px;
  border: none;
  background: var(--admin-accent, #2563eb);
  color: #fff;
  cursor: pointer;
}

.admin-distribution-page__actions button:disabled {
  opacity: 0.6;
  cursor: default;
}

.admin-distribution-page__saved {
  color: #16a34a;
  font-size: 13px;
}

.admin-distribution-page__tree-header {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
  flex-wrap: wrap;
}

.admin-distribution-page__tree-header input {
  padding: 8px 12px;
  border: 1px solid var(--admin-border, #e5e7eb);
  border-radius: 8px;
  min-width: 200px;
}

.admin-distribution-page__hint {
  color: var(--admin-muted, #6b7280);
  font-size: 13px;
}

.admin-distribution-page__error {
  color: #dc2626;
  font-size: 13px;
}

.admin-distribution-root {
  border: 1px solid var(--admin-border, #e5e7eb);
  border-radius: 10px;
  padding: 12px;
  margin-bottom: 12px;
}

.admin-distribution-root__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.admin-distribution-root__name small,
.admin-distribution-root__children small {
  color: var(--admin-muted, #6b7280);
  margin-left: 6px;
}

.admin-distribution-root__count {
  font-size: 13px;
  color: var(--admin-muted, #6b7280);
}

.admin-distribution-root__children {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
}

.admin-distribution-root__children li {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 0;
  border-top: 1px solid var(--admin-border, #f3f4f6);
  font-size: 14px;
}

.admin-distribution-root__children time {
  color: var(--admin-muted, #6b7280);
  font-size: 12px;
}
</style>
