/** Response shapes shared by the Worker and the browser client. */

export type ItemKind = "text" | "file";

export interface ClipItem {
  id: string;
  kind: ItemKind;
  /** File name, or "Text" for text items. */
  name: string;
  mime: string;
  size: number;
  createdAt: number;
  /** First characters of a text item (null for files). */
  preview: string | null;
  /** Character count of a text item (null for files). */
  textLength: number | null;
  /** True when the item can be previewed inline (images only). */
  inline: boolean;
  contentUrl: string;
}

export interface ClipboardState {
  createdAt: number;
  expiresAt: number;
  itemCount: number;
  usedBytes: number;
  items: ClipItem[];
  limits: {
    maxItems: number;
    maxFileBytes: number;
    maxTextBytes: number;
    maxTotalBytes: number;
    ttlMs: number;
  };
}

export interface CreateClipboardResponse {
  token: string;
  clipboard: ClipboardState;
}

export interface SessionResponse {
  clipboard: ClipboardState;
}

export interface ItemResponse {
  item: ClipItem;
  clipboard: ClipboardState;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}

export const ERROR_MESSAGES = {
  invalid_token: "That access token isn't valid. Check it and try again.",
  missing_token: "Enter an access token to continue.",
  expired: "This clipboard expired. Create a new one to continue.",
  rate_limited: "Too many requests. Wait a moment and try again.",
  item_limit: "This clipboard is full.",
  storage_limit: "This clipboard is out of storage.",
} as const;
