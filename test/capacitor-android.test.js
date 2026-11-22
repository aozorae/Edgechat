import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
	resolveConfiguredServerOrigin,
	resolveServerUrl,
} from "../frontend/src/capacitor-platform.ts";
import { readLoginSubmission } from "../frontend/src/login-submission.ts";

const read = (path) =>
	readFileSync(new URL(path, import.meta.url), "utf8").replaceAll("\r\n", "\n");

test("Capacitor server origin is normalized and web URLs stay relative", () => {
	assert.equal(
		resolveConfiguredServerOrigin("https://chat.example.com/install/path"),
		"https://chat.example.com",
	);
	assert.equal(resolveServerUrl("/api/health"), "/api/health");
	assert.throws(
		() => resolveConfiguredServerOrigin("http://chat.example.com"),
		/native_server_https_required/,
	);
});

test("login submission reads the values currently displayed by Android WebView", () => {
	const values = new Map([
		["serverOrigin", " https://chat.example.com/path "],
		["username", " admin "],
		["password", "top-secret"],
	]);
	assert.deepEqual(
		readLoginSubmission({ get: (name) => values.get(name) ?? null }),
		{
			serverOrigin: "https://chat.example.com/path",
			credentials: { username: "admin", password: "top-secret" },
		},
	);
});

test("Capacitor Android CI builds an independent tested APK", () => {
	const workflow = read("../.github/workflows/capacitor-android-ci.yml");
	const gradleRunner = read("../capacitor/scripts/run-gradle.mjs");
	const appBuild = read("../capacitor/android/app/build.gradle");
	const viteConfig = read("../frontend/vite.capacitor.config.js");
	assert.match(workflow, /actions\/setup-node@v5/);
	assert.match(workflow, /node-version: "24"/);
	assert.match(workflow, /android-actions\/setup-android@v3[\s\S]*packages: platform-tools/);
	assert.match(workflow, /gradle\/actions\/wrapper-validation@v4/);
	assert.match(workflow, /npm run build:capacitor/);
	assert.match(workflow, /edgechat-capacitor-debug/);
	assert.match(
		workflow,
		/capacitor\/android\/app\/build\/outputs\/apk\/debug\/app-debug\.apk/,
	);
	for (const task of [
		":app:testDebugUnitTest",
		":app:lintDebug",
		":app:assembleDebug",
		":app:assembleDebugAndroidTest",
	]) {
		assert.match(gradleRunner, new RegExp(task.replaceAll(":", "\\:")));
	}
	assert.match(gradleRunner, /-Dorg\.gradle\.java\.home=/);
	assert.match(appBuild, /rootProject\.file\('\.\.\/\.\.\/package\.json'\)/);
	assert.match(viteConfig, /target: 'es2020'/);
});

test("Capacitor keeps its published Android application ID", () => {
	const config = JSON.parse(read("../capacitor/capacitor.config.json"));
	const appBuild = read("../capacitor/android/app/build.gradle");
	assert.equal(config.appId, "com.aozorae.edgechat.web");
	assert.match(appBuild, /applicationId "com\.aozorae\.edgechat\.web"/);
});

test("Capacitor asks for a server at sign-in and registers the Kotlin bridge", () => {
	const loginPage = read("../frontend/src/pages/LoginPage.vue");
	const settingsPage = read("../frontend/src/pages/SettingsPage.vue");
	const groupSettings = read(
		"../frontend/src/components/chat/GroupSettingsDialog.vue",
	);
	const mainActivity = read(
		"../capacitor/android/app/src/main/java/com/aozorae/edgechat/web/MainActivity.kt",
	);
	const plugin = read(
		"../capacitor/android/app/src/main/java/com/aozorae/edgechat/web/nativebridge/EdgeChatNativePlugin.kt",
	);
	assert.match(loginPage, /v-if="isCapacitorAndroid"/);
	assert.match(loginPage, /new FormData\(event\.currentTarget\)/);
	assert.match(loginPage, /store\.configureNativeServer\(serverOrigin\)/);
	assert.match(loginPage, /store\.login\(credentials\)/);
	for (const name of ["serverOrigin", "username", "password"]) {
		assert.match(loginPage, new RegExp(`name="${name}"`));
	}
	assert.match(settingsPage, /pickNativeFile\('image\/\*'\)/);
	assert.match(groupSettings, /pickNativeFile\('image\/\*'\)/);
	assert.match(mainActivity, /registerPlugin\(EdgeChatNativePlugin::class\.java\)/);
	const main = read("../frontend/src/main.js");
	const chatPage = read("../frontend/src/pages/ChatPage.vue");
	assert.match(main, /queueNativeRoomTarget\(target\)/);
	assert.match(chatPage, /consumeNativeRoomTarget\(\)/);
	assert.match(chatPage, /nativeRoomNavigationReady = true/);
	for (const method of ["pickFile", "showNotification", "openExternal"]) {
		assert.match(plugin, new RegExp(`fun ${method}\\(`));
	}
});
