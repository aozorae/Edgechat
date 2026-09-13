<script setup>
import { ArrowLeft, Ban, Bell, BellOff, ContactRound, Menu, MessageCircle, Settings, UsersRound } from '@lucide/vue';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  consumeNativeRoomTarget,
  NATIVE_ROOM_OPEN_EVENT
} from '../capacitor-platform.ts';
import { isDemoMode } from '../runtime.js';
import AddConversationDialog from '../components/chat/AddConversationDialog.vue';
import ConversationList from '../components/chat/ConversationList.vue';
import CreateGroupDialog from '../components/chat/CreateGroupDialog.vue';
import GroupSettingsDialog from '../components/chat/GroupSettingsDialog.vue';
import InAppNotificationStack from '../components/chat/InAppNotificationStack.vue';
import MemberPanel from '../components/chat/MemberPanel.vue';
import MessageAttachment from '../components/chat/MessageAttachment.vue';
import MessageComposer from '../components/chat/MessageComposer.vue';
import MessageMarkdown from '../components/chat/MessageMarkdown.vue';
import MessageContextMenu from '../components/chat/MessageContextMenu.vue';
import MessageReplyPreview from '../components/chat/MessageReplyPreview.vue';
import PinnedMessageBar from '../components/chat/PinnedMessageBar.vue';
import MobileNavigationDrawer from '../components/chat/MobileNavigationDrawer.vue';
import SenderSourceBadge from '../components/chat/SenderSourceBadge.vue';
import PublicGroupDiscovery from '../components/chat/PublicGroupDiscovery.vue';
import PublicGroupJoinDialog from '../components/chat/PublicGroupJoinDialog.vue';
import UiAvatar from '../components/ui/Avatar.vue';
import LanguageSwitch from '../components/ui/LanguageSwitch.vue';
import { useActiveRoom } from '../composables/useActiveRoom.js';
import { useBrowserNotifications } from '../composables/useBrowserNotifications.js';
import { useChatRoom } from '../composables/useChatRoom.js';
import { useChatSidebar } from '../composables/useChatSidebar.js';
import { useChatViewport } from '../composables/useChatViewport.js';
import { useConversationFlow } from '../composables/useConversationFlow.ts';
import { useConversationCreation } from '../composables/useConversationCreation.js';
import { useInAppNotifications } from '../composables/useInAppNotifications.ts';
import { useMessageContextMenu } from '../composables/useMessageContextMenu.ts';
import { useRoomManagement } from '../composables/useRoomManagement.js';
import { useUnreadInbox } from '../composables/useUnreadInbox.js';
import { useUserBlock } from '../composables/useUserBlock.ts';
import { resolveMentionUserIds } from '../mentions.ts';
import store from '../store.js';
import api from '../api.js';
import UserProfileDialog from '../components/chat/UserProfileDialog.vue';
import ContactsPage from './ContactsPage.vue';
import { useUserProfile } from '../composables/useUserProfile.ts';
import { useI18n } from '../i18n.js';

const router = useRouter();
const route = useRoute();
const { formatTime: formatLocaleTime, t } = useI18n();
const error = ref('');
const activeRoom = ref(null);
const replyingTo = ref(null);
const messageComposer = ref(null);
const showMobileNavigation = ref(false);
const publicGroupPreview = ref(null);
const joiningPublicGroup = ref(false);
const session = computed(() => store.session);
const showAdminEntry = computed(() => Boolean(session.value?.isAdmin));
const isContactsView = computed(() => route.name === 'contacts');
const contactsVisited = ref(isContactsView.value);
const inboxActiveRoom = computed(() => isContactsView.value ? null : activeRoom.value);

const { activeRoomKey, canManageActiveRoom, applyActiveChannel, selectDm, roomLabel, roomSubtitle } =
  useActiveRoom({ activeRoom });
const {
  isMobileViewport,
  mobileView,
  startViewportSync,
  stopViewportSync,
  openConversationView,
  returnToConversationList
} = useChatViewport({ activeRoom });
const activeRoomAvatar = computed(() => {
  if (!activeRoom.value) return '';
  return activeRoom.value.kind === 'dm'
    ? activeRoom.value.otherUser?.avatarUrl || ''
    : activeRoom.value.avatarUrl || '';
});

const {
  channels, dms, users, sidebarLoading, conversationItems, publicGroupItems,
  refreshSidebar, openConversation, joinPublicChannel, markConversationRead, applyConversationActivity
} = useChatSidebar({ applyActiveChannel, selectDm });
const { openConversationItem, openByIdentity, refreshAndOpen } = useConversationFlow({
  conversationItems,
  refreshSidebar,
  openConversation,
  openConversationView
});

const {
  notificationsEnabled,
  notificationStateLabel,
  notificationActionLabel,
  notificationToggleDisabled,
  syncNotificationPermission,
  toggleNotifications,
  isRoomMuted,
  toggleRoomMuted,
  shouldNotifyRoom,
  notifyRoom
} = useBrowserNotifications({
  userId: session.value?.userId,
  onOpenRoom: openRoomFromNotification
});
const activeRoomMuted = computed(() => isRoomMuted(activeRoom.value));
const {
  inAppNotifications,
  showInAppNotification,
  dismissInAppNotification,
  clearInAppNotifications
} = useInAppNotifications();

function notifyInAppRoom(event) {
  if (!shouldNotifyRoom(event)) return false;
  showInAppNotification(event);
  return true;
}

function openInAppNotification(notification) {
  dismissInAppNotification(notification.id);
  void openRoomFromNotification(notification.room);
}
const {
  isBlockedByMe: activeDmBlockedByMe,
  saving: userBlockSaving,
  toggleUserBlock
} = useUserBlock({ activeRoom, dms, error });

function handleRoomActivity({ room, message }) {
  applyConversationActivity({
    kind: room.kind,
    roomId: room.id,
	    lastMessageAt: message.createdAt,
	    unreadCount: 0,
	    mentionUnreadCount: 0
  });
  markConversationRead(room.kind, room.id);
}

function handleRoomAccessRevoked(room) {
  const roomName = room.name || t('chat.privateGroup');
  error.value = room.kind === 'private'
    ? t('chat.roomAccessRevokedNamed', { name: roomName })
    : t('chat.roomAccessRevoked');
  activeRoom.value = null;
  returnToConversationList();
  void refreshSidebar();
}

