/**
 * [打招呼制社交·数据层] 2026-11-01 老板拍板：熟人社交但边界比熟人远一点——
 * 默认互不可见不可搜；凭精确用户名发一句打招呼，对方点头后互见可聊。
 * 官方号（benben 等，site_settings social.officialUsers 可扩）永远可见，无需打招呼。
 */
import { activeUserSql } from '../user-status.js';

const OFFICIALS_KEY = 'social.officialUsers';
const DEFAULT_OFFICIALS = 'benben';

function pair(a, b) {
  const x = Number(a);
  const y = Number(b);
  return x < y ? [x, y] : [y, x];
}

export async function listOfficialUsernames(db) {
  const row = await db
    .prepare(`SELECT setting_value FROM site_settings WHERE setting_key = ? LIMIT 1`)
    .bind(OFFICIALS_KEY)
    .all();
  const raw = String(row.results?.[0]?.setting_value || DEFAULT_OFFICIALS);
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/** 互认联系人 id 集 */
export async function listContactIds(db, me) {
  const uid = Number(me);
  const { results } = await db
    .prepare(`SELECT a, b FROM greet_contacts WHERE a = ? OR b = ?`)
    .bind(uid, uid)
    .all();
  return results.map((r) => (Number(r.a) === uid ? Number(r.b) : Number(r.a)));
}

export async function areContacts(db, x, y) {
  const [a, b] = pair(x, y);
  const { results } = await db
    .prepare(`SELECT 1 AS hit FROM greet_contacts WHERE a = ? AND b = ? LIMIT 1`)
    .bind(a, b)
    .all();
  return Boolean(results[0]);
}

/** 可见用户＝官方号＋互认联系人（bootstrap/移动端目录用；旧 /api/contacts 全量给后台不动） */
export async function listVisibleUsers(db, me) {
  const uid = Number(me);
  const officials = await listOfficialUsernames(db);
  const contactIds = await listContactIds(db, me);
  const ids = [...new Set(contactIds.filter((id) => id !== uid))];
  const parts = [];
  const binds = [];
  if (ids.length) {
    parts.push(`id IN (${ids.map(() => '?').join(',')})`);
    binds.push(...ids);
  }
  if (officials.length) {
    parts.push(`username IN (${officials.map(() => '?').join(',')})`);
    binds.push(...officials);
  }
  const where = parts.length ? `AND (${parts.join(' OR ')})` : 'AND 1 = 0';
  const { results } = await db
    .prepare(
      `SELECT id, username, display_name, avatar_key
       FROM users
       WHERE deleted_at IS NULL AND ${activeUserSql()} AND id != ? ${where}
       ORDER BY display_name ASC`
    )
    .bind(uid, ...binds)
    .all();
  return results.map((r) => ({
    id: Number(r.id),
    username: r.username,
    displayName: r.display_name,
    avatarUrl: r.avatar_key ? `/files/${encodeURIComponent(r.avatar_key)}` : ''
  }));
}

/** 发打招呼：目标须存在、非自己、非官方号（官方号本就可见）、未互认、无 pending 重复 */
export async function sendGreeting(db, me, targetUsername, message) {
  const uid = Number(me);
  const name = String(targetUsername || '').trim();
  if (!name) return { ok: false, code: 400, reason: '请输入对方用户名' };

  const target = await db
    .prepare(
      `SELECT id, username FROM users
       WHERE username = ? AND deleted_at IS NULL AND ${activeUserSql()} LIMIT 1`
    )
    .bind(name)
    .all();
  const targetUser = target.results[0];
  if (!targetUser) return { ok: false, code: 404, reason: '没找到这个用户名，请核对后重试' };
  const tid = Number(targetUser.id);
  if (tid === uid) return { ok: false, code: 400, reason: '不能给自己打招呼' };

  const officials = await listOfficialUsernames(db);
  if (officials.includes(targetUser.username)) {
    return { ok: false, code: 400, reason: '官方助手无需打招呼，直接开聊即可' };
  }
  if (await areContacts(db, uid, tid)) {
    return { ok: false, code: 409, reason: '你们已经是联系人了' };
  }
  const dup = await db
    .prepare(
      `SELECT 1 AS hit FROM greet_requests
       WHERE from_user = ? AND to_user = ? AND status = 'pending' LIMIT 1`
    )
    .bind(uid, tid)
    .all();
  if (dup.results[0]) return { ok: false, code: 409, reason: '已经打过招呼了，等对方回应' };

  await db
    .prepare(`INSERT INTO greet_requests (from_user, to_user, message) VALUES (?, ?, ?)`)
    .bind(uid, tid, String(message || '').slice(0, 200))
    .run();
  return { ok: true };
}

/** 我的打招呼：收到的 pending＋我发出的（含状态） */
export async function listGreetings(db, me) {
  const uid = Number(me);
  const incoming = await db
    .prepare(
      `SELECT r.id, r.message, r.created_at, u.id AS from_id, u.username AS from_username, u.display_name AS from_display
       FROM greet_requests r JOIN users u ON u.id = r.from_user
       WHERE r.to_user = ? AND r.status = 'pending' ORDER BY r.id DESC LIMIT 50`
    )
    .bind(uid)
    .all();
  const outgoing = await db
    .prepare(
      `SELECT r.id, r.status, r.created_at, u.username AS to_username, u.display_name AS to_display
       FROM greet_requests r JOIN users u ON u.id = r.to_user
       WHERE r.from_user = ? ORDER BY r.id DESC LIMIT 50`
    )
    .bind(uid)
    .all();
  return {
    incoming: incoming.results.map(mapIncoming),
    outgoing: outgoing.results.map((r) => ({
      id: Number(r.id),
      status: r.status,
      to: { username: r.to_username, displayName: r.to_display },
      createdAt: r.created_at
    }))
  };
}

function mapIncoming(r) {
  return {
    id: Number(r.id),
    message: r.message,
    from: { id: Number(r.from_id), username: r.from_username, displayName: r.from_display },
    createdAt: r.created_at
  };
}

/** 回应打招呼（仅收件人）：accept＝互认（事务内落 greet_contacts） */
export async function respondGreeting(db, me, requestId, accept) {
  const uid = Number(me);
  const row = await db
    .prepare(`SELECT id, from_user, to_user, status FROM greet_requests WHERE id = ? LIMIT 1`)
    .bind(Number(requestId))
    .all();
  const req = row.results[0];
  if (!req || Number(req.to_user) !== uid) return { ok: false, code: 404, reason: '没有这条打招呼' };
  if (req.status !== 'pending') return { ok: false, code: 409, reason: '这条打招呼已经处理过了' };

  const status = accept ? 'accepted' : 'declined';
  if (!accept) {
    await db
      .prepare(`UPDATE greet_requests SET status = ?, responded_at = datetime('now') WHERE id = ?`)
      .bind(status, req.id)
      .run();
    return { ok: true, status };
  }
  const [a, b] = pair(req.from_user, req.to_user);
  await db.batch([
    db
      .prepare(`UPDATE greet_requests SET status = ?, responded_at = datetime('now') WHERE id = ?`)
      .bind(status, req.id),
    db
      .prepare(`INSERT OR IGNORE INTO greet_contacts (a, b) VALUES (?, ?)`)
      .bind(a, b)
  ]);
  return { ok: true, status };
}
