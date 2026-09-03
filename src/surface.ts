export type VenueKind = "channel" | "dm" | "private_channel";

export interface MessageFile {
  id: string;
  name: string;
  mimetype: string;
  urlPrivate: string; // download with the bot token (needs the files:read scope)
  size: number; // bytes
}

export interface RawMessage {
  venueId: string;
  venueKind: VenueKind;
  principalId: string | null;
  principalName?: string;
  isBot: boolean;
  text: string;
  ts: string;
  threadRootTs: string | null; // null = top-level message
  mentionsBotId: boolean;
  deliveryId?: string;
  files?: MessageFile[]; // attachments (screenshots etc.) — metadata only; content is fetched on demand
}

export interface PostResult {
  messageId: string;
}
