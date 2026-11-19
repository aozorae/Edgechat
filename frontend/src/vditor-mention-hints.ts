import type { MentionUser } from "./mentions.ts";

function escapeHtml(value: string) {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#039;");
}

export function buildVditorMentionHints(candidates: MentionUser[], query: string) {
	const normalizedQuery = query.toLocaleLowerCase();
	return candidates
		.filter((candidate) =>
			[candidate.username, candidate.displayName].some((value) =>
				(value || "").toLocaleLowerCase().includes(normalizedQuery),
			),
		)
		.slice(0, 8)
		.map((candidate) => ({
			html: `<strong>@${escapeHtml(candidate.username)}</strong> <span>${escapeHtml(candidate.displayName || "")}</span>`,
			// Vditor 的 value 是 HTML 而非文本；存量用户名也必须在这个输出边界转义。
			value: `@${escapeHtml(candidate.username)}`,
		}));
}
