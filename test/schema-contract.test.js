import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import initSqlJs from "sql.js";
import { runSystemCheck } from "../worker/src/maintenance/system-check.ts";

import { generateSchemaManifest } from "../.github/scripts/generate-schema-manifest.mjs";
import { D1_MIGRATIONS } from "../.github/scripts/d1-migration-manifest.mjs";
import { buildD1MigrationPlan, migrationChecksums } from "../.github/scripts/d1-migration-plan.mjs";
import { assessSchema, collectSchemaArtifacts, inspectSchema, schemaTables, D1_MIGRATION_LEDGER } from "../worker/src/maintenance/schema-contract.ts";
import { demoMaintenanceReport } from "../frontend/src/demo/maintenance.ts";

const SQL = await initSqlJs();
const rows = (db, sql) => {
  const result = db.exec(sql)[0];
  return result ? result.values.map((values) => Object.fromEntries(result.columns.map((name, i) => [name, values[i]]))) : [];
};

test("deployment and runtime inspect only application tables, never protected D1 internal tables", async () => {
  const manifest = { version: '1', schemaHash: 'h', artifacts: ['table:users', 'column:users.id'], migrations: [] };
  const query = async (sql) => {
    if (sql.includes('sqlite_master')) return [{ type: 'table', name: 'users' }, { type: 'table', name: '_cf_METADATA' }];
    assert.doesNotMatch(sql, /_cf_METADATA/);
    return [{ name: 'id' }];
  };
  const artifacts = await collectSchemaArtifacts(query, schemaTables(manifest));
  assert.ok(artifacts.has('column:users.id'));
  assert.equal((await inspectSchema(query, manifest)).missingArtifacts.length, 0);
});

test("manifest is generated from executable SQLite schema and includes future tables/columns/indexes/triggers", async () => {
  const manifest = await generateSchemaManifest();
  const project = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const schema = readFileSync(new URL("../worker/schema.sql", import.meta.url), "utf8").replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const db = new SQL.Database();
  db.exec(schema);
  db.exec("CREATE TABLE future_probe (id INTEGER PRIMARY KEY, label TEXT); CREATE INDEX future_probe_label ON future_probe(label); CREATE TRIGGER future_probe_trigger AFTER INSERT ON future_probe BEGIN SELECT 1; END;");
  const artifacts = await collectSchemaArtifacts(async (sql) => rows(db, sql));
  assert.equal(manifest.version, project.version);
  assert.ok(manifest.artifacts.includes("table:users"));
  assert.ok(artifacts.has("table:future_probe"));
  assert.ok(artifacts.has("column:future_probe.label"));
  assert.ok(artifacts.has("index:future_probe_label"));
  assert.ok(artifacts.has("trigger:future_probe_trigger"));
  db.close();
});

