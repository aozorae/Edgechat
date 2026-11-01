import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import initSqlJs from "sql.js";
import { createD1Adapter } from "./support/d1.js";
import { registerGreetRoutes } from "../worker/src/api/greet.js";
import { listVisibleUsers } from "../worker/src/data/social.js";

const SQL = await initSqlJs({
  locateFile(file) {
    return fileURLToPath(new URL(`../node_modules/sql.js/dist/${file}`, import.meta.url));
  },
});
const schema = readFileSync(new URL("../worker/schema.sql", import.meta.url), "utf8");

function freshDb() {
  const db = new SQL.Database();
  db.exec(schema);
  return db;
}

// [打招呼制 2026-11-01] 端到端：陌生→打招呼→点头→互见可聊；拒答与边界
test("陌生→打招呼→点头→互见可聊；拒答不影响他人", async () => {
  const db = freshDb();
  db.exec(`
    INSERT INTO users (id, username, display_name, password_hash, password_salt)
    VALUES (1, 'zhang', '张三', 'h', 's'), (2, 'li', '李四', 'h', 's'),
           (3, 'wang', '王五', 'h', 's'), (4, 'benben', '笨笨', 'h', 's')
  `);
  const env = { DB: createD1Adapter(db) };
  const mk = (uid) => {
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("session", { userId: uid }); await next(); });
    registerGreetRoutes(app);
    return (path, method = "GET", payload) => app.fetch(new Request(`https://t.com${path}`, {
      method, headers: { "content-type": "application/json" },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    }), env);
  };
  const zhang = mk(1);
  const li = mk(2);

  // ① 陌生态：目录只见笨笨（官方号），见不到 li/wang
  let visible = await listVisibleUsers(env.DB, 1);
  assert.deepEqual(visible.map((u) => u.username), ["benben"]);

  // ② 打招呼：成功；重复 409；官方号 400；不存在 404；给自己 400
  assert.equal((await zhang("/api/greet", "POST", { to: "li", message: "老同学？" })).status, 200);
  assert.equal((await zhang("/api/greet", "POST", { to: "li", message: "再发" })).status, 409);
  assert.equal((await zhang("/api/greet", "POST", { to: "benben" })).status, 400);
  assert.equal((await zhang("/api/greet", "POST", { to: "nobody" })).status, 404);
  assert.equal((await zhang("/api/greet", "POST", { to: "zhang" })).status, 400);

  // ③ 李四收到待处理；婉拒后张三目录仍只见笨笨
  let inbox = await (await li("/api/greet/requests")).json();
  assert.equal(inbox.incoming.length, 1);
  assert.equal(inbox.incoming[0].from.username, "zhang");
  assert.equal(
    (await li("/api/greet/respond", "POST", { id: inbox.incoming[0].id, accept: false })).status,
    200
  );
  visible = await listVisibleUsers(env.DB, 1);
  assert.deepEqual(visible.map((u) => u.username), ["benben"]);

  // ④ 再打招呼→点头→双方目录互见，第三者仍不可见
  await zhang("/api/greet", "POST", { to: "li", message: "是我，张三" });
  inbox = await (await li("/api/greet/requests")).json();
  await li("/api/greet/respond", "POST", { id: inbox.incoming[0].id, accept: true });
  assert.deepEqual((await listVisibleUsers(env.DB, 1)).map((u) => u.username).sort(), ["benben", "li"]);
  assert.deepEqual((await listVisibleUsers(env.DB, 2)).map((u) => u.username).sort(), ["benben", "zhang"]);
  assert.deepEqual((await listVisibleUsers(env.DB, 3)).map((u) => u.username), ["benben"]);
});
