import DOMPurify from "dompurify";

type VditorLute = {
	Md2VditorDOM(markdown: string): string;
	SpinVditorDOM(html: string): string;
};

function escapeImageLabel(value: string) {
	return value.replaceAll("\\", "\\\\").replaceAll("]", "\\]");
}

function escapeImageDestination(value: string) {
	return value.replaceAll("\\", "\\\\").replaceAll(")", "\\)");
}

function imageMarkdown(image: HTMLImageElement) {
	const label = escapeImageLabel(image.alt || "图片");
	const source = image.getAttribute("src") || image.getAttribute("data-src") || "";
	return source ? `![${label}](${escapeImageDestination(source)})` : label;
}

function replaceHtmlBlocksWithCode(root: DocumentFragment) {
	for (const htmlBlock of root.querySelectorAll<HTMLElement>(
		'.vditor-wysiwyg__block[data-type="html-block"]',
	)) {
		const isLastBlock = !htmlBlock.nextElementSibling;
		const source =
			htmlBlock.querySelector("pre:not(.vditor-wysiwyg__preview) code")?.textContent || "";
		const codeBlock = document.createElement("div");
		codeBlock.className = "vditor-wysiwyg__block";
		codeBlock.dataset.type = "code-block";
		codeBlock.dataset.block = htmlBlock.dataset.block || "0";
		codeBlock.dataset.marker = "```";

		const pre = document.createElement("pre");
		pre.className = "vditor-wysiwyg__pre";
		const code = document.createElement("code");
		code.className = "language-html";
		code.textContent = source.endsWith("\n") ? source : `${source}\n`;
		pre.appendChild(code);
		codeBlock.appendChild(pre);
		htmlBlock.replaceWith(codeBlock);
		if (isLastBlock) {
			// 末尾空段让光标离开整体代码块，避免用户继续输入时把后续正文并入 HTML 源码。
			const trailingParagraph = document.createElement("p");
			trailingParagraph.dataset.block = "0";
			trailingParagraph.appendChild(document.createElement("br"));
			codeBlock.after(trailingParagraph);
		}
	}
}

function removeRemoteContentBeforeMount(html: string) {
	const template = document.createElement("template");
	template.innerHTML = html;
	replaceHtmlBlocksWithCode(template.content);

	// 未开放的动态预览只显示源码，避免其后续渲染器加载第三方脚本或媒体。
	for (const preview of template.content.querySelectorAll(".vditor-wysiwyg__preview")) {
		const source = preview.parentElement?.querySelector("pre:not(.vditor-wysiwyg__preview) code");
		preview.replaceChildren(document.createTextNode(source?.textContent || ""));
	}
	for (const image of template.content.querySelectorAll("img")) {
		image.replaceWith(document.createTextNode(imageMarkdown(image)));
	}
	for (const element of template.content.querySelectorAll(
		"iframe, object, embed, video, audio, source, track, script, link, meta",
	)) {
		element.remove();
	}

	// 去除媒体不等于净化 HTML：只允许编辑器所需的结构和属性，拒绝事件、样式、
	// SVG/MathML 与危险链接协议；保留 data-* 和编辑属性以维持 Lute 的回读能力。
	return DOMPurify.sanitize(template.innerHTML, {
		ALLOWED_TAGS: [
			"p", "div", "span", "br", "wbr", "strong", "b", "em", "i", "s", "del", "strike",
			"u", "a", "blockquote", "pre", "code", "ul", "ol", "li", "hr",
			"h1", "h2", "h3", "h4", "h5", "h6", "table", "thead", "tbody", "tr", "th", "td", "input",
		],
		ALLOWED_ATTR: [
			"class", "href", "title", "contenteditable", "spellcheck",
			"type", "checked", "value", "align", "colspan", "rowspan", "start",
		],
		ALLOW_DATA_ATTR: true,
	});
}

export function installVditorContentSafety(lute: VditorLute) {
	const renderMarkdown = lute.Md2VditorDOM.bind(lute);
	const normalizeEditorDom = lute.SpinVditorDOM.bind(lute);
	// Vditor 没有覆盖 WYSIWYG 全部写入路径的图片禁用开关，因此在其统一转换出口前净化。
	lute.Md2VditorDOM = (markdown) => removeRemoteContentBeforeMount(renderMarkdown(markdown));
	lute.SpinVditorDOM = (html) => removeRemoteContentBeforeMount(normalizeEditorDom(html));
}
