import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";

// 挂载真实编辑器和消息正文，图床请求由测试拦截并返回图片。
const fixture = `<!doctype html><html><body><div id="app"></div><div id="message"></div><script type="module">
import { createApp, h, ref } from "vue";
import Editor from "/src/components/chat/VditorComposerEditor.vue";
import MessageMarkdown from "/src/components/chat/MessageMarkdown.vue";
import { loadVditorRuntime } from "/src/vditor-runtime.ts";
import { installVditorContentSafety } from "/src/vditor-content-safety.ts";
const runtime = await loadVditorRuntime("en");
window.safety = installVditorContentSafety;
window.showMessage = (content) => createApp({ render: () => h(MessageMarkdown, { content }) }).mount("#message");
window.mountEditor = (username, displayName = username) => {
  window.editorApp?.unmount();
  window.editorReady = false;
  const value = ref("");
  window.editorApp = createApp({
    setup: () => () => h(Editor, {
      runtime, modelValue: value.value, mentionCandidates: [{ id: 1, username, displayName }],
      placeholder: "Local security check",
      "onUpdate:modelValue": (next) => { value.value = next; window.markdown = next; },
      onReady: () => { window.editorReady = true; },
    }),
  });
  window.editorApp.mount("#app");
};
window.fixtureReady = true;
</script></body></html>`;

const server = await createServer({
  configFile: "frontend/vite.config.js",
  server: { host: "127.0.0.1", port: 0, open: false },
  plugins: [{
    name: "local-security-fixture",
    configureServer(vite) {
      vite.middlewares.use("/__security-check", async (_req, res) => {
        res.setHeader("Content-Type", "text/html");
        res.end(await vite.transformIndexHtml("/__security-check", fixture));
      });
    },
  }],
});
let browser;
try {
  await server.listen();
  const origin = server.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  const externalRequests = [];
  const imageRequests = [];
  const imageUrl = "https://images.example/diagram(1)?v=2&token=abc";
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", async (route) => {
    if (route.request().url() === imageUrl) {
      imageRequests.push(route.request().headers());
      await route.fulfill({ contentType: "image/gif", body: Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64") });
    } else if (new URL(route.request().url()).origin === new URL(origin).origin) await route.continue();
    else { externalRequests.push(route.request().url()); await route.abort(); }
  });
  await page.goto(`${origin}__security-check`);
  await page.waitForFunction(() => window.fixtureReady);
  for (const [username, selection] of [
    ['<b data-probe="username">marker</b>', "Enter"],
    ['<img src="https://invalid.example/probe" onerror="void 0">', "click"],
    ["&lt;b&gt;marker&lt;/b&gt;", "Enter"],
    ["用户_1", "click"],
    ["alice", "Enter"],
  ]) {
    await page.evaluate((name) => window.mountEditor(name, '<b data-probe="display">display</b>'), username);
    await page.waitForFunction(() => window.editorReady);
    const editor = page.locator(".vditor-wysiwyg [contenteditable=true]").first();
    await editor.click();
    await page.keyboard.type("@");
    const hint = page.locator('.vditor-hint button[data-value^="%40"]').first();
    await hint.waitFor({ state: "visible" });
    assert.ok((await hint.textContent()).includes(username));
    assert.ok((await hint.textContent()).includes('<b data-probe="display">display</b>'));
    assert.equal(await hint.locator("[data-probe],img,svg,script").count(), 0);
    if (selection === "click") await hint.click();
    else await page.keyboard.press("Enter");
    await page.waitForFunction((name) =>
      document.querySelector(".vditor-wysiwyg [contenteditable=true]").textContent.replaceAll("\u200b", "").includes(`@${name}`), username,
    { timeout: 5000 }).catch(async (error) => {
      throw new Error(`Mention did not remain text: ${JSON.stringify({ username, html: await editor.innerHTML(), errors })}`, { cause: error });
    });
    assert.equal(await editor.locator("[data-probe],img,svg,script").count(), 0);
  }
  // 净化器单独覆盖事件属性、危险协议、主动内容，同时保留常用编辑结构。
  const sanitized = await page.evaluate(() => {
    const lute = { Md2VditorDOM: (value) => value, SpinVditorDOM: (value) => value };
    window.safety(lute);
    const dirty = '<p data-block="0" onclick="void 0" style="color:red">text'
      + '<a href="javascript:void 0">link</a><svg><a>svg</a></svg><form>form</form></p>'
      + '<pre><code class="language-js">code</code></pre><ul><li>item</li></ul>'
      + '<table><tbody><tr><td>cell</td></tr></tbody></table>';
    return [lute.Md2VditorDOM(dirty), lute.SpinVditorDOM(dirty)];
  });
  for (const html of sanitized) {
    assert.doesNotMatch(html, /onclick|style=|javascript:|<svg|<form/);
    assert.match(html, /data-block="0"/);
    for (const tag of ["pre", "code", "ul", "li", "table", "td"]) assert.ok(html.includes(`<${tag}`));
  }
  // 实际 Lute 的 Markdown -> 编辑 DOM -> Markdown 回读仍保留常见格式。
  const roundtrip = await page.evaluate(() => {
    const lute = window.Lute.New();
    window.safety(lute);
    const markdown = '**bold** *italic* ~~strike~~\n\n- item\n- [x] done\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```js\nconst x = 1;\n```\n\n[link](https://example.com)\n\n<div>raw HTML</div>';
    const html = lute.Md2VditorDOM(markdown);
    return { html, markdown: lute.VditorDOM2Md(html) };
  });
  for (const text of ["**bold**", "*italic*", "~~strike~~", "item", "[X] done", "const x = 1", "https://example.com", "```html", "<div>raw HTML</div>"]) {
    assert.ok(roundtrip.markdown.includes(text), text);
  }

  await page.evaluate(() => window.mountEditor("alice"));
  await page.waitForFunction(() => window.editorReady);
  const imageButton = page.locator('.vditor-toolbar button[data-type="image-link"]');
  page.once("dialog", (dialog) => dialog.accept("data:image/gif,invalid"));
  await imageButton.click();
  await page.getByRole("alert").waitFor();
  page.once("dialog", (dialog) => dialog.accept(imageUrl));
  await imageButton.click();
  const editorImage = page.locator(".vditor-wysiwyg img");
  await page.waitForFunction(() => document.querySelector(".vditor-wysiwyg img")?.naturalWidth === 1);
  assert.equal(await editorImage.getAttribute("referrerpolicy"), "no-referrer");
  await page.evaluate(() => window.showMessage(window.markdown));
  await page.locator("#message img").scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelector("#message img")?.naturalWidth === 1);
  assert.equal(await page.locator("#message img").getAttribute("loading"), "lazy");
  assert.equal(await page.locator("#message img").getAttribute("referrerpolicy"), "no-referrer");
  assert.ok(imageRequests.length >= 1);
  assert.ok(imageRequests.every((headers) => !headers.referer));
  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, []);
  console.log("Vditor security: mention selection, sanitizer exits, Markdown roundtrip and HTTPS image rendering passed.");
} finally {
  await browser?.close();
  await server.close();
}
