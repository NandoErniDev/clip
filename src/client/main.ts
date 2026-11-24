import { LIMITS } from "../shared/config";
import type { ClipItem, ClipboardState } from "../shared/types";
import * as api from "./api";

const TOKEN_KEY = "clip.token";
const POLL_INTERVAL_MS = 12_000;

const root = (() => {
  const node = document.querySelector<HTMLDivElement>("#app");
  if (!node) throw new Error("Missing #app root");
  return node;
})();

interface PendingUpload {
  id: string;
  name: string;
}

const state: {
  token: string | null;
  clipboard: ClipboardState | null;
  pending: PendingUpload[];
  busy: boolean;
} = {
  token: null,
  clipboard: null,
  pending: [],
  busy: false,
};

const ICONS = {
  copy: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="7" width="9" height="9" rx="2.2"/><path d="M13 4.6A2.1 2.1 0 0 0 11 3.5H5.6A2.1 2.1 0 0 0 3.5 5.6V11c0 .8.5 1.5 1.2 1.9"/></svg>',
  download:
    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3.5v8.2"/><path d="m6.6 8.9 3.4 3.4 3.4-3.4"/><path d="M4 14.2v1.1A1.7 1.7 0 0 0 5.7 17h8.6a1.7 1.7 0 0 0 1.7-1.7v-1.1"/></svg>',
  trash:
    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 6h11"/><path d="M8 6V4.6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1V6"/><path d="M6 6l.6 8.4a1.7 1.7 0 0 0 1.7 1.6h3.4a1.7 1.7 0 0 0 1.7-1.6L14 6"/></svg>',
  mark:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M15.8 8.2a4 4 0 0 0-5.6 0l-3.3 3.3a4 4 0 0 0 0 5.6"/><path d="M8.2 15.8a4 4 0 0 0 5.6 0l3.3-3.3a4 4 0 0 0 0-5.6"/></svg>',
} as const;

