import manifest from '../generated/schema-manifest.json' with { type: 'json' };
import { createInternalHeaders } from '../verified-identity.js';
import { inspectSchema, type SchemaQuery } from './schema-contract.ts';
import { getFileStorage, hasFileStorage } from '../storage/index.ts';

interface Database {
  prepare(sql: string): { all(): Promise<{ results: Awaited<ReturnType<SchemaQuery>> }> };
}
interface Namespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}
interface MaintenanceEnv {
  DB?: Database;
  SESSIONS?: { get(key: string): Promise<unknown> };
  FILES?: { list(options: { limit: number }): Promise<unknown> };
  EDGECHAT_S3?: string;
  CHANNEL_ROOM?: Namespace;
  USER_INBOX?: Namespace;
  SCHEDULER?: Namespace;
  INSTANCE_BRIDGE?: Namespace;
  VOICE_CALL?: Namespace;
  TELEGRAM_NOTIFICATIONS?: Namespace;
  [key: string]: unknown;
}
type CheckStatus = 'ok' | 'error' | 'missing' | 'disabled' | 'blocked';
interface Check {
  id: string;
  status: CheckStatus;
  code: string;
  durationMs: number;
  schema?: Awaited<ReturnType<typeof inspectSchema>>;
}

async function probe(id: string, operation: () => Promise<Partial<Check>>, timeoutMs: number): Promise<Check> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      operation(),
      new Promise<Partial<Check>>((resolve) => {
        timer = setTimeout(() => resolve({ status: 'error', code: 'timeout' }), timeoutMs);
      })
    ]);
    return { id, status: 'ok', code: 'reachable', ...result, durationMs: Date.now() - started };
  } catch {
    // 上游异常可能包含请求地址或凭据；只返回稳定诊断码，不透传 exception。
    return { id, status: 'error', code: 'request_failed', durationMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

function absent(id: string, optional = false): Check {
  return { id, status: optional ? 'disabled' : 'missing', code: optional ? 'not_enabled' : 'binding_missing', durationMs: 0 };
}

export function inspectEnvironment(env: MaintenanceEnv) {
  const present = (name: string) => typeof env[name] === 'string' && (env[name] as string).trim().length > 0;
  const encryptionPresent = present('EDGECHAT_ENCRYPTION_KEYRING') ||
    (present('EDGECHAT_ENCRYPTION_ACTIVE_KEY_ID') && Object.keys(env).some((key) => /^EDGECHAT_ENCRYPTION_KEY_\d+$/.test(key) && present(key)));
  return [
    { name: 'EDGECHAT_ENCRYPTION_KEYRING / EDGECHAT_ENCRYPTION_ACTIVE_KEY_ID + EDGECHAT_ENCRYPTION_KEY_N', required: true, present: encryptionPresent },
    { name: 'EDGECHAT_TURN_KEY_ID + EDGECHAT_TURN_API_TOKEN', required: false, present: present('EDGECHAT_TURN_KEY_ID') && present('EDGECHAT_TURN_API_TOKEN') },
    ...['ADMIN_USERNAMES', 'MESSAGE_RETENTION_DAYS', 'SOFT_DELETE_RETENTION_DAYS', 'MAX_FILE_SIZE', 'ALLOWED_FILE_TYPES'].map((name) => ({ name, required: false, present: present(name) }))
  ];
}

async function checkObject(id: string, namespace: Namespace | undefined, service: string, timeoutMs: number) {
  if (!namespace) return absent(id);
  return probe(id, async () => {
    // 固定探针地址复用同一对象，不创建随机业务房间，也不触发任何持久化写入。
    const stub = namespace.get(namespace.idFromName('__edgechat_health__'));
    const response = await stub.fetch(new Request('https://internal/health', { headers: createInternalHeaders() }));
    const body = await response.json() as { ok?: boolean; service?: string };
    if (!response.ok || body.ok !== true || body.service !== service) {
      return { status: 'error', code: 'unexpected_response' };
    }
    return {};
  }, timeoutMs);
}

export async function runSystemCheck(env: MaintenanceEnv, { timeoutMs = 8000 } = {}) {
  const started = Date.now();
  const database = async (): Promise<Check[]> => {
    if (!env.DB) return [absent('d1'), { id: 'schema', status: 'blocked', code: 'database_unavailable', durationMs: 0 }];
    const db = env.DB;
    const query: SchemaQuery = async (sql) => (await db.prepare(sql).all()).results;
    const connectivity = await probe('d1', async () => { await query('SELECT 1'); return {}; }, timeoutMs);
    if (connectivity.status !== 'ok') return [connectivity, { id: 'schema', status: 'blocked', code: 'database_unavailable', durationMs: 0 }];
    const schema = await probe('schema', async () => {
      const result = await inspectSchema(query, manifest);
      return { status: result.status === 'ok' ? 'ok' : 'error', code: result.status, schema: result };
    }, timeoutMs);
    return [connectivity, schema];
  };
  const [dbChecks, kv, r2, room, inbox, scheduler, bridge, call, notifications] = await Promise.all([
    database(),
    env.SESSIONS ? probe('sessions', async () => { await env.SESSIONS?.get('__edgechat_health__'); return {}; }, timeoutMs) : absent('sessions'),
    hasFileStorage(env) ? probe('files', async () => { await getFileStorage(env)?.list({ limit: 1 }); return {}; }, timeoutMs) : absent('files', true),
    checkObject('channelRoom', env.CHANNEL_ROOM, 'ChannelRoom', timeoutMs),
    checkObject('userInbox', env.USER_INBOX, 'UserInbox', timeoutMs),
    checkObject('scheduler', env.SCHEDULER, 'Scheduler', timeoutMs),
    checkObject('instanceBridge', env.INSTANCE_BRIDGE, 'InstanceBridge', timeoutMs),
    checkObject('voiceCall', env.VOICE_CALL, 'VoiceCall', timeoutMs),
    checkObject('telegramNotifications', env.TELEGRAM_NOTIFICATIONS, 'TelegramNotifications', timeoutMs)
  ]);
  const environment = inspectEnvironment(env);
  const checks: Check[] = [...dbChecks, kv, r2, room, inbox, scheduler, bridge, call, notifications, {
    id: 'environment', status: environment.some((item) => item.required && !item.present) ? 'missing' : 'ok',
    code: 'presence_only', durationMs: 0
  }];
  return {
    checkedAt: new Date().toISOString(), durationMs: Date.now() - started,
    status: checks.some((check) => ['error', 'missing', 'blocked'].includes(check.status)) ? 'error' : checks.some((check) => check.status === 'disabled') ? 'warning' : 'ok',
    version: `v${manifest.version}`, expectedMigration: manifest.migrations.at(-1)?.id ?? null,
    checks, environment
  };
}