const {
  messages, pinnedMessage, highlightedMessageId, loading, wsStatus, composerText, pendingAttachment, sending,
  messagesEl, isOwnMessage,
	  loadMessages, activateRoom, deactivateRoom, pauseRoom, disconnectSocket, sendMessage, sendVoiceMessage, deleteMessage,
	  pinMessage, unpinMessage, revealPinnedMessage,
	  revealMessage,
  uploadAttachment, clearAttachment, loadOlder
} = useChatRoom({
  activeRoom,
  session,
  error,
  roomVisible: computed(() => !isContactsView.value),
  onRoomActivity: handleRoomActivity,
  onRoomAccessRevoked: handleRoomAccessRevoked
});

const { connectUnreadInbox, disconnectUnreadInbox } = useUnreadInbox({
  activeRoom: inboxActiveRoom,
  markConversationRead,
  applyConversationActivity,
  notifyInApp: notifyInAppRoom,
  notifySystem: notifyRoom
});

const wsConnected = computed(() => wsStatus.value === 'open');
const activeRoomSubtitle = computed(() => roomSubtitle(activeRoom.value, wsConnected.value));
const canModerateMessages = computed(
  () => Boolean(session.value?.isAdmin || canManageActiveRoom.value)
);
const canPinMessages = computed(
  () => Boolean(activeRoom.value?.kind !== 'dm' && (session.value?.isAdmin || canManageActiveRoom.value))
);
const {
  messageMenu,
  closeMessageMenu,
  cancelMessageLongPress,
  openMessageContextMenu,
  startMessageLongPress,
  trackMessageLongPress
} = useMessageContextMenu();
const selectedMessageIsPinned = computed(
  () => Number(messageMenu.value.message?.id) === Number(pinnedMessage.value?.id)
);

const roomManagement = useRoomManagement({
  activeRoom, channels, users, error, refreshSidebar, refreshAndOpen, canManageActiveRoom,
  returnToConversationList,
  onRoomDeleted: () => {
    disconnectSocket();
    messages.value = [];
    pinnedMessage.value = null;
  }
});
const { creation, members: memberManagement, settings: groupSettings, deleteGroup } = roomManagement;
const {
  show: showCreateGroup,
  form: createGroupForm,
  submitting: creatingGroup,
  open: openCreateGroup,
  close: closeCreateGroup,
  toggleMember: toggleCreateGroupMember,
  submit: createGroup
} = creation;
const {
  show: showAddConversation,
  usersWithoutDm,
  openingDmUserId,
  open: openAddConversation,
  close: closeAddConversation,
  startGroupCreation,
  openDm
} = useConversationCreation({
  users,
  dms,
  error,
  refreshAndOpen,
  openGroupDialog: openCreateGroup
});
const {
  show: showMemberPanel,
  items: groupMembers,
  loading: memberLoading,
  inviteUserId,
  availableUsers: availableInviteUsers,
  inviteSubmitting,
  toggle: toggleMemberPanel,
  close: closeMemberPanel,
  invite: inviteMember,
  remove: removeMember
} = memberManagement;
const mentionCandidates = computed(() =>
	activeRoom.value?.kind === 'dm'
		? []
		: groupMembers.value.filter((member) => Number(member.id) !== Number(session.value?.userId))
);
const profileTargetHeader = ref(null);
const {
  identity: profileIdentity, profile: userProfile, show: showUserProfile,
  loading: profileLoading, unavailable: profileUnavailable, error: profileError,
  submitting: profileSubmitting, restoreFocus: profileRestoreFocus, isSelf: profileIsSelf,
  openUserProfile, close: closeUserProfile, retry: retryUserProfile, sendMessage: sendProfileMessage
} = useUserProfile({
  currentUserId: computed(() => session.value?.userId),
  getProfile: api.getUserProfile,
  openDm,
  onNavigate: () => {
    closeMemberPanel();
    void router.push('/').then(() => nextTick(() => {
      messageComposer.value?.focus();
      // 被拉黑会话的输入区不可聚焦时，仍把焦点移到目标会话而非旧头像。
      if (!document.activeElement?.closest('.message-composer')) profileTargetHeader.value?.focus();
    }));
  }
});
function openLocalUserProfile(user) {
  if (user) openUserProfile({ ...user, kind: 'local' });
}
function openSenderProfile(sender) {
  closeMessageMenu();
  openUserProfile(sender.kind === 'external'
    ? { kind: 'external', source: sender.source, id: String(sender.id), displayName: sender.displayName, avatarUrl: sender.avatarUrl }
    : { ...sender, kind: 'local' });
}
function editProfile() {
  profileRestoreFocus.value = false;
  closeUserProfile();
  void router.push('/settings');
}
watch(() => session.value?.userId, closeUserProfile);

async function sendComposerMessage() {
	const sent = await sendMessage(
		resolveMentionUserIds(composerText.value, mentionCandidates.value, session.value?.userId),
		replyingTo.value?.id,
	);
	if (sent) replyingTo.value = null;
	return sent;
}

async function sendComposerVoice(recording) {
	const sent = await sendVoiceMessage(recording, replyingTo.value?.id);
	if (sent) replyingTo.value = null;
	return sent;
}
const {
  show: showGroupEditor,
  form: groupSettingsForm,
  saving: groupSettingsSaving,
  avatarUploading: groupAvatarUploading,
  open: openGroupEditor,
  close: closeGroupEditor,
  uploadAvatar: uploadGroupAvatar,
  save: saveGroupSettings
} = groupSettings;

async function selectConversation(item) {
  try {
    await openConversationItem(item);
  } catch (currentError) {
    error.value = currentError.message;
  }
}

function openPublicGroupPreview(item) {
  publicGroupPreview.value = item.source;
}

function closePublicGroupPreview() {
  if (!joiningPublicGroup.value) publicGroupPreview.value = null;
}