test("fresh schema is baselined in ledger without replaying migration SQL", async () => {
  const manifest = await generateSchemaManifest();
  const plan = await buildD1MigrationPlan({ migrations: D1_MIGRATIONS, appliedMigrations: new Map(), artifacts: new Set(manifest.artifacts), readSql: (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8") });
  assert.ok(plan.decisions.every(({ action }) => action === "baseline"));
  assert.match(plan.sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${D1_MIGRATION_LEDGER}`));
  assert.doesNotMatch(plan.sql, /ALTER TABLE/);
});

test("schema assessment reports missing artifacts, migrations, drift and unknown versions", () => {
  const manifest = { version: "1", schemaHash: "h", artifacts: ["table:a", "column:a.id", "index:i", "trigger:t"], migrations: [{ id: "m1", checksum: "good", compatibleChecksums: ["crlf"] }] };
  const result = assessSchema(manifest, new Set(["table:a"]), new Map([["old", "x"], ["m1", "bad"]]));
  assert.equal(result.status, "checksum_mismatch");
  assert.deepEqual(result.missingArtifacts, ["column:a.id", "index:i", "trigger:t"]);
  assert.deepEqual(result.missingMigrations, []);
  assert.deepEqual(result.unknownMigrations, ["old"]);
  assert.equal(assessSchema(manifest, new Set(["table:a", "column:a.id", "index:i", "trigger:t"]), new Map()).status, "untracked");
});

test("migration plan handles CRLF checksums and rejects changed or partial migrations", async () => {
  const sql = "CREATE TABLE x (id INTEGER);\r\n";
  const checksums = migrationChecksums(sql);
  const base = { id: "m", file: "x.sql", artifacts: ["table:x", "index:x_idx"], rerunnable: false };
  const readSql = async () => sql;
  const normalized = await buildD1MigrationPlan({ migrations: [base], appliedMigrations: new Map([["m", [...checksums.compatible][0]]]), artifacts: new Set(), readSql });
  assert.equal(normalized.decisions[0].action, "normalize");
  await assert.rejects(() => buildD1MigrationPlan({ migrations: [base], appliedMigrations: new Map([["m", "wrong"]]), artifacts: new Set(), readSql }), /校验值发生变化/);
  await assert.rejects(() => buildD1MigrationPlan({ migrations: [base], appliedMigrations: new Map(), artifacts: new Set(["table:x"]), readSql: async () => sql }), /只完成了一部分/);
});

test("inspectSchema reads a real SQLite ledger", async () => {
  const db = new SQL.Database();
  db.exec("CREATE TABLE a (id INTEGER); CREATE TABLE edgechat_schema_migrations (migration_id TEXT, checksum TEXT);");
  db.run("INSERT INTO edgechat_schema_migrations VALUES ('m1','good')");
  const manifest = { version: "1", schemaHash: "h", artifacts: ["table:a", "table:edgechat_schema_migrations", "column:a.id"], migrations: [{ id: "m1", checksum: "good", compatibleChecksums: [] }] };
  assert.equal((await inspectSchema(async (sql) => rows(db, sql), manifest)).status, "ok");
  db.close();
});

test("full schema executes baseline migration plan into ledger and passes system contract", async () => {
  const manifest = await generateSchemaManifest();
  const db = new SQL.Database();
  db.exec(readFileSync(new URL("../worker/schema.sql", import.meta.url), "utf8"));
  const plan = await buildD1MigrationPlan({
    migrations: D1_MIGRATIONS,
    appliedMigrations: new Map(),
    artifacts: new Set(manifest.artifacts),
    readSql: (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8")
  });
  db.exec(plan.sql);
  assert.ok(plan.decisions.every(({ action }) => action === "baseline"));
  assert.deepEqual(plan.decisions.find(({ id }) => id === "2026-04-05-private-groups"), {
    id: "2026-04-05-private-groups", action: "baseline"
  });
  assert.doesNotMatch(plan.sql, /DROP TABLE channels|CREATE TABLE channels_new|ALTER TABLE channel_members/);
  // 基线不能重建 channels；实际建号验证系统群触发器仍可用，而不只检查对象存在。
  db.exec("INSERT INTO users (username, password_hash, password_salt, display_name) VALUES ('baseline-probe', 'hash', 'salt', 'Baseline probe');");
  assert.equal(rows(db, "SELECT COUNT(*) AS count FROM channel_members cm JOIN users u ON u.id = cm.user_id JOIN channels c ON c.id = cm.channel_id WHERE u.username = 'baseline-probe' AND c.name = 'general'")[0].count, 1);
  assert.equal((await inspectSchema(async (sql) => rows(db, sql), manifest)).status, "ok");
  const namespace = (service) => ({
    idFromName: (name) => name,
    get: () => ({ fetch: async () => Response.json({ ok: true, service }) })
  });
  const result = await runSystemCheck({
    DB: { prepare: (sql) => ({ all: async () => ({ results: rows(db, sql) }) }) },
    SESSIONS: { get: async () => null }, FILES: { list: async () => ({ objects: [] }) },
    CHANNEL_ROOM: namespace('ChannelRoom'), USER_INBOX: namespace('UserInbox'), SCHEDULER: namespace('Scheduler'),
    INSTANCE_BRIDGE: namespace('InstanceBridge'),
    VOICE_CALL: namespace('VoiceCall'),
    TELEGRAM_NOTIFICATIONS: namespace('TelegramNotifications'),
    EDGECHAT_ENCRYPTION_KEYRING: 'presence-only'
  });
  assert.equal(result.status, 'ok');
  assert.ok(result.checks.every((check) => check.status === 'ok'));
  db.exec('DROP INDEX idx_messages_reply_attention; DROP TRIGGER clear_pin_after_message_soft_delete; DROP TRIGGER protect_last_super_update; DROP TRIGGER protect_last_super_delete; ALTER TABLE users DROP COLUMN disabled_until;');
  const drift = await inspectSchema(async (sql) => rows(db, sql), manifest);
  assert.equal(drift.status, 'drift');
  assert.deepEqual(drift.missingArtifacts.sort(), ['column:users.disabled_until', 'index:idx_messages_reply_attention', 'trigger:clear_pin_after_message_soft_delete', 'trigger:protect_last_super_delete', 'trigger:protect_last_super_update']);
  db.close();
});

test("retired migration is optional but its historical checksum is still verified", async () => {
  const manifest = await generateSchemaManifest();
  const artifacts = new Set([...manifest.artifacts, `table:${D1_MIGRATION_LEDGER}`]);
  const applied = new Map(manifest.migrations.map((migration) => [migration.id, migration.checksum]));
  assert.equal(assessSchema(manifest, artifacts, applied).status, 'ok');
  const retired = manifest.retiredMigrations[0];
  applied.set(retired.id, retired.checksum);
  assert.equal(assessSchema(manifest, artifacts, applied).status, 'ok');
  applied.set(retired.id, 'tampered');
  assert.equal(assessSchema(manifest, artifacts, applied).status, 'checksum_mismatch');
  applied.set('2099-01-01-unknown', 'unknown');
  assert.deepEqual(assessSchema(manifest, artifacts, applied).unknownMigrations, ['2099-01-01-unknown']);
});

test("schema contract identifies missing ledger, migration, ahead, and checksum states", () => {
  const manifest = { version: "1", schemaHash: "h", artifacts: ["table:a", "table:edgechat_schema_migrations", "column:a.id"], migrations: [{ id: "m1", checksum: "good", compatibleChecksums: [] }] };
  const missingLedger = assessSchema(manifest, new Set(["table:a", "column:a.id"]), new Map());
  assert.equal(missingLedger.ledgerPresent, false);
  assert.equal(missingLedger.status, "missing_migrations");
  assert.equal(assessSchema(manifest, new Set(["table:a", "table:edgechat_schema_migrations", "column:a.id"]), new Map()).status, "untracked");
  assert.equal(assessSchema(manifest, new Set(["table:a", "table:edgechat_schema_migrations", "column:a.id"]), new Map([["m1", "good"]])).status, "ok");
  assert.equal(assessSchema(manifest, new Set(["table:a", "table:edgechat_schema_migrations", "column:a.id"]), new Map([["other", "x"]])).status, "ahead");
  assert.equal(assessSchema(manifest, new Set(["table:a", "table:edgechat_schema_migrations", "column:a.id"]), new Map([["m1", "bad"]])).status, "checksum_mismatch");
});

test("demo maintenance report uses the generated manifest and matches the production check ids", () => {
  const report = demoMaintenanceReport();
  const project = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(report.demo, true);
  assert.equal(report.status, "ok");
  assert.equal(report.version, `v${project.version}`);
  assert.equal(report.expectedMigration, D1_MIGRATIONS.at(-1).id);
  assert.deepEqual(report.checks.map((check) => check.id), ["d1", "schema", "sessions", "files", "channelRoom", "userInbox", "scheduler", "instanceBridge", "voiceCall", "telegramNotifications", "environment"]);
  assert.equal(report.checks.find((check) => check.id === "schema").schema.status, "ok");
});

test("Deploy Worker verifies D1 after apply and before worker deploy", () => {
  const workflow = readFileSync(new URL("../.github/workflows/deploy-worker.yml", import.meta.url), "utf8");
  assert.ok(workflow.indexOf("name: Apply D1 migrations") < workflow.indexOf("name: Verify D1 schema contract"));
  assert.ok(workflow.indexOf("name: Verify D1 schema contract") < workflow.indexOf("name: Deploy worker"));
  assert.match(workflow, /prepare-d1-migrations\.mjs --verify/);
});
