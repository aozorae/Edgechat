<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import api from '../../api.js';
import UiButton from '../ui/Button.vue';
import UiSurface from '../ui/Surface.vue';
import { t } from '../../i18n.js';
import store from '../../store.js';
import UserGroupSelect from './UserGroupSelect.vue';
import { useUserGroupOptions } from '../../composables/useUserGroupOptions.ts';

const emit = defineEmits(['created']);
const submitting = ref(false);
const error = ref('');
const success = ref('');
const form = reactive({ username: '', displayName: '', password: '' });
const roleId = ref(1);
const { roles, hasMore, loading: rolesLoading, error: rolesError, loadMore } = useUserGroupOptions();
onMounted(async () => {
  if (!store.session?.isSuperAdmin) return;
  await loadMore();
});

const canSubmit = computed(() => Boolean(form.username && form.displayName && form.password));

async function submitUser() {
  submitting.value = true;
  error.value = '';
  success.value = '';
  try {
    const payload = await api.createUser({ ...form, ...(store.session?.isSuperAdmin ? { roleId: roleId.value } : {}) });
    form.username = '';
    form.displayName = '';
    form.password = '';
    success.value = t('userCreator.created');
    emit('created', payload.user);
  } catch (currentError) {
    error.value = currentError.message;
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <UiSurface class="admin-user-creator">
    <h3 class="panel-title">{{ t('userCreator.title') }}</h3>
    <p v-if="error || rolesError" class="error-text" role="alert">{{ error || rolesError }}</p>
    <p v-else-if="success" class="success-text" role="status">{{ success }}</p>
    <form class="admin-user-creator__form" :class="{ 'admin-user-creator__form--with-group': store.session?.isSuperAdmin }" @submit.prevent="submitUser">
      <label class="field">
        <span>{{ t('auth.username') }}</span>
        <input v-model.trim="form.username" autocomplete="off" />
      </label>
      <label class="field">
        <span>{{ t('auth.displayName') }}</span>
        <input v-model.trim="form.displayName" autocomplete="off" />
      </label>
      <label class="field">
        <span>{{ t('userCreator.initialPassword') }}</span>
        <input v-model="form.password" type="password" autocomplete="new-password" />
      </label>
      <div v-if="store.session?.isSuperAdmin" class="field admin-user-creator__group">
        <span>{{ t('rbac.group') }}</span>
        <UserGroupSelect v-model="roleId" :roles="roles" :has-more="hasMore" :loading="rolesLoading" @more="loadMore" />
      </div>
      <UiButton type="submit" :disabled="submitting || !canSubmit">
        {{ submitting ? t('common.creating') : t('userCreator.title') }}
      </UiButton>
    </form>
  </UiSurface>
</template>

<style src="../../styles/admin/user-creator.css"></style>