/* ------------------------------------------------------------------ helpers */

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string | null,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024;
    return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return "Expired";
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours} h ${minutes.toString().padStart(2, "0")} m left`;
  if (totalMinutes > 0) return `${totalMinutes} min left`;
  return "Less than a minute left";
}

function formatRelative(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 45_000) return "just now";
  const minutes = Math.round(diff / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function typeLabel(item: ClipItem): string {
  if (item.kind === "text") return "Text";
  const dot = item.name.lastIndexOf(".");
  if (dot <= 0) return "File";
  return item.name.slice(dot + 1).toUpperCase().slice(0, 5);
}

function dot(): HTMLElement {
  return el("span", "meta__dot", "·");
}

function messageFor(error: unknown): string {
  if (error instanceof api.ApiError) return error.message;
  if (error instanceof TypeError) return "Could not reach the server. Check your connection.";
  return "Something went wrong. Please try again.";
}

function composer(): HTMLElement | null {
  return root?.querySelector<HTMLElement>("#composer") ?? null;
}

function composerInput(): HTMLTextAreaElement | null {
  return root?.querySelector<HTMLTextAreaElement>("#composer-input") ?? null;
}

/* -------------------------------------------------------------------- toasts */

function toast(message: string, tone: "info" | "error" = "info"): void {
  let stack = document.querySelector<HTMLElement>(".toasts");
  if (!stack) {
    stack = el("div", "toasts");
    stack.setAttribute("role", "status");
    stack.setAttribute("aria-live", "polite");
    document.body.append(stack);
  }
  const item = el("div", `toast${tone === "error" ? " toast--error" : ""}`, message);
  stack.append(item);
  window.setTimeout(() => {
    item.classList.add("toast--out");
    window.setTimeout(() => item.remove(), 220);
  }, 2600);
}

async function writeClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = el("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
}

/* -------------------------------------------------------------------- dialogs */

function overlayHost(): HTMLElement {
  const overlay = el("div", "overlay");
  document.body.append(overlay);
  return overlay;
}

function closeOnEscape(handler: () => void): () => void {
  const listener = (event: KeyboardEvent): void => {
    if (event.key === "Escape") handler();
  };
  document.addEventListener("keydown", listener);
  return () => document.removeEventListener("keydown", listener);
}

function showTokenDialog(token: string): void {
  const overlay = overlayHost();
  const modal = el("div", "modal overlay__panel");
  modal.innerHTML = `
    <h2 class="modal__title">Your access token</h2>
    <p class="modal__text">Open the clipboard on another device with this token. It is shown only once — keep it somewhere safe.</p>
    <div class="token-box" data-token></div>
    <div class="modal__actions">
      <button class="btn btn--secondary" type="button" data-copy>Copy token</button>
      <button class="btn btn--primary" type="button" data-done>Done</button>
    </div>
  `;
  const tokenBox = modal.querySelector<HTMLElement>("[data-token]");
  if (tokenBox) tokenBox.textContent = token;

  const close = (): void => {
    removeListener();
    overlay.remove();
  };
  const removeListener = closeOnEscape(close);

  modal.querySelector("[data-copy]")?.addEventListener("click", () => {
    void writeClipboard(token).then(() => toast("Token copied"));
  });
  modal.querySelector("[data-done]")?.addEventListener("click", close);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });

  overlay.append(modal);
  modal.querySelector<HTMLButtonElement>("[data-done]")?.focus();
}

function confirmDialog(options: {
  title: string;
  message: string;
  confirmLabel: string;
  destructive?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = overlayHost();
    const modal = el("div", "modal overlay__panel");
    modal.innerHTML = `
      <h2 class="modal__title" data-title></h2>
      <p class="modal__text" data-message></p>
      <div class="modal__actions">
        <button class="btn btn--secondary" type="button" data-cancel>Cancel</button>
        <button class="btn ${options.destructive ? "btn--danger" : "btn--primary"}" type="button" data-confirm></button>
      </div>
    `;
    const title = modal.querySelector("[data-title]");
    const message = modal.querySelector("[data-message]");
    const confirm = modal.querySelector<HTMLButtonElement>("[data-confirm]");
    if (title) title.textContent = options.title;
    if (message) message.textContent = options.message;
    if (confirm) confirm.textContent = options.confirmLabel;

    const finish = (value: boolean): void => {
      removeListener();
      overlay.remove();
      resolve(value);
    };
    const removeListener = closeOnEscape(() => finish(false));

    modal.querySelector("[data-cancel]")?.addEventListener("click", () => finish(false));
    confirm?.addEventListener("click", () => finish(true));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) finish(false);
    });

    overlay.append(modal);
    confirm?.focus();
  });
}

function openViewer(item: ClipItem): void {
  const overlay = overlayHost();
  overlay.classList.add("overlay--viewer");
  const image = el("img", "viewer__image");
  image.src = item.contentUrl;
  image.alt = item.name;
  const close = (): void => {
    removeListener();
    overlay.remove();
  };
  const removeListener = closeOnEscape(close);
  overlay.addEventListener("click", close);
  overlay.append(image);
}

/* --------------------------------------------------------------- auth screen */

function renderAuth(message?: string): void {
  stopPolling();
  state.clipboard = null;
  root.replaceChildren();

  const main = el("main", "auth");
  const card = el("section", "auth__card");
  card.innerHTML = `
    <div class="mark">${ICONS.mark}</div>
    <h1 class="auth__title">Clip</h1>
    <p class="auth__lede">A private, temporary clipboard between your devices. Everything is deleted automatically after ${LIMITS.clipboardTtlMs / 3_600_000} hours.</p>
    <form id="connect-form" class="stack" novalidate>
      <label class="field">
        <span class="field__label">Access token</span>
        <input id="token-input" class="input input--mono" type="text" name="token" placeholder="CLIP-XXXX-XXXX-XXXX-XXXX" autocomplete="off" autocapitalize="characters" spellcheck="false" required />
      </label>
      <p class="form-error" id="auth-error" role="alert" hidden></p>
      <button class="btn btn--primary btn--block" type="submit" id="connect-btn">Connect</button>
    </form>
    <div class="divider"><span>or</span></div>
    <button class="btn btn--secondary btn--block" id="create-btn" type="button">Create a new clipboard</button>
    <p class="fineprint">The token is the only key to a clipboard. Only its SHA-256 hash is stored on the server.</p>
  `;
  main.append(card);
  root.append(main);

  const form = card.querySelector<HTMLFormElement>("#connect-form");
  const input = card.querySelector<HTMLInputElement>("#token-input");
  const errorNode = card.querySelector<HTMLElement>("#auth-error");
  const connectButton = card.querySelector<HTMLButtonElement>("#connect-btn");
  const createButton = card.querySelector<HTMLButtonElement>("#create-btn");

  if (message && errorNode) {
    errorNode.textContent = message;
    errorNode.hidden = false;
  }

  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    const token = input?.value.trim() ?? "";
    if (!token) {
      if (errorNode) {
        errorNode.textContent = "Enter an access token to continue.";
        errorNode.hidden = false;
      }
      input?.focus();
      return;
    }
    void connectWithToken(token, errorNode, connectButton);
  });

  createButton?.addEventListener("click", () => {
    void createNewClipboard(createButton, errorNode);
  });

  input?.focus();
}

function setAuthError(node: HTMLElement | null, message?: string): void {
  if (!node) return;
  node.textContent = message ?? "";
  node.hidden = !message;
}

async function connectWithToken(
  token: string,
  errorNode: HTMLElement | null,
  button: HTMLButtonElement | null,
): Promise<void> {
  setAuthError(errorNode);
  if (button) {
    button.disabled = true;
    button.textContent = "Connecting…";
  }
  try {
    const response = await api.connect(token);
    rememberToken(token);
    state.token = token;
    state.clipboard = response.clipboard;
    renderWorkspace();
  } catch (error) {
    setAuthError(errorNode, messageFor(error));
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "Connect";
    }
  }
}

async function createNewClipboard(button: HTMLButtonElement | null, errorNode: HTMLElement | null): Promise<void> {
  setAuthError(errorNode);
  if (button) {
    button.disabled = true;
    button.textContent = "Creating…";
  }
  try {
    const response = await api.createClipboard();
    rememberToken(response.token);
    state.token = response.token;
    state.clipboard = response.clipboard;
    renderWorkspace();
    showTokenDialog(response.token);
  } catch (error) {
    setAuthError(errorNode, messageFor(error));
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "Create a new clipboard";
    }
  }
}

function rememberToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Storage can be unavailable in private modes; the session cookie still works.
  }
}

function forgetToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // ignore
  }
}

/* --------------------------------------------------------------- workspace */

function renderWorkspace(): void {
  root.replaceChildren();

  const shell = el("div", "shell");
  shell.innerHTML = `
    <header class="bar">
      <div class="brand">
        <span class="brand__mark">${ICONS.mark}</span>
        <span class="brand__name">Clip</span>
      </div>
      <div class="bar__meta">
        <span class="status"><span class="status__dot"></span>Connected</span>
        <button class="btn btn--ghost btn--sm" type="button" id="disconnect">Disconnect</button>
      </div>
    </header>

    <section class="usage" aria-label="Clipboard usage">
      <div class="usage__row">
        <span class="usage__expiry" id="expiry">—</span>
        <span class="usage__storage" id="storage">—</span>
      </div>
      <div class="meter"><div class="meter__fill" id="meter"></div></div>
      <div class="usage__row usage__row--sub">
        <span id="item-count">—</span>
        <button class="link" type="button" id="copy-token">Copy token</button>
      </div>
    </section>

    <section class="composer" id="composer">
      <label class="sr-only" for="composer-input">Paste or type text</label>
      <textarea id="composer-input" placeholder="Paste or type text…" rows="4" spellcheck="true"></textarea>
      <div class="composer__footer">
        <span class="composer__hint" id="composer-hint">Paste anywhere · drop files</span>
        <div class="composer__actions">
          <label class="btn btn--secondary btn--sm" for="file-input">Upload</label>
          <input id="file-input" type="file" multiple hidden />
          <button class="btn btn--primary btn--sm" type="button" id="add-text" disabled>Add text</button>
        </div>
      </div>
      <div class="dropzone" aria-hidden="true"><span>Drop to add to this clipboard</span></div>
    </section>

    <section class="list" aria-label="Clipboard items">
      <div class="list__head">
        <h2>Items</h2>
        <button class="link link--danger" type="button" id="clear-all">Clear all</button>
      </div>
      <div class="items" id="items"></div>
    </section>

    <footer class="foot">Files are stored in Cloudflare R2, metadata in D1. Expired content is deleted automatically.</footer>
  `;
  root.append(shell);

  wireWorkspace(shell);
  updateWorkspace();
  startPolling();
}

function wireWorkspace(shell: HTMLElement): void {
  shell.querySelector("#disconnect")?.addEventListener("click", () => {
    void disconnect();
  });

  shell.querySelector("#copy-token")?.addEventListener("click", () => {
    if (!state.token) return;
    void writeClipboard(state.token).then(() => toast("Token copied"));
  });

  const input = shell.querySelector<HTMLTextAreaElement>("#composer-input");
  input?.addEventListener("input", updateComposerState);
  input?.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void addText(input.value);
    }
  });

  shell.querySelector("#add-text")?.addEventListener("click", () => {
    if (input) void addText(input.value);
  });

  shell.querySelector<HTMLInputElement>("#file-input")?.addEventListener("change", (event) => {
    const target = event.target as HTMLInputElement;
    const files = Array.from(target.files ?? []);
    if (files.length > 0) void uploadFiles(files);
    target.value = "";
  });

  shell.querySelector("#clear-all")?.addEventListener("click", () => {
    void clearAll();
  });

  shell.querySelector("#items")?.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
    const row = button?.closest<HTMLElement>("[data-id]");
    if (!button || !row) return;
    const id = row.dataset.id;
    const item = state.clipboard?.items.find((entry) => entry.id === id);
    if (!item) return;

    const action = button.dataset.action;
    if (action === "copy") void copyItem(item);
    if (action === "download") downloadItem(item);
    if (action === "delete") void deleteItem(item);
    if (action === "preview") openViewer(item);
  });

  updateComposerState();
}

function updateWorkspace(): void {
  const clipboard = state.clipboard;
  const expiry = root.querySelector<HTMLElement>("#expiry");
  if (!clipboard || !expiry) return;

  const remaining = clipboard.expiresAt - Date.now();
  expiry.textContent = remaining > 0 ? `Expires in ${formatRemaining(remaining)}` : "Expired";

  const used = clipboard.usedBytes;
  const max = clipboard.limits.maxTotalBytes;
  const percent = Math.min(100, (used / max) * 100);

  const storage = root.querySelector<HTMLElement>("#storage");
  if (storage) storage.textContent = `${formatBytes(used)} of ${formatBytes(max)} used`;

  const meter = root.querySelector<HTMLElement>("#meter");
  if (meter) {
    // Avoid a stray one-pixel sliver when the clipboard is essentially empty.
    meter.style.width = percent < 0.5 ? "0%" : `${percent}%`;
    meter.classList.toggle("meter__fill--high", percent >= 90);
  }

  const count = root.querySelector<HTMLElement>("#item-count");
  if (count) count.textContent = `${clipboard.itemCount} of ${clipboard.limits.maxItems} items`;

  renderItems();
}

function itemSignature(): string {
  const clipboard = state.clipboard;
  if (!clipboard) return "";
  const ids = clipboard.items.map((item) => `${item.id}:${item.size}`).join(",");
  const pending = state.pending.map((entry) => entry.id).join(",");
  return `${ids}|${pending}|${Math.floor(Date.now() / 60_000)}`;
}

let lastSignature = "";

function renderItems(force = false): void {
  const clipboard = state.clipboard;
  const container = root.querySelector<HTMLElement>("#items");
  if (!clipboard || !container) return;

  const signature = itemSignature();
  if (!force && signature === lastSignature) return;
  lastSignature = signature;

  container.replaceChildren();

  for (const pending of state.pending) {
    container.append(pendingRow(pending));
  }

  for (const item of clipboard.items) {
    container.append(itemRow(item));
  }

  if (clipboard.items.length === 0 && state.pending.length === 0) {
    const empty = el("div", "empty");
    empty.append(
      el("p", "empty__title", "Nothing here yet"),
      el(
        "p",
        "empty__hint",
        "Paste text anywhere on this page, drop a file, or use Upload. It appears on your other devices within seconds.",
      ),
    );
    container.append(empty);
  }
}

function pendingRow(pending: PendingUpload): HTMLElement {
  const row = el("div", "item item--pending");
  const thumb = el("div", "thumb thumb--static");
  thumb.append(el("span", "spinner"));
  const body = el("div", "item__body");
  body.append(el("div", "item__name", pending.name), el("div", "item__meta", "Uploading…"));
  row.append(thumb, body);
  return row;
}

function itemRow(item: ClipItem): HTMLElement {
  const row = el("div", "item");
  row.dataset.id = item.id;

  const thumb = item.inline ? el("button", "thumb") : el("div", "thumb thumb--static");
  if (thumb instanceof HTMLButtonElement) {
    thumb.type = "button";
    thumb.dataset.action = "preview";
    thumb.setAttribute("aria-label", `Preview ${item.name}`);
    const image = el("img");
    image.src = item.contentUrl;
    image.alt = item.name;
    image.loading = "lazy";
    thumb.append(image);
  } else {
    thumb.append(el("span", "thumb__label", typeLabel(item)));
  }

  const body = el("div", "item__body");
  if (item.kind === "text") {
    body.append(el("p", "item__text", item.preview ?? ""));
  } else {
    body.append(el("div", "item__name", item.name));
  }

  const meta = el("div", "item__meta");
  meta.append(el("span", null, typeLabel(item)), dot(), el("span", null, formatBytes(item.size)), dot(), el("span", null, formatRelative(item.createdAt)));
  body.append(meta);

  const actions = el("div", "item__actions");

  if (item.kind === "text") {
    actions.append(actionButton("copy", `Copy text`, ICONS.copy, "Copy"));
  }
  actions.append(actionButton("download", `Download ${item.name}`, ICONS.download, "Download"));
  actions.append(actionButton("delete", `Delete ${item.name}`, ICONS.trash, "Delete", true));

  row.append(thumb, body, actions);
  return row;
}

function actionButton(action: string, label: string, icon: string, text: string, danger = false): HTMLButtonElement {
  const button = el("button", `icon-btn${danger ? " icon-btn--danger" : ""}`);
  button.type = "button";
  button.dataset.action = action;
  button.setAttribute("aria-label", label);
  button.title = label;
  button.innerHTML = `${icon}<span class="icon-btn__text">${text}</span>`;
  return button;
}

function updateComposerState(): void {
  const input = composerInput();
  const button = root.querySelector<HTMLButtonElement>("#add-text");
  const hint = root.querySelector<HTMLElement>("#composer-hint");
  if (!input) return;

  const bytes = new TextEncoder().encode(input.value).byteLength;
  const empty = input.value.trim().length === 0;

  if (button) button.disabled = empty || state.busy || bytes > LIMITS.maxTextBytes;

  if (hint) {
    if (empty) {
      hint.textContent = "Paste anywhere · drop files";
    } else if (bytes > LIMITS.maxTextBytes) {
      hint.textContent = `Text is too long — ${Math.round(LIMITS.maxTextBytes / 1024)} KB maximum`;
    } else {
      hint.textContent = `${formatBytes(bytes)} of ${Math.round(LIMITS.maxTextBytes / 1024)} KB`;
    }
  }
}

/* ------------------------------------------------------------------ actions */

async function addText(text: string): Promise<void> {
  if (!state.clipboard) return;
  const clean = text.replace(/\u0000/g, "");
  if (!clean.trim()) return;

  const bytes = new TextEncoder().encode(clean).byteLength;
  if (bytes > LIMITS.maxTextBytes) {
    toast(`Text can be up to ${Math.round(LIMITS.maxTextBytes / 1024)} KB`, "error");
    return;
  }

  state.busy = true;
  updateComposerState();
  try {
    const result = await api.addText(clean);
    state.clipboard = result.clipboard;
    const input = composerInput();
    if (input) {
      input.value = "";
      input.focus();
    }
    updateWorkspace();
    toast("Saved");
  } catch (error) {
    handleError(error);
  } finally {
    state.busy = false;
    updateComposerState();
  }
}

async function uploadFiles(files: File[]): Promise<void> {
  if (!state.clipboard) return;

  for (const file of files) {
    if (file.size > LIMITS.maxFileBytes) {
      toast(`${file.name} is larger than ${Math.round(LIMITS.maxFileBytes / (1024 * 1024))} MB`, "error");
      continue;
    }
    if (file.size === 0) {
      toast(`${file.name} is empty`, "error");
      continue;
    }

    const pendingId = crypto.randomUUID();
    state.pending.push({ id: pendingId, name: file.name });
    renderItems(true);

    try {
      const result = await api.uploadFile(file);
      state.clipboard = result.clipboard;
      toast(`Added ${file.name}`);
    } catch (error) {
      handleError(error);
    } finally {
      state.pending = state.pending.filter((entry) => entry.id !== pendingId);
      updateWorkspace();
    }
  }
}

async function copyItem(item: ClipItem): Promise<void> {
  try {
    const text = await api.fetchText(item);
    await writeClipboard(text);
    toast("Copied to clipboard");
  } catch (error) {
    handleError(error);
  }
}

function downloadItem(item: ClipItem): void {
  const link = el("a");
  link.href = api.downloadUrl(item);
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
}

async function deleteItem(item: ClipItem): Promise<void> {
  try {
    state.clipboard = await api.removeItem(item.id);
    updateWorkspace();
    toast("Item deleted");
  } catch (error) {
    handleError(error);
  }
}

async function clearAll(): Promise<void> {
  const count = state.clipboard?.itemCount ?? 0;
  if (count === 0) return;

  const confirmed = await confirmDialog({
    title: "Clear this clipboard?",
    message: `${count} ${count === 1 ? "item" : "items"} will be deleted permanently. This can't be undone.`,
    confirmLabel: "Clear all",
    destructive: true,
  });
  if (!confirmed) return;

  try {
    state.clipboard = await api.clearClipboard();
    updateWorkspace();
    toast("Clipboard cleared");
  } catch (error) {
    handleError(error);
  }
}

