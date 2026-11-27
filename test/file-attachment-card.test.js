import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { describeFileAttachment } from "../frontend/src/components/chat/file-attachment.ts";
import { validateUpload } from "../worker/src/api/upload.js";

test("file cards choose icons and preserve the displayed format of named attachments", () => {
	assert.deepEqual(describeFileAttachment({ name: "相片备份.ZIP", type: "application/octet-stream" }), { group: "archive", format: "ZIP" });
	assert.deepEqual(describeFileAttachment({ name: "合同.DOCX" }), { group: "document", format: "DOCX" });
	assert.deepEqual(describeFileAttachment({ name: "source.tar.gz" }), { group: "archive", format: "TAR.GZ" });
	assert.deepEqual(describeFileAttachment({ name: "预算.xlsx" }), { group: "spreadsheet", format: "XLSX" });
	assert.deepEqual(describeFileAttachment({ name: "模型.stl" }), { group: "file", format: "STL" });
});

test("old attachments without a usable suffix fall back to their MIME", () => {
	assert.deepEqual(describeFileAttachment({ name: "备份", type: "Application/X-Zip-Compressed; charset=utf-8" }), { group: "archive", format: "ZIP" });
	assert.deepEqual(describeFileAttachment({ type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), { group: "document", format: "DOCX" });
	assert.deepEqual(describeFileAttachment({ name: ".env", type: "application/octet-stream" }), { group: "file", format: undefined });
});

test("the Actions template accepts Office and archive uploads through the existing policy", () => {
	const template = readFileSync(new URL("../wrangler.example.toml", import.meta.url), "utf8");
	const allowed = template.match(/^ALLOWED_FILE_TYPES = "([^"]*)"/m)[1];
	const env = { ALLOWED_FILE_TYPES: allowed };
	for (const type of ["application/zip", "application/x-zip-compressed", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]) {
		assert.doesNotThrow(() => validateUpload(env, { type, size: 1024 }, 2048));
	}
	assert.throws(() => validateUpload(env, { type: "text/html", size: 1024 }, 2048), /不允许上传/);
	assert.throws(() => validateUpload({ ALLOWED_FILE_TYPES: "image/" }, { type: "application/zip", size: 1024 }, 2048), /不允许上传/);
});
