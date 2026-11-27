import type { MessageAttachmentView } from "./message-view.ts";

const MIME_EXTENSIONS = new Map([
	["application/zip", "zip"],
	["application/x-zip-compressed", "zip"],
	["application/x-7z-compressed", "7z"],
	["application/vnd.rar", "rar"],
	["application/x-rar-compressed", "rar"],
	["application/x-tar", "tar"],
	["application/gzip", "gz"],
	["application/x-gzip", "gz"],
	["application/pdf", "pdf"],
	["application/msword", "doc"],
	["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"],
	["application/vnd.ms-excel", "xls"],
	["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"],
	["application/vnd.ms-powerpoint", "ppt"],
	["application/vnd.openxmlformats-officedocument.presentationml.presentation", "pptx"],
	["text/plain", "txt"],
	["text/markdown", "md"],
	["text/csv", "csv"],
]);

const FILE_GROUPS = {
	archive: new Set(["zip", "rar", "7z", "tar", "tar.gz", "tar.bz2", "tar.xz", "gz", "tgz", "bz2", "xz"]),
	document: new Set(["doc", "docx", "odt", "rtf", "txt", "md", "pages"]),
	spreadsheet: new Set(["xls", "xlsx", "ods", "csv", "tsv", "numbers"]),
	presentation: new Set(["ppt", "pptx", "odp", "key"]),
	pdf: new Set(["pdf"]),
} as const;

export function describeFileAttachment(attachment: MessageAttachmentView) {
	// 文件名是用户看到的格式。没有后缀的历史附件再用 MIME 补足类型。
	const name = attachment.name?.trim().toLowerCase() ?? "";
	const mime = attachment.type?.split(";", 1)[0].trim().toLowerCase() ?? "";
	const extension = name.match(/^.+?\.(tar\.(?:gz|bz2|xz)|[a-z0-9]{1,16})$/)?.[1] ?? MIME_EXTENSIONS.get(mime);
	const group = (Object.keys(FILE_GROUPS) as (keyof typeof FILE_GROUPS)[])
		.find((key) => extension && FILE_GROUPS[key].has(extension)) ?? "file";
	return { group, format: extension?.toUpperCase() };
}