async function disconnect(): Promise<void> {
  try {
    await api.endSession();
  } catch {
    // The cookie may already be gone; disconnecting locally is still correct.
  }
  forgetToken();
  state.token = null;
  state.clipboard = null;
  state.pending = [];
  lastSignature = "";
  renderAuth();
}

/* -------------------------------------------------------------- refreshing */

let pollTimer: number | null = null;

function startPolling(): void {
  stopPolling();
  pollTimer = window.setInterval(() => {
    if (document.visibilityState === "visible" && state.clipboard && !state.busy) void refresh();
  }, POLL_INTERVAL_MS);
}

function stopPolling(): void {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function refresh(): Promise<void> {
  try {
    state.clipboard = await api.getClipboard();
    updateWorkspace();
  } catch (error) {
    if (error instanceof api.ApiError && (error.status === 401 || error.status === 410)) {
      const expired = error.status === 410;
      forgetToken();
      state.token = null;
      state.clipboard = null;
      renderAuth(expired ? "That clipboard expired. Create a new one to continue." : "Your session ended. Connect again.");
    }
  }
}

function handleError(error: unknown): void {
  if (error instanceof api.ApiError && (error.status === 401 || error.status === 410)) {
    void refresh();
    return;
  }
  toast(messageFor(error), "error");
}

/* ------------------------------------------------------- global interactions */

function installGlobalHandlers(): void {
  document.addEventListener("paste", (event) => {
    if (!state.clipboard) return;
    const data = event.clipboardData;
    if (!data) return;

    const files = Array.from(data.files ?? []);
    if (files.length > 0) {
      event.preventDefault();
      void uploadFiles(files);
      return;
    }

    const target = event.target;
    if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) return;

    const text = data.getData("text/plain");
    if (text.trim().length > 0) {
      event.preventDefault();
      void addText(text);
    }
  });

  document.addEventListener("dragover", (event) => {
    if (!state.clipboard) return;
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    composer()?.classList.add("is-dragging");
  });

  document.addEventListener("dragleave", (event) => {
    if (event.relatedTarget === null) composer()?.classList.remove("is-dragging");
  });

  document.addEventListener("drop", (event) => {
    if (!state.clipboard) return;
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    event.preventDefault();
    composer()?.classList.remove("is-dragging");
    void uploadFiles(files);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.clipboard) void refresh();
  });

  window.setInterval(() => {
    if (state.clipboard) updateWorkspace();
  }, 30_000);
}

/* -------------------------------------------------------------------- boot */

async function resume(token: string): Promise<void> {
  try {
    const response = await api.connect(token);
    state.clipboard = response.clipboard;
    renderWorkspace();
  } catch (error) {
    if (error instanceof api.ApiError && (error.status === 401 || error.status === 410)) {
      forgetToken();
      state.token = null;
      renderAuth(
        error.status === 410 ? "That clipboard expired. Create a new one to continue." : "That token is no longer valid.",
      );
      return;
    }
    renderAuth(messageFor(error));
  }
}

installGlobalHandlers();

const savedToken = (() => {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
})();

if (savedToken) {
  state.token = savedToken;
  void resume(savedToken);
} else {
  renderAuth();
}
