<script setup>
import { Ban, Copy, Ellipsis } from '@lucide/vue';
import { computed, onMounted, reactive, ref } from 'vue';
import api from '../../api.js';
import UiButton from '../ui/Button.vue';
import UiSurface from '../ui/Surface.vue';
import { formatDate, formatDateTime, t } from '../../i18n.js';
import { can } from '../../authorization.ts';

const loading = ref(false);
const error = ref('');
const inviteSubmitting = ref(false);
const invites = ref([]);
const copiedInviteId = ref(0);
const inviteForm = reactive({
  note: '',
  maxUses: 1
});

const inviteMaxUsesValid = computed(
  () => Number.isInteger(inviteForm.maxUses) && inviteForm.maxUses >= 1 && inviteForm.maxUses <= 1000
);

function inviteLinkUrl(token) {
  return new URL(`/register/${token}`, window.location.origin).toString();
}

function inviteStatusLabel(invite) {
  if (invite.isAvailable) {
    return t('invites.status.available');
  }
  return invite.deletedAt ? t('invites.status.disabled') : t('invites.status.exhausted');
}

function inviteStatusClass(invite) {
  if (invite.isAvailable) {
    return 'admin-invite-card__status--available';
  }
  return invite.deletedAt
    ? 'admin-invite-card__status--disabled'
    : 'admin-invite-card__status--exhausted';
}

function formatInviteDate(value) {
  return formatDate(value, { month: 'short', day: 'numeric' });
}

async function loadInvites() {
  loading.value = true;
  error.value = '';
  try {
    const payload = await api.listAdminRegisterLinks();
    invites.value = payload.invites || [];
  } catch (currentError) {
    error.value = currentError.message;
  } finally {
    loading.value = false;
  }
}

async function createInvite() {
  inviteSubmitting.value = true;
  error.value = '';
  try {
    const payload = await api.createAdminRegisterLink(inviteForm);
    invites.value = [payload.invite, ...invites.value];
    inviteForm.note = '';
    inviteForm.maxUses = 1;
  } catch (currentError) {
    error.value = currentError.message;
  } finally {
    inviteSubmitting.value = false;
  }
}

async function copyInvite(invite) {
  try {
    await navigator.clipboard.writeText(inviteLinkUrl(invite.token));
    copiedInviteId.value = invite.id;
    window.setTimeout(() => {
      if (copiedInviteId.value === invite.id) {
        copiedInviteId.value = 0;
      }
    }, 1600);
  } catch {
    error.value = t('invites.copyFailed');
  }
}

async function revokeInvite(invite, event) {
  event?.currentTarget.closest('details')?.removeAttribute('open');
  if (!window.confirm(t('invites.confirmRevoke'))) {
    return;
  }

  try {
    await api.revokeAdminRegisterLink(invite.id);
    invites.value = invites.value.filter((item) => item.id !== invite.id);
  } catch (currentError) {
    error.value = currentError.message;
  }
}

onMounted(loadInvites);
</script>

<template>
  <UiSurface class="registration-invite-manager">
    <header class="registration-invite-manager__heading">
      <h3>{{ t('invites.title') }}</h3>
    </header>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>

    <form v-if="can('invites.create')" class="invite-create-form" @submit.prevent="createInvite">
      <label class="field invite-create-form__note">
        <span>{{ t('invites.noteLabel') }}</span>
        <input v-model.trim="inviteForm.note" :placeholder="t('invites.notePlaceholder')" />
      </label>
      <label class="field invite-create-form__uses">
        <span>{{ t('invites.maxUses') }}</span>
        <input
          v-model.number="inviteForm.maxUses"
          type="number"
          min="1"
          max="1000"
          step="1"
          :aria-label="t('invites.maxUses')"
        />
      </label>
      <UiButton type="submit" :disabled="inviteSubmitting || !inviteMaxUsesValid">
        {{ inviteSubmitting ? t('common.creating') : t('common.create') }}
      </UiButton>
    </form>

    <header v-if="!loading" class="invite-list-heading">
      <h3>{{ t('invites.createdCount', { count: invites.length }) }}</h3>
    </header>
    <p v-if="loading" class="muted" role="status">{{ t('invites.loading') }}</p>

    <div class="invite-list" :aria-busy="loading">
      <div v-if="!loading && !invites.length" class="muted">{{ t('invites.empty') }}</div>
      <article
        v-for="invite in invites"
        :key="invite.id"
        class="admin-invite-card"
      >
        <div class="admin-invite-card__identity">
          <div class="admin-invite-card__head">
            <strong>{{ invite.note || t('invites.unnamed') }}</strong>
            <span class="admin-invite-card__status" :class="inviteStatusClass(invite)">
              {{ inviteStatusLabel(invite) }}
            </span>
          </div>
          <div v-if="invite.token" class="admin-invite-card__url" :title="inviteLinkUrl(invite.token)">{{ inviteLinkUrl(invite.token) }}</div>
          <div class="admin-invite-card__provenance">
            <span>{{ invite.creatorDisplayName }}</span>
            <span aria-hidden="true">·</span>
            <time
              :datetime="invite.createdAt"
              :title="formatDateTime(invite.createdAt)"
            >
              {{ formatInviteDate(invite.createdAt) }}
            </time>
          </div>
        </div>
        <div class="admin-invite-card__details">
          <p class="admin-invite-card__usage">
            {{ t('invites.usage', { used: invite.usedCount, max: invite.maxUses }) }}
            <span class="admin-invite-card__remaining">{{ t('invites.remaining', { count: invite.remainingUses }) }}</span>
          </p>
          <p v-if="invite.consumerDisplayName" class="admin-invite-card__consumer">
            {{ t('invites.lastUsedBy', { name: invite.consumerDisplayName }) }}
          </p>
        </div>
        <div class="admin-invite-card__actions">
          <UiButton
            v-if="invite.token"
            variant="secondary"
            size="sm"
            aria-live="polite"
            :title="copiedInviteId === invite.id ? t('invites.linkCopiedTitle') : t('invites.copyLinkTitle')"
            @click="copyInvite(invite)"
          >
            <Copy :size="15" aria-hidden="true" />
            {{ copiedInviteId === invite.id ? t('invites.copied') : t('invites.copy') }}
          </UiButton>
          <details v-if="invite.isAvailable && can('invites.revoke')" class="admin-invite-menu">
            <summary class="admin-invite-menu__trigger" :title="t('common.moreActions')" :aria-label="t('common.moreActions')">
              <Ellipsis :size="18" aria-hidden="true" />
            </summary>
            <div class="admin-invite-menu__popover">
              <button type="button" @click="revokeInvite(invite, $event)">
                <Ban :size="15" aria-hidden="true" />
                {{ t('invites.revoke') }}
              </button>
            </div>
          </details>
        </div>
      </article>
    </div>
  </UiSurface>
</template>

<style scoped src="../../styles/admin/invite-manager.css"></style>
