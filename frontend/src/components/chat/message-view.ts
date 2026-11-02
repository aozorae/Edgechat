import type { MessageMention } from "../../mentions.ts";

// 只描述消息展示需要的字段；传输、发送和已读状态仍由房间 composable 负责。
export type MessageSender = {
	id: number | string;
	kind?: string;
	displayName: string;
	avatarUrl?: string;
	source?: string;
	sourceInstance?: string;
	isAdmin?: boolean;
	isDisabled?: boolean;
	disabledUntil?: string | null;
};

export type MessageAttachmentView = {
	key?: string;
	url?: string;
	name?: string;
	type?: string;
	kind?: string;
	size?: number;
	durationMs?: number;
	waveform?: number[];
};

export type MessageView = {
	id: number | string;
	sender: MessageSender;
	clientMessageId?: string;
	sendStatus?: "pending" | "failed";
	sendError?: string;
	content?: string;
	createdAt?: string;
	mentions?: MessageMention[];
	attachment?: MessageAttachmentView | null;
	replyToMessageId?: number | string | null;
	replyTo?: {
		id: number | string;
		deleted?: boolean;
		sender?: MessageSender;
		content?: string;
		attachment?: MessageAttachmentView | null;
	} | null;
};