async function confirmPublicGroupJoin() {
  const channel = publicGroupPreview.value;
  if (!channel) return;

  joiningPublicGroup.value = true;
  error.value = '';
  try {
    await joinPublicChannel(channel);
    publicGroupPreview.value = null;
    await openByIdentity(channel);
  } catch (currentError) {
    error.value = currentError.message;
  } finally {
    joiningPublicGroup.value = false;
  }
}

async function openRoomFromNotification(room) {
  try {
    await openByIdentity(room);
    await router.push('/');
  } catch (currentError) {
    error.value = currentError.message;
  }
}

function toggleActiveRoomMute() {
  if (activeRoom.value) toggleRoomMuted(activeRoom.value);
}

function logout() { store.logout(); router.push('/login'); }
function openAdmin() { router.push('/admin'); }
function openSettings() { router.push('/settings'); }
function openChat() { router.push('/'); }
function openContacts() { router.push('/contacts'); }
let nativeRoomNavigationReady = false;
function openNativeRoom() {
  if (!nativeRoomNavigationReady) return;
  const target = consumeNativeRoomTarget();
  if (target) void openRoomFromNotification(target);
}
function closeMobileNavigation() { showMobileNavigation.value = false; }
function navigateFromMobileDrawer(callback) {
  closeMobileNavigation();
  callback();
}
function returnToMobileConversationList() {
  closeMemberPanel();
  closeMessageMenu();
  replyingTo.value = null;
  returnToConversationList();
}

async function bootstrap() {
  error.value = '';
  try {
    await refreshSidebar();
    if (isDemoMode && !activeRoom.value) {
      const general = conversationItems.value.find((item) => item.isGeneral);
      if (general) await selectConversation(general);
    }
  }
  catch (e) { error.value = e.message; }
}

watch(activeRoomKey, async (k) => {
  closeMessageMenu();
  cancelMessageLongPress();
  replyingTo.value = null;
  if (!k) {
    deactivateRoom();
    return;
  }
	  if (isContactsView.value) {
	    pauseRoom();
	    return;
	  }
  openConversationView();
  const loaded = await activateRoom();
  if (!loaded || activeRoomKey.value !== k) return;
  for (const delay of [0, 50, 150, 300]) {
    await new Promise(r => setTimeout(r, delay));
    if (activeRoomKey.value !== k) return;
    if (messagesEl.value) {
      messagesEl.value.scrollTop = messagesEl.value.scrollHeight;
    }
  }
});

watch(isContactsView, async (showContacts, wasContacts) => {
  if (showContacts) {
    contactsVisited.value = true;
    closeMessageMenu();
	    cancelMessageLongPress();
	    closeMemberPanel();
	    pauseRoom();
	    return;
  }
  if (wasContacts && activeRoom.value) {
    openConversationView();
    await activateRoom();
  }
});

function confirmDeleteMessage() {
  const message = messageMenu.value.message;
  closeMessageMenu();
  if (!message || !window.confirm(t('chat.deleteMessageConfirm'))) {
    return;
  }
  deleteMessage(message.id);
}

function pinSelectedMessage() {
  const message = messageMenu.value.message;
  closeMessageMenu();
  if (message) pinMessage(message.id);
}

function unpinSelectedMessage() {
  const message = messageMenu.value.message;
  closeMessageMenu();
  if (message) unpinMessage(message.id);
}

function replyToSelectedMessage() {
	const message = messageMenu.value.message;
	closeMessageMenu();
	if (!message) return;
	replyingTo.value = message;
	nextTick(() => messageComposer.value?.focus());
}

async function copySelectedMessage() {
	const content = String(messageMenu.value.message?.content || '');
	closeMessageMenu();
	if (!content) return;
	try {
		await navigator.clipboard.writeText(content);
	} catch {
		error.value = t('messages.copyFailed');
	}
}

onMounted(() => {
  startViewportSync();
  window.addEventListener('focus', syncNotificationPermission);
  window.addEventListener(NATIVE_ROOM_OPEN_EVENT, openNativeRoom);
  void bootstrap().then(() => {
    nativeRoomNavigationReady = true;
    connectUnreadInbox();
    openNativeRoom();
  });
});
function formatBubbleTime(value) {
  return value ? formatLocaleTime(value) : '';
}

onBeforeUnmount(() => {
  closeUserProfile();
  cancelMessageLongPress();
  nativeRoomNavigationReady = false;
  window.removeEventListener('focus', syncNotificationPermission);
  window.removeEventListener(NATIVE_ROOM_OPEN_EVENT, openNativeRoom);
  clearInAppNotifications();
  disconnectUnreadInbox();
  disconnectSocket();
  stopViewportSync();
});
</script>

