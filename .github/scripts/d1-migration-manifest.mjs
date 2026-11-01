export const D1_MIGRATIONS = [
  {
    id: "2026-04-05-private-groups",
    file: "worker/migrations/2026-04-05-private-groups.sql",
    artifacts: ["column:channel_members.role", "column:channel_members.invited_by"],
  },
  {
    id: "2026-04-09-registration-invites",
    file: "worker/migrations/2026-04-09-registration-invites.sql",
    artifacts: ["column:users.registration_invite_id", "table:registration_invites"],
  },
  {
    id: "2026-04-09-site-settings",
    file: "worker/migrations/2026-04-09-site-settings.sql",
    artifacts: ["table:site_settings"],
  },
  {
    id: "2026-04-12-channel-avatar",
    file: "worker/migrations/2026-04-12-channel-avatar.sql",
    artifacts: ["column:channels.avatar_key"],
  },
  {
    id: "2026-04-18-admin-session-version",
    file: "worker/migrations/2026-04-18-admin-session-version.sql",
    artifacts: ["column:users.is_admin", "column:users.session_version"],
  },
  {
    id: "2026-04-19-gc-maintenance",
    file: "worker/migrations/2026-04-19-gc-maintenance.sql",
    artifacts: ["table:pending_r2_delete"],
  },
  {
    id: "2026-07-02-message-read-badges",
    file: "worker/migrations/2026-07-02-message-read-badges.sql",
    artifacts: ["table:message_reads"],
  },
  {
    id: "2026-07-09-uploaded-files",
    file: "worker/migrations/2026-07-09-uploaded-files.sql",
    artifacts: ["table:uploaded_files", "index:idx_uploaded_files_owner"],
  },
  {
    id: "2026-07-28-general-channel",
    file: "worker/migrations/2026-07-28-general-channel.sql",
    artifacts: [
      "trigger:add_new_user_to_general",
      "trigger:prevent_general_member_removal",
      "trigger:protect_general_channel",
    ],
    rerunnable: true,
  },
  {
    id: "2026-07-29-registration-invite-usage",
    file: "worker/migrations/2026-07-29-registration-invite-usage.sql",
    artifacts: [
      "column:registration_invites.max_uses",
      "column:registration_invites.used_count",
      "table:registration_invite_uses",
      "trigger:validate_registration_invite_use",
      "trigger:consume_registration_invite_use",
      "index:idx_registration_invite_uses_invite",
      "index:idx_registration_invites_usage",
    ],
  },
  {
    id: "2026-08-12-telegram-bridge",
    file: "worker/migrations/2026-08-12-telegram-bridge.sql",
    artifacts: [
      "column:messages.sender_kind",
      "column:messages.external_sender_id",
      "column:messages.external_sender_name",
      "column:messages.external_sender_avatar_url",
      "column:messages.source",
      "column:messages.source_message_id",
      "table:telegram_bridge_config",
      "table:telegram_mappings",
      "index:idx_messages_external_source",
      "index:idx_telegram_mappings_channel",
    ],
  },
  {
    id: "2026-08-12-telegram-files",
    file: "worker/migrations/2026-08-12-telegram-files.sql",
    artifacts: [
      "column:messages.source_attachment_id",
      "column:messages.source_attachment_unique_id",
    ],
  },
  {
    id: "2026-08-20-user-ban-expiry",
    file: "worker/migrations/2026-08-20-user-ban-expiry.sql",
    artifacts: ["column:users.disabled_until"],
  },
  {
    id: "2026-08-30-mobile-client-v1",
    file: "worker/migrations/2026-08-30-mobile-client-v1.sql",
    artifacts: [
      "column:messages.client_message_id",
      "column:uploaded_files.client_upload_id",
      "table:device_sessions",
      "table:realtime_tickets",
      "table:message_events",
      // 此索引已被下一次迁移替换；不能再要求最终 schema 保留，否则全新安装无法登记基线。
      "index:idx_uploaded_files_client_upload",
      "index:idx_device_sessions_refresh_token",
      "index:idx_device_sessions_user_installation_active",
      "index:idx_device_sessions_user_active",
      "index:idx_realtime_tickets_expiry",
      "index:idx_message_events_channel_sequence",
      "trigger:record_message_created_event",
      "trigger:record_message_deleted_event",
    ],
  },
  {
    id: "2026-08-30-native-client-hardening",
    file: "worker/migrations/2026-08-30-native-client-hardening.sql",
    artifacts: [
      "index:idx_messages_channel_client_message",
      "table:message_event_compaction",
    ],
  },
  {
    id: "2026-08-30-pinned-messages",
    file: "worker/migrations/2026-08-30-pinned-messages.sql",
    artifacts: ["table:channel_pins", "trigger:clear_pin_after_message_soft_delete"],
  },
		{
			id: "2026-09-01-message-mentions",
			file: "worker/migrations/2026-09-01-message-mentions.sql",
			artifacts: ["column:messages.mention_user_ids"],
		},
		{
			id: "2026-09-02-voice-messages",
		file: "worker/migrations/2026-09-02-voice-messages.sql",
		artifacts: [
			"column:messages.attachment_kind",
			"column:messages.attachment_duration_ms",
			"column:messages.attachment_waveform",
			],
		},
	{
		id: "2026-09-04-message-replies",
		file: "worker/migrations/2026-09-04-message-replies.sql",
		artifacts: [
			"column:messages.reply_to_message_id",
			"column:messages.reply_to_sender_id",
			"index:idx_messages_reply_attention",
		],
	},
	{
		id: "2026-09-11-r2-cleanup-guards",
		file: "worker/migrations/2026-09-11-r2-cleanup-guards.sql",
		artifacts: [
			"index:idx_gc_uploaded_created",
			"index:idx_gc_message_attachment",
			"index:idx_gc_user_avatar",
			"index:idx_gc_channel_avatar",
			"trigger:prevent_pending_message_attachment_insert",
			"trigger:prevent_pending_message_attachment_update",
			"trigger:prevent_pending_user_avatar_insert",
			"trigger:prevent_pending_user_avatar_update",
			"trigger:prevent_pending_channel_avatar_insert",
			"trigger:prevent_pending_channel_avatar_update",
		],
	},
	{
		id: "2026-09-11-user-blocks",
		file: "worker/migrations/2026-09-11-user-blocks.sql",
		artifacts: ["table:user_blocks", "index:idx_user_blocks_blocked"],
	},
	{
		id: "2026-09-12-r2-reference-invariants",
		file: "worker/migrations/2026-09-12-r2-reference-invariants.sql",
		artifacts: [
			"trigger:prevent_general_member_removal",
			"trigger:prevent_pending_message_attachment_insert",
			"trigger:prevent_pending_message_attachment_update",
			"trigger:prevent_pending_user_avatar_insert",
			"trigger:prevent_pending_user_avatar_update",
			"trigger:prevent_pending_channel_avatar_insert",
			"trigger:prevent_pending_channel_avatar_update",
			"trigger:prevent_pending_site_icon_insert",
			"trigger:prevent_pending_site_icon_update",
		],
		rerunnable: true,
	},
	{
		id: "2026-09-12-user-bio",
		file: "worker/migrations/2026-09-12-user-bio.sql",
		artifacts: ["column:users.bio"],
	},
  {
    id: "2026-09-19-instance-bridge",
    file: "worker/migrations/2026-09-19-instance-bridge.sql",
    artifacts: [
      "column:messages.bridge_binding_id", "column:messages.source_instance",
      "column:messages.bridge_event_id", "column:messages.bridge_sent_at", "column:messages.bridge_target_revision",
      "table:bridge_instance", "table:instance_bindings", "table:bridge_outbox", "table:bridge_receipts",
      "trigger:enqueue_instance_bridge_message", "trigger:validate_instance_bridge_message",
      "trigger:revoke_instance_bridge_deleted_channel",
      "trigger:cancel_instance_bridge_deleted_message", "trigger:revoke_instance_bridge_soft_deleted_channel",
      "trigger:cancel_instance_bridge_generation", "index:idx_instance_bindings_channel",
      "trigger:validate_instance_binding_group", "trigger:count_instance_bridge_deleted_message",
      "index:idx_instance_bindings_control", "index:idx_bridge_outbox_due", "index:idx_bridge_receipts_expiry",
    ],
  },
  {
    id: "2026-09-26-telegram-notifications",
    file: "worker/migrations/2026-09-26-telegram-notifications.sql",
    artifacts: ["table:telegram_notification_users", "table:telegram_notification_outbox", "index:idx_telegram_notification_due"],
  },
  {
    id: "2026-10-05-user-login-info",
    file: "worker/migrations/2026-10-05-user-login-info.sql",
    artifacts: ["table:user_login_info"],
  },
  {
    id: "2026-10-05-user-webrtc",
    file: "worker/migrations/2026-10-05-user-webrtc.sql",
    artifacts: ["column:user_login_info.login_probe_id", "column:user_login_info.webrtc_ips", "column:user_login_info.webrtc_status", "column:user_login_info.webrtc_checked_at"],
  },
  {
    id: "2026-10-05-users-login-history",
    file: "worker/migrations/2026-10-05-users-login-history.sql",
    artifacts: ["column:user_login_info.id", "column:user_login_info.ip", "column:user_login_info.login_at", "index:idx_user_login_info_recent", "trigger:limit_user_login_info"],
  },
  {
    id: "2026-10-06-rbac",
    file: "worker/migrations/2026-10-06-rbac.sql",
    artifacts: ["column:users.is_super_admin", "column:users.management_protected", "column:users.authz_version",
      "table:rbac_roles", "table:rbac_role_permissions", "table:rbac_user_roles", "table:admin_write_guard", "table:admin_audit_log",
      "index:idx_rbac_members", "index:idx_admin_audit_time", "trigger:limit_admin_audit", "trigger:assign_new_user_rbac",
      "trigger:protect_default_rbac_update", "trigger:protect_default_rbac_delete", "trigger:protect_default_rbac_permissions",
      "trigger:protect_super_rbac_assignment", "trigger:protect_last_super_update", "trigger:protect_last_super_delete"],
  },
  {
    id: "2026-10-11-telegram-notification-budgets",
    file: "worker/migrations/2026-10-11-telegram-notification-budgets.sql",
    artifacts: ["column:telegram_notification_users.next_notification_at", "column:telegram_notification_outbox.sender_id",
      "column:telegram_notification_outbox.created_at", "table:telegram_notification_gate",
      "index:idx_telegram_notification_sender", "index:idx_telegram_notification_recipient",
      "index:idx_telegram_notification_created", "index:idx_telegram_notification_message"],
  },
  {
    id: "2026-10-26-ai-reply",
    file: "worker/migrations/2026-10-26-ai-reply.sql",
    artifacts: [
      "table:ai_reply_jobs",
      "index:idx_ai_reply_jobs_recipient",
      "index:idx_ai_reply_jobs_status",
    ],
    rerunnable: true,
  },
  {
    id: "2026-10-26-distribution",
    file: "worker/migrations/2026-10-26-distribution.sql",
    artifacts: ["column:users.invited_by", "column:users.invited_at", "index:idx_users_invited_by"],
  },
  {
    id: "2026-10-26-memory-account",
    file: "worker/migrations/2026-10-26-memory-account.sql",
    artifacts: [
      "table:user_memory_accounts",
      "table:text_session_reports",
      "index:idx_user_memory_accounts_status",
      "index:idx_text_session_reports_user",
    ],
    rerunnable: true,
  },
  {
    id: "2026-11-01-greet-contacts",
    file: "worker/migrations/2026-11-01-greet-contacts.sql",
    artifacts: [
      "table:greet_requests",
      "table:greet_contacts",
      "index:idx_greet_pending_by_to",
      "index:idx_greet_by_from",
    ],
    rerunnable: true,
  },
];

// b3f6855 曾发布、0c13e8f 已撤回的迁移：仅识别历史 ledger，不要求新安装创建废弃表，也不删除旧数据。
// 保留当时 LF/CRLF 的精确校验值，不能把所有早于当前版本的未知迁移一律当成正常。
export const D1_RETIRED_MIGRATIONS = [{
  id: "2026-08-10-server-encryption",
  checksum: "c9af2652aa817120a1b2b06230f4c8bd487b96da94579dbc22914e7457209393",
  compatibleChecksums: ["e2139b1aeded7c3214b39fa6d9b92db4c93c700f34fba3d696f3ca489111b6bb"]
}];
