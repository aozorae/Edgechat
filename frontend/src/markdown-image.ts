export function parseMarkdownImageUrl(value: string) {
	try {
		const url = new URL(value);
		return url.protocol === "https:" && !url.username && !url.password ? url : null;
	} catch {
		return null;
	}
}