<template>
  <div
    class="chat-layout"
    :class="{
      'chat-layout--mobile': isMobileViewport,
      'chat-layout--mobile-list': isMobileViewport && mobileView === 'list',
      'chat-layout--mobile-chat': isMobileViewport && mobileView === 'chat',
      'chat-layout--contacts': isContactsView
    }"
  >
    <!-- 导航与会话列表保持独立，切换通讯录时不破坏现有聊天工作区。 -->
    <aside class="right-sidebar">
      <div class="right-sidebar-inner">
        <div class="right-sidebar-section right-sidebar-actions">
          <button
            type="button"
            class="right-sidebar-action right-sidebar-action--labeled tooltip"
            :class="{ 'right-sidebar-action--current': !isContactsView }"
            :data-tooltip="t('nav.chats')"
            :aria-label="t('nav.chats')"
            :aria-current="!isContactsView ? 'page' : undefined"
            @click="openChat"
          >
            <MessageCircle :size="20" aria-hidden="true" />
            <span class="right-sidebar-action__label">{{ t('nav.chats') }}</span>
          </button>
          <button
            type="button"
            class="right-sidebar-action right-sidebar-action--labeled tooltip"
            :class="{ 'right-sidebar-action--current': isContactsView }"
            :data-tooltip="t('contacts.title')"
            :aria-label="t('contacts.title')"
            :aria-current="isContactsView ? 'page' : undefined"
            @click="openContacts"
          >
            <ContactRound :size="20" aria-hidden="true" />
            <span class="right-sidebar-action__label">{{ t('contacts.title') }}</span>
          </button>
          <button
            type="button"
            class="right-sidebar-action right-sidebar-action--labeled tooltip"
            :class="{ 'right-sidebar-action--notification-active': notificationsEnabled }"
            :data-tooltip="notificationActionLabel"
            :aria-label="notificationActionLabel"
            :aria-pressed="notificationsEnabled"
            :disabled="notificationToggleDisabled"
            @click="toggleNotifications"
          >
            <Bell v-if="notificationsEnabled" :size="20" aria-hidden="true" />
            <BellOff v-else :size="20" aria-hidden="true" />
            <span class="right-sidebar-action__label">{{ notificationStateLabel }}</span>
          </button>
          <button
            v-if="showAdminEntry"
            type="button"
            class="right-sidebar-action right-sidebar-action--admin tooltip"
            :data-tooltip="t('nav.admin')"
            :aria-label="t('nav.admin')"
            @click="openAdmin"
          >
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8">
              <title>{{ t('nav.admin') }}</title>
              <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
              <rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>
            </svg>
            <span class="right-sidebar-action__label">{{ t('nav.admin') }}</span>
          </button>
        </div>

        <div class="right-sidebar-section right-sidebar-user-group">
          <button type="button" class="right-sidebar-user tooltip" :data-tooltip="t('nav.personalSettings')" :aria-label="t('nav.personalSettings')" @click="router.push('/settings')">
            <UiAvatar :src="session?.avatarUrl" :fallback="session?.displayName?.[0] || 'U'" size="sm" />
          </button>
          <button type="button" class="right-sidebar-action right-sidebar-action--danger tooltip" :data-tooltip="t('auth.signOut')" :aria-label="t('auth.signOut')" @click="logout">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8">
              <title>{{ t('auth.signOut') }}</title>
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
            </svg>
          </button>
        </div>
      </div>
    </aside>

	    <!-- 会话区保持固定视觉层级，让标题与列表在不同宽度下都有稳定位置。 -->
    <aside class="left-sidebar">
      <div class="sidebar-inner">
        <div class="sidebar-header">
          <button
            type="button"
            class="header-action mobile-menu-action"
            :aria-label="t('nav.openNavigation')"
            :aria-expanded="showMobileNavigation"
            @click="showMobileNavigation = true"
          >
            <Menu :size="22" aria-hidden="true" />
          </button>
          <h1 class="brand-title">EdgeChat</h1>
          <div class="sidebar-header-actions">
            <a
              class="header-action header-action--github"
              href="https://github.com/aozorae/Edgechat"
              target="_blank"
              rel="noopener noreferrer"
              :title="t('nav.githubRepository')"
              :aria-label="t('nav.openGithubRepository')"
            >
              <img src="/github.svg" alt="" width="20" height="20" />
              <span class="sr-only">{{ t('nav.openGithubRepository') }}</span>
            </a>
            <button
              type="button"
              class="header-action header-action--primary"
              :title="t('chat.addPeople')"
              :aria-label="t('chat.addPeople')"
              aria-haspopup="dialog"
              :aria-expanded="showAddConversation"
              @click="openAddConversation"
            >
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
                <title>{{ t('chat.addPeople') }}</title>
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
                <line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/>
              </svg>
            </button>
            <LanguageSwitch class="mobile-language-switch" />
          </div>
        </div>

        <div class="sidebar-list-heading">
          <h2>{{ t('nav.chats') }}</h2>
          <span>{{ conversationItems.length }}</span>
        </div>

		<ConversationList
		  :items="conversationItems"
		  :active-key="activeRoomKey"
		  :loading="sidebarLoading"
		  :is-room-muted="isRoomMuted"
		  @select="selectConversation"
		/>

		<PublicGroupDiscovery :items="publicGroupItems" @select="openPublicGroupPreview" />
      </div>
    </aside>

    <ContactsPage
      v-if="contactsVisited"
      v-show="isContactsView"
      @open-navigation="showMobileNavigation = true"
      @open-profile="openLocalUserProfile"
    />

    <!-- Right Main Chat Window -->
    <main v-if="!isContactsView" class="chat-main">
      <template v-if="activeRoom">
        <header class="chat-header">
          <button
            type="button"
            class="chat-header__back"
            :aria-label="t('chat.backToConversationList')"
            @click="returnToMobileConversationList"
          >
            <ArrowLeft :size="24" aria-hidden="true" />
          </button>
          <button
            v-if="activeRoom.kind === 'dm'"
            ref="profileTargetHeader"
            type="button"
            class="profile-avatar-trigger"
            :aria-label="t('profile.view', { name: roomLabel(activeRoom) })"
            @click="openLocalUserProfile(activeRoom.otherUser)"
          >
            <UiAvatar :src="activeRoomAvatar" :fallback="roomLabel(activeRoom)?.[0] || '?'" size="sm" />
          </button>
          <UiAvatar
            v-else
            class="chat-header__avatar"
            :src="activeRoomAvatar"
            :fallback="roomLabel(activeRoom)?.[0] || '?'"
            size="sm"
          />
          <div class="chat-header__identity">
            <h2>{{ roomLabel(activeRoom) }}</h2>
            <span>{{ activeRoomSubtitle }}</span>
          </div>
          <div class="chat-header__actions">
            <div
              class="chat-header__status"
              :class="wsConnected ? 'online' : 'offline'"
              :title="wsConnected ? t('chat.connected') : t('chat.connecting')"
              :aria-label="wsConnected ? t('chat.connected') : t('chat.connecting')"
              role="status"
            ></div>
            <button
              v-if="activeRoom.kind === 'dm'"
              type="button"
              class="chat-header__button chat-header__button--danger"
              :class="{ 'chat-header__button--blocked': activeDmBlockedByMe }"
              :title="activeDmBlockedByMe ? t('chat.unblockUser') : t('chat.blockUser')"
              :aria-label="activeDmBlockedByMe ? t('chat.unblockUser') : t('chat.blockUser')"
              :aria-pressed="activeDmBlockedByMe"
              :aria-busy="userBlockSaving"
              :disabled="userBlockSaving"
              @click="toggleUserBlock"
            >
              <Ban :size="19" aria-hidden="true" />
              <span>{{ activeDmBlockedByMe ? t('chat.unblock') : t('chat.block') }}</span>
            </button>
            <button
              type="button"
              class="chat-header__button"
              :class="{ 'chat-header__button--active': activeRoomMuted }"
              :title="activeRoomMuted ? t('chat.unmuteCurrent') : t('chat.muteCurrent')"
              :aria-label="activeRoomMuted ? t('chat.unmuteCurrent') : t('chat.muteCurrent')"
              :aria-pressed="activeRoomMuted"
              @click="toggleActiveRoomMute"
            >
              <BellOff v-if="activeRoomMuted" :size="19" aria-hidden="true" />
              <Bell v-else :size="19" aria-hidden="true" />
              <span>{{ activeRoomMuted ? t('chat.mutedShort') : t('chat.mute') }}</span>
            </button>
            <button
              v-if="activeRoom.kind !== 'dm'"
              type="button"
              class="chat-header__button"
              :aria-label="showMemberPanel ? t('chat.closeMembers') : t('chat.viewMembers')"
              :aria-expanded="showMemberPanel"
              :title="showMemberPanel ? t('chat.closeMembers') : t('chat.viewMembers')"
              @click="toggleMemberPanel"
            >
              <UsersRound :size="19" aria-hidden="true" />
              <span>{{ showMemberPanel ? t('chat.collapseMembers') : t('chat.members') }}</span>
            </button>
            <button
              v-if="canManageActiveRoom"
              type="button"
              class="chat-header__button"
              :aria-label="t('chat.openGroupSettings')"
              :title="t('chat.openGroupSettings')"
              @click="openGroupEditor"
            >
              <Settings :size="19" aria-hidden="true" />
              <span>{{ t('chat.groupSettings') }}</span>
            </button>
            <LanguageSwitch class="chat-header__language-switch" />
          </div>
        </header>

        <PinnedMessageBar
          v-if="pinnedMessage && activeRoom.kind !== 'dm'"
          :message="pinnedMessage"
          :can-unpin="canPinMessages"
          @reveal="revealPinnedMessage"
          @unpin="unpinMessage(pinnedMessage.id)"
        />

        <section ref="messagesEl" class="chat-messages">
          <button v-if="messages.length" type="button" class="load-more-btn" @click="loadOlder">{{ t('chat.loadEarlier') }}</button>
          <div v-if="loading" class="messages-hint">{{ t('chat.loadingMessages') }}</div>
          <div v-else-if="!messages.length" class="messages-hint">{{ t('chat.noMessages') }}</div>

          <article
            v-for="msg in messages" :key="msg.id"
            :data-message-id="msg.id"
            class="message-row"
			:class="{
			  'message-row--own': isOwnMessage(msg),
			  'message-row--actionable': true
			}"
          >
            <button
              v-if="!isOwnMessage(msg)"
              type="button"
              class="profile-avatar-trigger message-avatar-trigger"
              :aria-label="t('profile.view', { name: msg.sender.displayName })"
              @click="openSenderProfile(msg.sender)"
            >
              <UiAvatar class="message-avatar" :src="msg.sender.avatarUrl" :alt="msg.sender.displayName" :fallback="msg.sender.displayName" size="sm" />
            </button>
            <div
              class="message-bubble"
              :class="{
                'message-bubble--with-attachment': msg.attachment,
                'message-bubble--highlighted': Number(highlightedMessageId) === Number(msg.id)
              }"
              @contextmenu="openMessageContextMenu($event, msg)"
              @pointerdown="startMessageLongPress($event, msg)"
              @pointermove="trackMessageLongPress"
              @pointerup="cancelMessageLongPress"
              @pointercancel="cancelMessageLongPress"
            >
			  <div v-if="activeRoom.kind !== 'dm' && !isOwnMessage(msg)" class="message-sender-name">
                <span>{{ msg.sender.displayName }}</span>
                <SenderSourceBadge :source="msg.sender.source" />
			  </div>
			  <MessageReplyPreview
				v-if="msg.replyTo"
				class="message-bubble__reply"
				:reply="msg.replyTo"
				:clickable="!msg.replyTo.deleted"
				@reveal="revealMessage(msg.replyToMessageId)"
			  />
			  <MessageMarkdown
				v-if="msg.content"
				:content="msg.content"
				:mentions="msg.mentions"
				:current-user-id="session?.userId"
			  />
              <MessageAttachment v-if="msg.attachment" :attachment="msg.attachment" />
              <span class="message-time">{{ formatBubbleTime(msg.createdAt) }}</span>
            </div>
          </article>
        </section>

        <MessageContextMenu
          :open="Boolean(messageMenu.message)"
          :x="messageMenu.x"
          :y="messageMenu.y"
		  :can-pin="canPinMessages"
			  :can-delete="canModerateMessages"
			  :can-copy="Boolean(messageMenu.message?.content)"
			  :pinned="selectedMessageIsPinned"
			  @close="closeMessageMenu"
			  @copy="copySelectedMessage"
			  @reply="replyToSelectedMessage"
          @pin="pinSelectedMessage"
          @unpin="unpinSelectedMessage"
          @delete="confirmDeleteMessage"
        />

		<MessageComposer
		  ref="messageComposer"
		  v-model="composerText"
		  :pending-attachment="pendingAttachment"
		  :sending="sending"
			  :disabled="!activeRoom || activeDmBlockedByMe"
			  :error="error"
			  :mention-candidates="mentionCandidates"
			  :replying-to="replyingTo"
			  :context-key="activeRoomKey"
			  @send="sendComposerMessage"
			  @voice-recorded="sendComposerVoice"
			  @cancel-reply="replyingTo = null"
		  @upload="uploadAttachment"
		  @clear-attachment="clearAttachment"
		/>
      </template>

      <div v-else class="chat-empty">
        <LanguageSwitch class="chat-empty__language-switch" />
        <div class="empty-content">
          <div class="empty-brand">
            <MessageCircle :size="36" :stroke-width="1.5" aria-hidden="true" />
            <span class="empty-title">EdgeChat</span>
          </div>
          <p>{{ t('chat.noConversationSelected') }}</p>
          <button type="button" class="empty-start" @click="openAddConversation">
            <MessageCircle :size="18" aria-hidden="true" />
            {{ t('chat.addPeople') }}
          </button>
        </div>
      </div>
    </main>

    <div v-if="!isContactsView && showMemberPanel" class="room-management-layer" @click.self="closeMemberPanel">
      <aside class="room-management-sidebar">
        <MemberPanel
          :room="activeRoom"
          :members="groupMembers"
          :loading="memberLoading"
          :can-manage="canManageActiveRoom"
          :invite-user-id="inviteUserId"
          :available-invite-users="availableInviteUsers"
          :invite-submitting="inviteSubmitting"
          @close="closeMemberPanel"
          @update:invite-user-id="inviteUserId = $event"
          @invite="inviteMember"
          @remove-member="removeMember"
          @open-profile="openLocalUserProfile"
          @delete-group="deleteGroup"
        />
      </aside>
    </div>

    <MobileNavigationDrawer
      :show="showMobileNavigation"
      :session="session"
      :show-admin="showAdminEntry"
      :notifications-enabled="notificationsEnabled"
      :notification-label="notificationActionLabel"
      :notification-disabled="notificationToggleDisabled"
      :active-view="isContactsView ? 'contacts' : 'chat'"
      @close="closeMobileNavigation"
      @chat="navigateFromMobileDrawer(openChat)"
      @contacts="navigateFromMobileDrawer(openContacts)"
      @settings="navigateFromMobileDrawer(openSettings)"
      @admin="navigateFromMobileDrawer(openAdmin)"
      @notification="toggleNotifications"
      @logout="navigateFromMobileDrawer(logout)"
    />

    <UserProfileDialog
      :show="showUserProfile"
      :identity="profileIdentity"
      :profile="userProfile"
      :loading="profileLoading"
      :unavailable="profileUnavailable"
      :error="profileError"
      :submitting="profileSubmitting"
      :restore-focus="profileRestoreFocus"
      :is-self="profileIsSelf"
      @close="closeUserProfile"
      @retry="retryUserProfile"
      @send-message="sendProfileMessage"
      @edit="editProfile"
    />
    <AddConversationDialog
      :show="showAddConversation"
      :users="usersWithoutDm"
      :opening-dm-user-id="openingDmUserId"
      :error="error"
      @close="closeAddConversation"
      @create-group="startGroupCreation"
      @open-dm="openDm"
    />

    <CreateGroupDialog
      :show="showCreateGroup"
      :users="users"
      :form="createGroupForm"
      :submitting="creatingGroup"
      :error="error"
      @close="closeCreateGroup"
      @toggle-member="toggleCreateGroupMember"
      @submit="createGroup"
    />

    <PublicGroupJoinDialog
      :show="Boolean(publicGroupPreview)"
      :channel="publicGroupPreview"
      :joining="joiningPublicGroup"
      @close="closePublicGroupPreview"
      @join="confirmPublicGroupJoin"
    />

    <GroupSettingsDialog
      :show="showGroupEditor"
      :room="activeRoom"
      :form="groupSettingsForm"
      :saving="groupSettingsSaving"
      :avatar-uploading="groupAvatarUploading"
      @close="closeGroupEditor"
      @upload-avatar="uploadGroupAvatar"
      @save="saveGroupSettings"
    />
    <InAppNotificationStack
      :notifications="inAppNotifications"
      @open="openInAppNotification"
      @dismiss="dismissInAppNotification"
    />
  </div>
