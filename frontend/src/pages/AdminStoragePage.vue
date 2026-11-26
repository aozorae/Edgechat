<script setup>
import { ArrowDown, ArrowUp, ChevronsUpDown, RefreshCw } from '@lucide/vue';
import { computed, onMounted, ref } from 'vue';
import api from '../api.js';
import UiButton from '../components/ui/Button.vue';
import UiSurface from '../components/ui/Surface.vue';
import { t } from '../i18n.js';
import { can } from '../authorization.ts';
import store from '../store.js';
import {
  buildStorageRows,
  formatByteSize,
  formatStorageDateTime,
  mergeStorageSummary,
  sortStorageRows
} from '../storage-statistics.js';

const loading = ref(false);
const error = ref('');
const hasResult = ref(false);
const users = ref([]);
const summaries = ref(new Map());
const refreshedAt = ref(null);
const sort = ref({ key: 'bytes', direction: 'desc' });
const limits = ref(null);
const limitMiB = ref(20);
const saving = ref(false);
async function saveLimit() {
  saving.value = true;
  error.value = '';
  try {
    limits.value = (await api.saveUploadLimit(limitMiB.value * 1048576)).limits;
    limitMiB.value = limits.value.bytes / 1048576;
  } catch (e) { error.value = e.message; }
  finally { saving.value = false; }
}

const rows = computed(() => buildStorageRows(users.value, summaries.value));
const sortedRows = computed(() => sortStorageRows(rows.value, sort.value));
const totalBytes = computed(() => rows.value.reduce((total, row) => total + row.bytes, 0));
const totalObjects = computed(() => rows.value.reduce((total, row) => total + row.objectCount, 0));
const occupiedUsers = computed(
  () => rows.value.filter((row) => row.ownerKey.startsWith('user:') && row.bytes > 0).length
);

const columns = computed(() => [
  { key: 'objectCount', label: t('storage.columns.fileCount') },
  { key: 'bytes', label: t('storage.columns.bytes') },
  { key: 'share', label: t('storage.columns.share') },
  { key: 'latestUploadedAt', label: t('storage.columns.latestUpload') }
]);

async function refreshStorage() {
  loading.value = true;
  error.value = '';
  const nextSummaries = new Map();
  const seenCursors = new Set();
  let cursor = '';
  let nextUsers = [];

  try {
    do {
      const payload = await api.adminStorageScan(cursor);
      if (!cursor) {
        nextUsers = payload.users || [];
      }
      mergeStorageSummary(nextSummaries, payload.items);

      if (!payload.truncated) {
        cursor = '';
        break;
      }
      if (!payload.cursor || seenCursors.has(payload.cursor)) {
        throw new Error(t('storage.errors.invalidCursor'));
      }
      seenCursors.add(payload.cursor);
      cursor = payload.cursor;
    } while (cursor);

    users.value = nextUsers;
    summaries.value = nextSummaries;
    refreshedAt.value = new Date();
    hasResult.value = true;
  } catch (currentError) {
    error.value = currentError.message;
  } finally {
    loading.value = false;
  }
}

function changeSort(key) {
  sort.value = {
    key,
    direction: sort.value.key === key && sort.value.direction === 'desc' ? 'asc' : 'desc'
  };
}

function sortIcon(key) {
  if (sort.value.key !== key) return ChevronsUpDown;
  return sort.value.direction === 'asc' ? ArrowUp : ArrowDown;
}

function ariaSort(key) {
  if (sort.value.key !== key) return 'none';
  return sort.value.direction === 'asc' ? 'ascending' : 'descending';
}

function formatShare(value) {
  return `${(Number(value || 0) * 100).toFixed(value > 0 && value < 0.001 ? 2 : 1)}%`;
}
onMounted(async () => {
  try {
    const payload = await api.adminStorage();
    limits.value = payload.limits;
    if (limits.value) limitMiB.value = limits.value.bytes / 1048576;
    users.value = payload.users; mergeStorageSummary(summaries.value, payload.items);
    refreshedAt.value = payload.scannedAt; hasResult.value = Boolean(payload.scannedAt);
  } catch (e) { error.value = e.message; }
});
</script>

<template>
  <div class="admin-section admin-storage-page">
    <header class="admin-section__header">
      <div class="admin-section__heading">
        <h2>{{ t('storage.title') }}</h2>
        <p>{{ t('storage.description') }}</p>
      </div>
      <UiButton v-if="can('storage.scan')" variant="secondary" :disabled="loading" @click="refreshStorage">
        <RefreshCw :size="17" aria-hidden="true" :class="{ 'admin-spin': loading }" />
        {{ loading ? t('common.refreshing') : t('common.refresh') }}
      </UiButton>
    </header>

    <div class="admin-section__body">
      <p v-if="error" class="error-text">{{ error }}</p>
      <form v-if="limits && store.session?.isSuperAdmin" class="panel" @submit.prevent="saveLimit">
        <label for="attachment-limit">{{ t('storage.uploadLimit') }}</label>
        <input id="attachment-limit" v-model.number="limitMiB" type="number" required min="1" :max="Math.floor(limits.maximum / 1048576)" step="1">
        <UiButton type="submit" :disabled="saving || limitMiB * 1048576 === limits.bytes">{{ t('common.save') }}</UiButton>
        <p class="muted">{{ t('storage.uploadMaximum', { max: Math.floor(limits.maximum / 1048576) }) }}</p>
      </form>

      <template v-if="hasResult">
        <section class="admin-metric-grid" :aria-label="t('storage.summary')">
          <UiSurface class="admin-metric-card">
            <span>{{ t('storage.totalUsed') }}</span>
            <strong>{{ formatByteSize(totalBytes) }}</strong>
          </UiSurface>
          <UiSurface class="admin-metric-card">
            <span>{{ t('storage.totalFiles') }}</span>
            <strong>{{ totalObjects }}</strong>
          </UiSurface>
          <UiSurface class="admin-metric-card">
            <span>{{ t('storage.usersWithUsage') }}</span>
            <strong>{{ occupiedUsers }}</strong>
          </UiSurface>
          <UiSurface class="admin-metric-card">
            <span>{{ t('storage.lastRefreshed') }}</span>
            <strong class="admin-storage-page__refresh-time">
              {{ formatStorageDateTime(refreshedAt) }}
            </strong>
          </UiSurface>
        </section>

        <UiSurface class="panel panel--table">
          <h3 class="panel-title">{{ t('storage.byUser') }}</h3>
          <div class="admin-table-wrap">
            <table class="list-table admin-storage-table">
              <thead>
                <tr>
                  <th>{{ t('storage.user') }}</th>
                  <th v-for="column in columns" :key="column.key" :aria-sort="ariaSort(column.key)">
                    <button type="button" class="admin-sort-button" @click="changeSort(column.key)">
                      {{ column.label }}
                      <component :is="sortIcon(column.key)" :size="15" aria-hidden="true" />
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in sortedRows" :key="row.ownerKey">
                  <td>
                    <strong>{{ row.displayName }}</strong>
                    <div v-if="row.username" class="muted">
                      @{{ row.username }}<span v-if="row.isDeleted"> · {{ t('common.deleted') }}</span>
                    </div>
                  </td>
                  <td>{{ row.objectCount }}</td>
                  <td>{{ formatByteSize(row.bytes) }}</td>
                  <td>{{ formatShare(row.share) }}</td>
                  <td>{{ formatStorageDateTime(row.latestUploadedAt) || '-' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </UiSurface>
      </template>
    </div>
  </div>
</template>
