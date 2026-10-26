import { ApiError } from '../errors.js';

export const MAX_INVITE_USES = 1000;

function toInvite(row) {
  const maxUses = Number(row.max_uses);
  const usedCount = Number(row.used_count);

  return {
    id: Number(row.id),
    token: row.token,
    note: row.note || '',
    maxUses,
    usedCount,
    remainingUses: Math.max(0, maxUses - usedCount),
    createdAt: row.created_at,
    consumedAt: row.consumed_at || null,
    deletedAt: row.deleted_at || null,
    creatorDisplayName: row.creator_display_name || '管理员',
    consumerDisplayName: row.consumer_display_name || '',
    isAvailable: !row.deleted_at && usedCount < maxUses
  };
}

export async function listActiveRegistrationInvites(db) {
  const { results } = await db.prepare(
    `SELECT
       ri.id,
       ri.token,
       ri.note,
       ri.max_uses,
       ri.used_count,
       ri.created_at,
       ri.consumed_at,
       ri.deleted_at,
       creator.display_name AS creator_display_name,
       consumer.display_name AS consumer_display_name
     FROM registration_invites ri
     LEFT JOIN users creator ON creator.id = ri.created_by
     LEFT JOIN users consumer ON consumer.id = ri.consumed_by_user_id
     WHERE ri.deleted_at IS NULL
       AND ri.used_count < ri.max_uses
     ORDER BY ri.created_at DESC`
  ).all();

  return results.map(toInvite);
}

export async function createRegistrationInvite(db, invite) {
  const result = await db.prepare(
    `INSERT INTO registration_invites (token, note, max_uses, created_by)
     VALUES (?, ?, ?, ?)`
  )
    .bind(invite.token, invite.note, invite.maxUses, invite.createdBy)
    .run();

  return toInvite({
    id: result.meta.last_row_id,
    token: invite.token,
    note: invite.note,
    max_uses: invite.maxUses,
    used_count: 0,
    created_at: new Date().toISOString(),
    consumed_at: null,
    deleted_at: null,
    creator_display_name: invite.creatorDisplayName,
    consumer_display_name: ''
  });
}

export async function revokeRegistrationInvite(db, inviteId) {
  await db.prepare(
    `UPDATE registration_invites
     SET deleted_at = CURRENT_TIMESTAMP
     WHERE id = ?
       AND deleted_at IS NULL`
  )
    .bind(inviteId)
    .run();
}

export async function getAvailableRegistrationInvite(db, token) {
  const row = await db.prepare(
    `SELECT id, note, max_uses, used_count, created_at, created_by
     FROM registration_invites
     WHERE token = ?
       AND deleted_at IS NULL
       AND used_count < max_uses
     LIMIT 1`
  )
    .bind(token)
    .first();

  if (!row) {
    return null;
  }

  return {
    id: Number(row.id),
    note: row.note || '',
    maxUses: Number(row.max_uses),
    usedCount: Number(row.used_count),
    remainingUses: Math.max(0, Number(row.max_uses) - Number(row.used_count)),
    createdAt: row.created_at,
    createdBy: row.created_by == null ? null : Number(row.created_by)
  };
}

export async function createUserWithRegistrationInvite(db, user) {
  try {
    const invitedBy = user.invitedBy == null ? null : Number(user.invitedBy);
    const [userResult] = await db.batch([
      db.prepare(
        `INSERT INTO users (
           username,
           display_name,
           password_hash,
           password_salt,
           invited_by,
           invited_at
         ) VALUES (?, ?, ?, ?, ?, CASE WHEN ? IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END)`
      ).bind(
        user.username,
        user.displayName,
        user.passwordHash,
        user.passwordSalt,
        invitedBy,
        invitedBy
      ),
      db.prepare(
        `INSERT INTO registration_invite_uses (invite_id, user_id)
         VALUES (?, (SELECT id FROM users WHERE username = ?))`
      ).bind(user.inviteId, user.username)
    ]);

    return Number(userResult.meta.last_row_id);
  } catch (error) {
    const message = String(error?.message || error);
    if (message.includes('REGISTRATION_INVITE_UNAVAILABLE')) {
      throw new ApiError('注册链接已失效');
    }
    if (message.includes('UNIQUE')) {
      throw new ApiError('用户名已存在');
    }
    throw error;
  }
}
