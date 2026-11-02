#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { D1_MIGRATIONS } from "./d1-migration-manifest.mjs";
import { buildD1MigrationPlan } from "./d1-migration-plan.mjs";
import { D1_REPAIRS } from "./d1-repair-manifest.mjs";
import { collectSchemaArtifacts, collectAppliedMigrations, inspectSchema, schemaTables } from "../../worker/src/maintenance/schema-contract.ts";
import { generateSchemaManifest } from "./generate-schema-manifest.mjs";
import { verifyAdminBootstrap } from "./generate-admin-bootstrap-sql.mjs";
import { createD1Query } from "./cloudflare-d1.ts";

const OUTPUT_PATH = ".tmp/edgechat-d1-migrations.sql";
const queryD1 = createD1Query();
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function main() {
  if (process.argv.includes("--verify-admin")) {
    await verifyAdminBootstrap(queryD1);
    console.log("Active super administrator verified.");
    return;
  }
  const manifest = await generateSchemaManifest();
  if (process.argv.includes("--verify")) {
    const result = await inspectSchema(queryD1, manifest);
    if (result.status !== "ok") {
      throw new Error(`D1 schema verification failed: ${JSON.stringify(result)}`);
    }
    console.log(`D1 schema verified: ${result.expectedMigration}`);
    return;
  }
  // D1 的内部表可出现在 sqlite_master，但不允许读取列；只查询应用 manifest 中的表。
  const artifacts = await collectSchemaArtifacts(queryD1, schemaTables(manifest));
  const appliedMigrations = await collectAppliedMigrations(queryD1, artifacts);
  const plan = await buildD1MigrationPlan({
    migrations: D1_MIGRATIONS,
    repairs: D1_REPAIRS,
    appliedMigrations,
    artifacts,
    readSql(file) {
      return readFileSync(resolve(repositoryRoot, file), "utf8");
    },
  });
  const outputFile = resolve(repositoryRoot, OUTPUT_PATH);
  mkdirSync(dirname(outputFile), { recursive: true });
  writeFileSync(outputFile, plan.sql, "utf8");

  for (const decision of plan.decisions) {
    console.log(`[d1-migration] ${decision.id}: ${decision.action}`);
  }
  console.log(`D1 migration plan written to ${OUTPUT_PATH}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