</template>

<style scoped>
.chat-layout {
  position: fixed;
  top: var(--chat-viewport-offset-top, 0px);
  left: 0;
  display: flex;
  width: 100%;
  height: var(--chat-viewport-height, 100dvh);
  min-height: 100dvh;
  overflow: hidden;
  background: var(--chat-canvas);
  color: var(--chat-ink);
  font-family: var(--chat-font);
  letter-spacing: normal;
}

.left-sidebar {
  flex-shrink: 0;
  width: clamp(300px, 27vw, 380px);
  height: 100%;
  position: relative;
  z-index: 10;
  overflow: hidden;
  background: var(--chat-paper);
  border-right: 1px solid var(--chat-line);
}

.chat-layout--contacts .left-sidebar {
  display: none;
}

.left-sidebar .sidebar-inner {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--chat-paper);
  overflow: hidden;
}

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 84px;
  padding: 20px 24px 16px;
  background: var(--chat-paper);
}

.header-action.mobile-menu-action {
  display: none;
}

.brand-title {
  margin: 0;
  font-size: 23px;
  font-weight: 700;
  color: var(--chat-accent);
  font-family: var(--chat-font-heading);
  letter-spacing: 0;
}

.sidebar-header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.mobile-language-switch {
  display: none;
}

.header-action {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 var(--chat-control);
  width: var(--chat-control);
  height: var(--chat-control);
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--chat-muted);
  cursor: pointer;
  text-decoration: none;
  transition: background 150ms, color 150ms;
}

