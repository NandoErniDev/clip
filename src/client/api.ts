import type {
  ApiErrorBody,
  ClipItem,
  ClipboardState,
  CreateClipboardResponse,
  ItemResponse,
  SessionResponse,
} from "../shared/types";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", ...init });

  if (!response.ok) {
    let code = "unknown";
    let message = "Something went wrong. Please try again.";
    try {
      const body = (await response.json()) as ApiErrorBody;
      if (body.error) {
        code = body.error.code;
        message = body.error.message;
      }
    } catch {
      // Non-JSON error body: keep the generic message.
    }
    throw new ApiError(response.status, code, message);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export async function createClipboard(): Promise<CreateClipboardResponse> {
  return await request<CreateClipboardResponse>("/api/clipboards", { method: "POST" });
}

export async function connect(token: string): Promise<SessionResponse> {
  return await request<SessionResponse>("/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
}

export async function endSession(): Promise<void> {
  await request<void>("/api/session", { method: "DELETE" });
}

export async function getClipboard(): Promise<ClipboardState> {
  const body = await request<SessionResponse>("/api/clipboard");
  return body.clipboard;
}

export async function addText(text: string): Promise<ItemResponse> {
  return await request<ItemResponse>("/api/items", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

export async function uploadFile(file: File): Promise<ItemResponse> {
  const form = new FormData();
  form.append("file", file, file.name);
  return await request<ItemResponse>("/api/items", { method: "POST", body: form });
}

export async function removeItem(id: string): Promise<ClipboardState> {
  const body = await request<{ clipboard: ClipboardState }>(`/api/items/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  return body.clipboard;
}

export async function clearClipboard(): Promise<ClipboardState> {
  const body = await request<{ clipboard: ClipboardState }>("/api/clipboard/items", { method: "DELETE" });
  return body.clipboard;
}

export async function fetchText(item: ClipItem): Promise<string> {
  const response = await fetch(item.contentUrl, { credentials: "same-origin" });
  if (!response.ok) throw new ApiError(response.status, "content_unavailable", "The text could not be read.");
  return await response.text();
}

export function downloadUrl(item: ClipItem): string {
  return `${item.contentUrl}?download=1`;
}
