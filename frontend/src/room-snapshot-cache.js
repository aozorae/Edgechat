// Per-chat-page LRU: never persisted, and cleared when the login changes.
export const ROOM_SNAPSHOT_LIMITS = Object.freeze({
	rooms: 8,
	messages: 100,
	bytes: 2 * 1024 * 1024,
});

export function createRoomSnapshotCache() {
	const entries = new Map();
	let totalBytes = 0;

	function remove(key) {
		const entry = entries.get(key);
		if (entry) totalBytes -= entry.bytes;
		entries.delete(key);
	}

	return {
		get(key) {
			const entry = entries.get(key);
			if (!entry) return null;
			entries.delete(key);
			entries.set(key, entry);
			return JSON.parse(entry.json);
		},
		set(key, { messages, pinnedMessage }) {
			remove(key);
			const json = JSON.stringify({
				messages: messages.slice(-ROOM_SNAPSHOT_LIMITS.messages),
				pinnedMessage,
			});
			const bytes = new TextEncoder().encode(json).byteLength;
			if (bytes > ROOM_SNAPSHOT_LIMITS.bytes) return;
			entries.set(key, { json, bytes });
			totalBytes += bytes;
			while (entries.size > ROOM_SNAPSHOT_LIMITS.rooms || totalBytes > ROOM_SNAPSHOT_LIMITS.bytes) {
				remove(entries.keys().next().value);
			}
		},
		delete: remove,
		clear() {
			entries.clear();
			totalBytes = 0;
		},
	};
}