.header-action:hover {
  background: rgba(0, 0, 0, 0.05);
  color: var(--chat-ink);
}

.header-action--primary {
  background: var(--chat-selected);
  color: var(--chat-accent);
}

.header-action--primary:hover {
  background: var(--chat-pressed);
  color: var(--chat-accent-hover);
}

.header-action:active,
.chat-header__button:active {
  background: rgba(0, 0, 0, 0.08);
}

.sidebar-section {
  flex-shrink: 0;
}

.sidebar-list-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 24px 16px;
  color: var(--chat-muted);
}

.sidebar-list-heading h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.sidebar-list-heading > span {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.right-sidebar {
  flex-shrink: 0;
  width: 80px;
  height: 100%;
  position: relative;
  z-index: 10;
  overflow: visible;
  background: var(--chat-rail);
  border-right: 1px solid var(--chat-line);
}

.right-sidebar-inner {
  height: 100%;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  background: var(--chat-rail);
  padding: 20px 8px;
  align-items: center;
}

.right-sidebar-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: center;
  width: 100%;
}

.right-sidebar-user-group {
  margin-top: auto;
}

.right-sidebar-action,
.right-sidebar-user {
  display: flex;
  align-items: center;
  justify-content: center;
  width: var(--chat-control);
  height: var(--chat-control);
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--chat-muted);
  cursor: pointer;
  transition: background 150ms, color 150ms, transform 150ms;
  padding: 0;
  position: relative;
  touch-action: manipulation;
}

