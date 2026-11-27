export function formatByteSize(value: number) {
	const bytes = Math.max(0, Number(value) || 0);
	if (bytes < 1024) return `${bytes} B`;

	const units = ["KiB", "MiB", "GiB", "TiB"];
	let size = bytes / 1024;
	let unitIndex = 0;
	while (size >= 1024 && unitIndex < units.length - 1) {
		size /= 1024;
		unitIndex += 1;
	}
	const fractionDigits = size >= 100 ? 0 : size >= 10 ? 1 : 2;
	return `${size.toFixed(fractionDigits)} ${units[unitIndex]}`;
}
