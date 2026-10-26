/**
 * 期一增项：笨笨文本人格与上下文组装。
 * 提示词随代码走（期一不开放后台编辑）；只用简体中文、禁 emoji、不装人类。
 */
export const BENBEN_SYSTEM_PROMPT = [
  "你叫笨笨，是用户手机里的一对一陪伴聊天伙伴。",
  "说话温柔、自然、口语化，每次回复一到三句话，用简体中文。",
  "不要自称“助手”“AI 模型”或“机器人”，也不要说“作为 AI”。",
  "不用 emoji，不长篇大论，不列条目、不做客服式总结。",
  "先接住对方的情绪再接话，像熟悉的朋友那样说话；对方只是打招呼就轻松回应。",
  "不编造你们之间没发生过的经历，不确定的事就坦白说不记得。"
].join("\n");

const DEFAULT_MAX_CONTENT_CHARS = 400;
const DEFAULT_MAX_MESSAGES = 12;

/**
 * 把房间历史消息转成大模型 messages。
 * 笨笨自己发的 → assistant，其它本地用户 → user；纯附件消息（无文字）跳过。
 * TASK-133：recapPrompt（上次会话摘要，来自 /pi/api/session/opening 的 session_recap_prompt）
 * 按契约 C3 顺序拼在 system prompt 里：人设 → 摘要 → "不编造"补句；为空时严格等于纯人设（C5）。
 */
export function buildChatMessages({
  history = [],
  botId,
  maxContentChars = DEFAULT_MAX_CONTENT_CHARS,
  maxMessages = DEFAULT_MAX_MESSAGES,
  recapPrompt = ""
} = {}) {
  const bound = Math.min(Math.max(Number(maxMessages) || DEFAULT_MAX_MESSAGES, 1), 30);
  const picked = history.slice(-bound);
  const systemParts = [BENBEN_SYSTEM_PROMPT];
  const recap = String(recapPrompt || "").trim();
  if (recap) {
    systemParts.push(recap);
    systemParts.push("以上是上次聊天的摘要，可以自然地接着聊；摘要里没有的细节不要编，不确定就说记不清。");
  }
  const messages = [{ role: "system", content: systemParts.join("\n\n") }];
  for (const message of picked) {
    const content = String(message?.content || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, maxContentChars);
    if (!content) continue;
    messages.push({
      role: Number(message?.sender?.id) === Number(botId) ? "assistant" : "user",
      content
    });
  }
  return messages;
}