.right-sidebar-action:hover,
.right-sidebar-user:hover {
  background: rgba(0, 0, 0, 0.05);
  color: var(--chat-ink);
}

.right-sidebar-action--danger:hover {
  background: rgba(254, 242, 242, 0.8);
  color: var(--chat-danger);
}

.right-sidebar-action--admin,
.right-sidebar-action--labeled {
  width: 64px;
  min-height: 60px;
  height: auto;
  padding: 8px 2px;
  gap: 6px;
  border-radius: 14px;
}

.right-sidebar-action--admin {
  flex-direction: column;
}

.right-sidebar-action--labeled {
  flex-direction: column;
}

.right-sidebar-action--notification-active {
  color: var(--chat-accent);
}

.right-sidebar-action--current {
  background: var(--chat-selected);
  color: var(--chat-accent);
  box-shadow: inset 3px 0 var(--chat-accent);
}

.right-sidebar-action:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.right-sidebar-action__label {
  max-width: 100%;
  font-size: 11px;
  line-height: 1.35;
  white-space: nowrap;
  text-align: center;
}

.tooltip {
  position: relative;
}

.tooltip::after {
  content: attr(data-tooltip);
  position: absolute;
  left: 120%;
  top: 50%;
  transform: translateY(-50%);
  background: var(--chat-ink);
  color: var(--chat-paper);
  padding: 6px 10px;
  border-radius: 6px;
  font-size: 12px;
  white-space: nowrap;
  opacity: 0;
  pointer-events: none;
  transition: opacity 150ms ease, transform 150ms ease;
  z-index: 1000;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}

.tooltip:hover::after {
  opacity: 1;
  transform: translateY(-50%) translateX(4px);
  transition-delay: 800ms;
}

.tooltip:focus-visible::after {
  opacity: 1;
  transition: none;
}

.chat-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--chat-canvas);
}

.chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 76px;
  padding: 12px 24px;
  background: var(--chat-paper);
  border-bottom: 1px solid var(--chat-line);
}

.chat-header__back {
  display: none;
}

.chat-header__avatar {
  flex: 0 0 auto;
}

.chat-header__identity {
  display: grid;
  flex: 1;
  gap: 4px;
  min-width: 0;
}

.chat-header__identity span {
  overflow: hidden;
  color: var(--chat-muted);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat-header__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.chat-header__language-switch {
  width: var(--chat-control);
  min-width: var(--chat-control);
  height: var(--chat-control);
  border: 0;
  background: transparent;
  box-shadow: none;
}

.chat-header__button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-width: var(--chat-control);
  min-height: var(--chat-control);
  padding: 8px 12px;
  border: 1px solid transparent;
  border-radius: var(--chat-radius);
  background: transparent;
  color: var(--chat-muted);
  font-size: 12px;
  cursor: pointer;
  transition: background 150ms, color 150ms, border-color 150ms;
  touch-action: manipulation;
  white-space: nowrap;
}

.chat-header__button:hover {
  background: var(--chat-hover);
  border-color: var(--chat-line);
  color: var(--chat-ink);
}

.chat-header__button--active {
  border-color: var(--chat-line);
  background: var(--chat-selected);
  color: var(--chat-accent);
}

.chat-header__button--danger:hover,
.chat-header__button--blocked {
  border-color: var(--chat-danger);
  background: var(--chat-danger-soft);
  color: var(--chat-danger);
}

.chat-header__button:disabled {
  cursor: wait;
  opacity: 0.55;
}

.header-action:focus-visible,
.right-sidebar-action:focus-visible,
.right-sidebar-user:focus-visible,
.chat-header__button:focus-visible,
.chat-header__back:focus-visible,
.load-more-btn:focus-visible,
.empty-start:focus-visible {
  outline: 2px solid var(--chat-accent);
  outline-offset: 2px;
}

.header-action img {
  display: block;
  width: 20px;
  height: 20px;
}

.chat-header h2 {
  margin: 0;
  padding: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--chat-ink);
  background: transparent;
  border-radius: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat-header__status {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--chat-line);
}

.chat-header__status.online {
  background: var(--chat-online);
}

.chat-messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  /* 超宽屏保持对话集中，避免左右气泡相距过远；窄屏沿用安全区留白。 */
  padding: 24px max(28px, calc((100% - 960px) / 2));
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  touch-action: pan-y;
}

.chat-messages::-webkit-scrollbar { width: 6px; }
.chat-messages::-webkit-scrollbar-thumb { background: rgba(0, 0, 0, 0.15); border-radius: 3px; }

.load-more-btn {
  display: block;
  margin: 0 auto 16px;
  min-height: var(--chat-control);
  padding: 10px 20px;
  border: 1px solid var(--chat-line);
  border-radius: 24px;
  background: var(--chat-paper);
  color: var(--chat-muted);
  font-size: 12px;
  cursor: pointer;
  transition: background 150ms, border-color 150ms;
}

.load-more-btn:hover {
  background: var(--chat-hover);
  border-color: var(--chat-line);
}

.messages-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 64px 24px;
  color: var(--chat-subtle);
  font-size: 14px;
}

.message-row {
  display: flex;
  align-items: flex-end;
  gap: 10px;
  margin-bottom: 16px;
  width: 100%;
  justify-content: flex-start;
}

.message-row--own {
  justify-content: flex-end;
}

.message-bubble--highlighted {
  outline: 3px solid rgba(0, 128, 105, 0.3);
  outline-offset: 3px;
  transition: outline-color 180ms ease;
}

.message-avatar-trigger {
  position: relative;
  min-width: 34px;
  min-height: 34px;
}
/* 扩大触摸命中区域，但保留原有 34px 头像与气泡排版。 */
.message-avatar-trigger::before {
  content: "";
  position: absolute;
  inset: -5px;
  border-radius: 50%;
}
.message-avatar {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  box-shadow: none;
}

.message-bubble {
  min-width: 0;
  max-width: min(76%, 620px);
  padding: 10px 12px 8px;
  border-radius: 14px 14px 14px 4px;
  background: var(--chat-paper);
  border: none;
  position: relative;
  word-break: break-word;
  box-shadow: var(--chat-shadow);
}

