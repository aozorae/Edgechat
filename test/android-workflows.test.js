import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8").replaceAll("\r\n", "\n");
const ci = read("../.github/workflows/capacitor-android-ci.yml");
const release = read("../.github/workflows/android-release.yml");
const worker = read("../.github/workflows/deploy-worker.yml");
const demo = read("../.github/workflows/deploy-demo.yml");

test("Android release signs and publishes the primary Capacitor client", () => {
	for (const secret of [
		"ANDROID_KEYSTORE_BASE64",
		"ANDROID_KEYSTORE_PASSWORD",
		"ANDROID_KEY_ALIAS",
		"ANDROID_KEY_PASSWORD",
	]) {
		assert.match(release, new RegExp(`secrets\\.${secret}`));
	}
	assert.match(release, /actions\/setup-node@v5/);
	assert.match(release, /node-version: "24"/);
	assert.match(release, /java-version: "21"/);
	assert.match(release, /npm run capacitor:sync/);
	assert.match(release, /require\('\.\/package\.json'\)\.version/);
	assert.match(release, /assembleDebugAndroidTest/);
	assert.match(release, /:app:assembleRelease :app:bundleRelease/);
	assert.match(release, /capacitor\/android\/app\/build\/outputs\/apk\/release/);
	assert.doesNotMatch(release, /cp android\/app\/build\/outputs\/apk\/release/);
	assert.match(release, /sha256sum \*\.apk \*\.aab > SHA256SUMS\.txt/);
	assert.match(release, /jarsigner -verify -verbose -certs/);
	assert.doesNotMatch(release, /jarsigner -verify -strict/);
	assert.match(release, /gh release create/);
});

test("Worker ignores Android-only paths and JavaScript workflows use Node 24", () => {
	assert.match(worker, /paths:/);
	assert.doesNotMatch(worker, /android\/\*\*/);
	for (const workflow of [worker, demo, ci, release]) {
		assert.match(workflow, /actions\/checkout@v5/);
		assert.match(workflow, /actions\/setup-node@v5/);
		assert.match(workflow, /node-version: "24"/);
	}
});