.message-row--actionable .message-bubble {
  touch-action: pan-y;
  -webkit-touch-callout: none;
}

.message-bubble--with-attachment {
  padding-bottom: 20px;
}

.message-row--own .message-bubble {
  background: var(--chat-outgoing);
  border-radius: 14px 14px 4px 14px;
}

.message-sender-name {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--chat-accent);
  margin-bottom: 4px;
  overflow-wrap: anywhere;
  min-width: 0;
}

.message-time {
  position: absolute;
  right: 8px;
  bottom: 6px;
  font-size: 11px;
  line-height: 1;
  color: var(--chat-muted);
  white-space: nowrap;
  user-select: none;
}

.message-bubble__reply {
	margin-bottom: 5px;
}

.chat-empty {
  position: relative;
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.chat-empty__language-switch {
  position: absolute;
  top: 10px;
  right: 16px;
}

.empty-content {
  display: grid;
  justify-items: center;
  align-items: center;
  gap: 16px;
  max-width: 360px;
  padding: 32px;
  text-align: center;
}

.empty-content p {
  margin: 0 0 8px;
  color: var(--chat-muted);
  font-size: 15px;
  line-height: 1.6;
}

.empty-start {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: var(--chat-control);
  padding: 10px 20px;
  border: 1px solid var(--chat-line);
  border-radius: 24px;
  background: var(--chat-paper);
  color: var(--chat-accent);
  font-size: 14px;
  font-weight: 600;
}

.empty-start:hover {
  background: var(--chat-selected);
}

.empty-brand {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 20px;
  color: var(--chat-accent);
  user-select: none;
}

.empty-title {
  font-size: 28px;
  font-weight: 650;
  font-family: var(--chat-font-heading);
  font-style: normal;
  letter-spacing: -0.04em;
  color: var(--chat-ink);
}

.room-management-layer {
  /* 成员面板覆盖聊天区而非挤压它，打开面板不会改变消息与输入栏的宽度。 */
  position: absolute;
  inset: 76px 0 0;
  z-index: 30;
  display: flex;
  justify-content: flex-end;
  background: var(--chat-scrim);
}

.room-management-sidebar {
  width: min(360px, 100%);
  height: 100%;
  overflow-y: auto;
  background: var(--chat-hover);
  border-left: 1px solid var(--chat-line);
  touch-action: pan-y;
  box-shadow: var(--chat-shadow-panel);
}

/* 中等宽度只压缩次要按钮文字，不牺牲标题或触摸面积。 */
@media (min-width: 961px) and (max-width: 1280px) {
  .chat-header__button {
    width: var(--chat-control);
    padding: 0;
  }
  .chat-header__button span { display: none; }
}

@media (max-width: 960px) {
  .chat-layout {
    min-height: 0;
    background: var(--chat-paper);
  }

  .right-sidebar {
    display: none;
  }

  .left-sidebar {
    width: 100%;
    max-width: none;
    border-right: 0;
  }

  .chat-main {
    width: 100%;
    flex: 0 0 100%;
  }

  .chat-layout--mobile-list .chat-main,
  .chat-layout--mobile-chat .left-sidebar {
    display: none;
  }

  .sidebar-header {
    min-height: 64px;
    gap: 8px;
    padding:
      max(8px, env(safe-area-inset-top))
      max(12px, env(safe-area-inset-right))
      8px
      max(8px, env(safe-area-inset-left));
  }

  .header-action.mobile-menu-action {
    display: flex;
    flex: 0 0 44px;
    width: 44px;
    height: 44px;
  }

  .brand-title {
    flex: 1;
    min-width: 0;
    font-size: 21px;
  }

  .header-action {
    flex-basis: 44px;
    width: 44px;
    height: 44px;
  }

  .header-action--github {
    display: none;
  }

  .sidebar-header-actions {
    gap: 4px;
  }

  .mobile-language-switch {
    display: inline-grid;
  }

  .chat-header {
    min-height: 64px;
    gap: 8px;
    padding:
      max(8px, env(safe-area-inset-top))
      max(8px, env(safe-area-inset-right))
      8px
      max(4px, env(safe-area-inset-left));
  }

  .chat-header__back {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 44px;
    width: 44px;
    height: 44px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: var(--chat-ink);
    touch-action: manipulation;
  }

  .chat-header__back:active {
    background: rgba(0, 0, 0, 0.08);
  }

  .chat-header__avatar {
    flex: 0 0 36px;
  }

  .chat-header__identity h2 {
    font-size: 15px;
  }

  .chat-header__button {
    width: 44px;
    height: 44px;
    min-height: 44px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: transparent;
  }

  .chat-header__button span {
    display: none;
  }

  .chat-header__status {
    width: 7px;
    height: 7px;
  }

  .chat-header__actions {
    gap: 0;
  }

  .chat-header__language-switch {
    width: 44px;
    min-width: 44px;
    height: 44px;
    border: 0;
    border-radius: 50%;
    background: transparent;
  }

  .chat-messages {
    padding: 14px max(10px, env(safe-area-inset-right)) 18px max(10px, env(safe-area-inset-left));
    scrollbar-gutter: auto;
  }

  .message-row {
    gap: 8px;
    margin-bottom: 12px;
  }

  .message-bubble {
    max-width: calc(100% - 44px);
  }

  .room-management-layer {
    position: fixed;
    inset: 0;
    z-index: 40;
    display: flex;
    justify-content: flex-end;
    width: auto;
    height: auto;
    padding-left: 48px;
    background: rgba(11, 20, 26, 0.35);
  }

  .room-management-sidebar {
    width: min(360px, 100%);
    height: 100%;
    padding-top: env(safe-area-inset-top);
    padding-bottom: env(safe-area-inset-bottom);
    box-shadow: -12px 0 30px rgba(11, 20, 26, 0.16);
  }
}

@media (max-width: 380px) {
  .chat-header__avatar,
  .chat-header__status {
    display: none;
  }

  .chat-header {
    gap: 4px;
  }

  .message-bubble {
    max-width: calc(100% - 40px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .header-action,
  .right-sidebar-action,
  .right-sidebar-user,
  .tooltip::after,
  .chat-header__button,
  .message-bubble--highlighted {
    transition: none;
  }
}
</style>
