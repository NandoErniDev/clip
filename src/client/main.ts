import { LIMITS } from "../shared/config";
import type { ClipItem, ClipboardState } from "../shared/types";
import * as api from "./api";

const STORE_KEY = "clip.code";
const POLL_MS = 12_000;

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
  code: string | null;
  clipboard: ClipboardState | null;
  pending: PendingUpload[];
  busy: boolean;
  /** Full text of text items, so rows can be dragged out without a fetch. */
  texts: Map<string, string>;
} = {
  code: null,
  clipboard: null,
  pending: [],
  busy: false,
  texts: new Map(),
};

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

function formatLeft(ms: number): string {
  if (ms <= 0) return "expired";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "under a minute left";
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours} h ${String(minutes % 60).padStart(2, "0")} m left`;
  return `${minutes} min left`;
}

function formatWhen(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 45_000) return "now";
  const minutes = Math.round(diff / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return `${hours} h`;
}

function messageFor(error: unknown): string {
  if (error instanceof api.ApiError) return error.message;
  if (error instanceof TypeError) return "No connection. Try again.";
  return "Something went wrong.";
}

function bytesOf(text: string): number {
  return new TextEncoder().encode(text).byteLength;
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
    window.setTimeout(() => item.remove(), 240);
  }, 2200);
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

/* -------------------------------------------------------------------- sheets */

function sheet(html: string): { overlay: HTMLElement; dialog: HTMLElement; close: () => void } {
  const overlay = el("div", "overlay");
  const dialog = el("div", "sheet");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.innerHTML = html;
  overlay.append(dialog);
  document.body.append(overlay);

  const close = (): void => {
    document.removeEventListener("keydown", onKey);
    overlay.remove();
  };
  function onKey(event: KeyboardEvent): void {
    if (event.key === "Escape") close();
  }
  document.addEventListener("keydown", onKey);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  return { overlay, dialog, close };
}

function showCode(code: string): void {
  const { dialog, close } = sheet(`
    <h2 class="sheet__title">Your code</h2>
    <p class="sheet__text">Use this code on your other device. It is the only key to this clipboard.</p>
    <div class="code-box" data-code></div>
    <div class="sheet__actions">
      <button class="btn" type="button" data-copy>Copy</button>
      <button class="btn btn--fill" type="button" data-done>Done</button>
    </div>
  `);
  const box = dialog.querySelector<HTMLElement>("[data-code]");
  if (box) box.textContent = code;

  dialog.querySelector("[data-copy]")?.addEventListener("click", () => {
    void writeClipboard(code).then(() => toast("Code copied"));
  });
  dialog.querySelector("[data-done]")?.addEventListener("click", close);
  dialog.querySelector<HTMLButtonElement>("[data-done]")?.focus();
}

function confirmSheet(options: { title: string; text: string; confirm: string }): Promise<boolean> {
  return new Promise((resolve) => {
    const { dialog } = sheet(`
      <h2 class="sheet__title" data-title></h2>
      <p class="sheet__text" data-text></p>
      <div class="sheet__actions">
        <button class="btn" type="button" data-cancel>Cancel</button>
        <button class="btn btn--danger" type="button" data-confirm></button>
      </div>
    `);
    const title = dialog.querySelector("[data-title]");
    const text = dialog.querySelector("[data-text]");
    const confirm = dialog.querySelector<HTMLButtonElement>("[data-confirm]");
    if (title) title.textContent = options.title;
    if (text) text.textContent = options.text;
    if (confirm) confirm.textContent = options.confirm;

    dialog.querySelector("[data-cancel]")?.addEventListener("click", () => {
      finish(false);
    });
    confirm?.addEventListener("click", () => finish(true));

    let settled = false;
    function finish(value: boolean): void {
      if (settled) return;
      settled = true;
      document.querySelectorAll(".overlay").forEach((node) => node.remove());
      resolve(value);
    }
    confirm?.focus();
  });
}

function openViewer(item: ClipItem): void {
  const overlay = el("div", "overlay overlay--viewer");
  const image = el("img", "viewer__image");
  image.src = item.contentUrl;
  image.alt = item.name;
  overlay.append(image);
  overlay.addEventListener("click", () => overlay.remove());
  document.addEventListener(
    "keydown",
    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        overlay.remove();
        document.removeEventListener("keydown", onKey);
      }
    },
  );
  document.body.append(overlay);
}

/* -------------------------------------------------------------------- landing */

function renderLanding(options: { message?: string; code?: string } = {}): void {
  stopPolling();
  state.clipboard = null;
  state.texts.clear();
  root.replaceChildren();

  const page = el("main", "landing");
  page.innerHTML = `
    <div class="landing__inner">
      <h1 class="wordmark">clip</h1>
      <p class="tagline">A private clipboard between your devices.<br />Everything is gone after ${LIMITS.clipboardTtlMs / 3_600_000} hours.</p>
      <form class="entry" id="entry" novalidate>
        <label class="sr-only" for="code">Code</label>
        <input id="code" class="entry__input" type="text" name="code" placeholder="Code"
          autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="go" />
        <div class="entry__actions">
          <button class="btn btn--fill" type="submit" id="connect">Connect</button>
          <button class="btn" type="button" id="create">New clipboard</button>
        </div>
        <p class="entry__hint" id="hint"></p>
      </form>
    </div>
  `;
  root.append(page);

  const form = page.querySelector<HTMLFormElement>("#entry");
  const input = page.querySelector<HTMLInputElement>("#code");
  const hint = page.querySelector<HTMLElement>("#hint");
  const connectButton = page.querySelector<HTMLButtonElement>("#connect");
  const createButton = page.querySelector<HTMLButtonElement>("#create");

  if (input) input.value = options.code ?? "";
  setHint(hint, options.message ?? "", Boolean(options.message));

  function setHint(node: HTMLElement | null, message: string, isError: boolean): void {
    if (!node) return;
    node.textContent = message;
    node.classList.toggle("is-error", isError);
  }

  const describe = (): void => {
    const value = input?.value.trim() ?? "";
    if (!value) {
      setHint(hint, "Leave the field empty to get a random code.", false);
    } else if (value.length < 3) {
      setHint(hint, "Codes are at least 3 characters.", false);
    } else {
      setHint(hint, value.toLowerCase(), false);
    }
  };
  describe();
  input?.addEventListener("input", describe);

  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = input?.value.trim() ?? "";
    if (!value) {
      setHint(hint, "Enter a code, or create a new clipboard.", true);
      input?.focus();
      return;
    }
    void connect(value, connectButton, hint);
  });

  createButton?.addEventListener("click", () => {
    const value = input?.value.trim() ?? "";
    void create(value || undefined, createButton, hint);
  });

  input?.focus();
}

async function connect(code: string, button: HTMLButtonElement | null, hint: HTMLElement | null): Promise<void> {
  setBusy(button, true, "Connecting…");
  try {
    const response = await api.connect(code);
    remember(code);
    state.code = code;
    state.clipboard = response.clipboard;
    renderWorkspace();
  } catch (error) {
    if (hint) {
      hint.textContent = messageFor(error);
      hint.classList.add("is-error");
    }
  } finally {
    setBusy(button, false, "Connect");
  }
}

async function create(code: string | undefined, button: HTMLButtonElement | null, hint: HTMLElement | null): Promise<void> {
  setBusy(button, true, "Creating…");
  try {
    const response = await api.createClipboard(code);
    remember(response.token);
    state.code = response.token;
    state.clipboard = response.clipboard;
    renderWorkspace();
    showCode(response.token);
  } catch (error) {
    if (hint) {
      hint.textContent = messageFor(error);
      hint.classList.add("is-error");
    }
  } finally {
    setBusy(button, false, "New clipboard");
  }
}

function setBusy(button: HTMLButtonElement | null, busy: boolean, label: string): void {
  if (!button) return;
  button.disabled = busy;
  button.textContent = label;
}

function remember(code: string): void {
  try {
    localStorage.setItem(STORE_KEY, code);
  } catch {
    // Private modes may block storage; the session cookie still works.
  }
}

function forget(): void {
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    // ignore
  }
}

/* ------------------------------------------------------------------ workspace */

function renderWorkspace(): void {
  root.replaceChildren();

  const page = el("div", "page");
  page.innerHTML = `
    <div class="page__inner">
      <header class="topbar">
        <span class="topbar__brand">clip</span>
        <span class="topbar__right">
          <button class="topbar__code" type="button" id="code-chip" title="Copy code"></button>
          <button class="topbar__leave" type="button" id="leave" aria-label="Disconnect">×</button>
        </span>
      </header>

      <section class="composer" id="composer">
        <label class="sr-only" for="composer-input">Text or file</label>
        <textarea id="composer-input" rows="3" placeholder="Type something, or drop a file here."></textarea>
        <div class="composer__row">
          <span class="composer__hint" id="composer-hint"></span>
          <span class="composer__actions">
            <label class="btn btn--quiet" for="file-input">File</label>
            <input id="file-input" type="file" multiple hidden />
            <button class="btn btn--fill btn--small" type="button" id="save" disabled>Save</button>
          </span>
        </div>
        <div class="composer__drop"><span>Drop to add</span></div>
      </section>

      <section class="items" id="items" aria-label="Clipboard items"></section>

      <footer class="footer">
        <span id="status"></span>
        <button class="footer__clear" type="button" id="clear">Clear all</button>
      </footer>
    </div>
  `;
  root.append(page);

  wireWorkspace(page);
  updateWorkspace();
  startPolling();
}

function wireWorkspace(page: HTMLElement): void {
  const input = page.querySelector<HTMLTextAreaElement>("#composer-input");

  page.querySelector("#code-chip")?.addEventListener("click", () => {
    if (!state.code) return;
    void writeClipboard(state.code).then(() => toast("Code copied"));
  });

  page.querySelector("#leave")?.addEventListener("click", () => {
    void disconnect();
  });

  input?.addEventListener("input", updateComposer);
  input?.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void saveText();
    }
  });

  page.querySelector("#save")?.addEventListener("click", () => {
    void saveText();
  });

  page.querySelector<HTMLInputElement>("#file-input")?.addEventListener("change", (event) => {
    const target = event.target as HTMLInputElement;
    const files = Array.from(target.files ?? []);
    if (files.length > 0) void uploadFiles(files);
    target.value = "";
  });

  page.querySelector("#clear")?.addEventListener("click", () => {
    void clearAll();
  });

  page.querySelector("#items")?.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const row = target.closest<HTMLElement>(".item");
    if (!row) return;
    const item = state.clipboard?.items.find((entry) => entry.id === row.dataset.id);
    if (!item) return;

    if (target.closest("[data-delete]")) {
      void removeItem(item);
      return;
    }
    if (target.closest("[data-preview]")) {
      openViewer(item);
      return;
    }
    void copyItem(item, row);
  });

  page.querySelector("#items")?.addEventListener("keydown", (rawEvent) => {
    const event = rawEvent as KeyboardEvent;
    if (event.key !== "Enter" && event.key !== " ") return;
    const row = (event.target as HTMLElement).closest<HTMLElement>(".item");
    if (!row) return;
    event.preventDefault();
    const item = state.clipboard?.items.find((entry) => entry.id === row.dataset.id);
    if (item) void copyItem(item, row);
  });

  updateComposer();
}

function updateWorkspace(): void {
  const clipboard = state.clipboard;
  if (!clipboard) return;

  const chip = root.querySelector<HTMLElement>("#code-chip");
  if (chip) chip.textContent = state.code ?? "";

  const status = root.querySelector<HTMLElement>("#status");
  if (status) {
    status.textContent = `${formatLeft(clipboard.expiresAt - Date.now())} · ${clipboard.itemCount}/${clipboard.limits.maxItems} · ${formatBytes(clipboard.usedBytes)}`;
  }

  const clear = root.querySelector<HTMLButtonElement>("#clear");
  if (clear) clear.hidden = clipboard.itemCount === 0 && state.pending.length === 0;

  renderItems();
}

let lastSignature = "";

function renderItems(force = false): void {
  const clipboard = state.clipboard;
  const list = root.querySelector<HTMLElement>("#items");
  if (!clipboard || !list) return;

  const signature = [
    clipboard.items.map((item) => `${item.id}:${item.size}`).join(","),
    state.pending.map((entry) => entry.id).join(","),
  ].join("|");
  if (!force && signature === lastSignature) return;
  lastSignature = signature;

  list.replaceChildren();

  for (const pending of state.pending) {
    const row = el("div", "item is-pending");
    const thumb = el("div", "item__thumb");
    thumb.append(el("span", "spinner"));
    const body = el("div", "item__body");
    body.append(el("p", "item__line", pending.name), el("span", "item__meta", "Uploading…"));
    row.append(thumb, body);
    list.append(row);
  }

  for (const item of clipboard.items) {
    list.append(itemRow(item));
  }

  if (clipboard.items.length === 0 && state.pending.length === 0) {
    const empty = el("div", "empty");
    empty.append(
      el("p", "empty__title", "Nothing yet"),
      el("p", "empty__text", "Anything you add appears on your other devices within seconds."),
    );
    list.append(empty);
  }

  prefetchTexts();
}

function itemRow(item: ClipItem): HTMLElement {
  const row = el("div", "item");
  row.dataset.id = item.id;
  row.tabIndex = 0;
  row.draggable = true;
  row.setAttribute("role", "button");
  row.setAttribute("aria-label", item.kind === "text" ? "Copy text" : `Copy ${item.name}`);

  const thumb = el("div", "item__thumb");
  if (item.inline) {
    const button = el("button", "item__preview");
    button.type = "button";
    button.dataset.preview = "1";
    button.setAttribute("aria-label", `Preview ${item.name}`);
    const image = el("img");
    image.src = item.contentUrl;
    image.alt = item.name;
    image.loading = "lazy";
    button.append(image);
    thumb.append(button);
  } else {
    thumb.append(el("span", "item__label", typeLabel(item)));
  }

  const body = el("div", "item__body");
  if (item.kind === "text") {
    body.append(el("p", "item__line", oneLine(item.preview ?? "")));
  } else {
    body.append(el("p", "item__line", item.name));
  }
  body.append(
    el(
      "span",
      "item__meta",
      `${item.kind === "text" ? `${formatBytes(item.size)} text` : formatBytes(item.size)} · ${formatWhen(item.createdAt)} ago`,
    ),
  );

  const remove = el("button", "item__delete", "×");
  remove.type = "button";
  remove.dataset.delete = "1";
  remove.setAttribute("aria-label", `Delete ${item.name}`);

  row.append(thumb, body, remove);

  row.addEventListener("dragstart", (event) => {
    const data = event.dataTransfer;
    if (!data) return;
    data.effectAllowed = "copy";
    row.classList.add("is-dragging");

    if (item.kind === "text") {
      data.setData("text/plain", state.texts.get(item.id) ?? item.preview ?? "");
      data.setData("text/uri-list", absolute(item.contentUrl));
    } else {
      data.setData("DownloadURL", `${item.mime}:${item.name}:${absolute(api.downloadUrl(item))}`);
      data.setData("text/uri-list", absolute(api.downloadUrl(item)));
      data.setData("text/plain", item.name);
    }
  });
  row.addEventListener("dragend", () => row.classList.remove("is-dragging"));

  return row;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function typeLabel(item: ClipItem): string {
  if (item.kind === "text") return "TXT";
  const dot = item.name.lastIndexOf(".");
  if (dot <= 0) return "FILE";
  return item.name.slice(dot + 1).toUpperCase().slice(0, 4);
}

function absolute(path: string): string {
  return new URL(path, window.location.href).href;
}

function prefetchTexts(): void {
  const clipboard = state.clipboard;
  if (!clipboard) return;
  for (const item of clipboard.items) {
    if (item.kind !== "text" || state.texts.has(item.id)) continue;
    if (item.size > 128 * 1024) continue;
    void api
      .fetchText(item)
      .then((text) => state.texts.set(item.id, text))
      .catch(() => undefined);
  }
}

/* --------------------------------------------------------------------- input */

function updateComposer(): void {
  const input = root.querySelector<HTMLTextAreaElement>("#composer-input");
  const save = root.querySelector<HTMLButtonElement>("#save");
  const hint = root.querySelector<HTMLElement>("#composer-hint");
  if (!input) return;

  const value = input.value;
  const bytes = bytesOf(value);
  const empty = value.trim().length === 0;
  const tooLarge = bytes > LIMITS.maxTextBytes;
  const full = (state.clipboard?.itemCount ?? 0) >= LIMITS.maxItems;

  if (save) save.disabled = empty || tooLarge || state.busy || full;

  if (hint) {
    if (tooLarge) hint.textContent = `Too long — ${Math.round(LIMITS.maxTextBytes / 1024)} KB max`;
    else if (full) hint.textContent = "This clipboard is full";
    else if (empty) hint.textContent = "⌘ ↵ to save";
    else hint.textContent = `${formatBytes(bytes)} · ⌘ ↵ to save`;
  }
}

async function saveText(): Promise<void> {
  if (!state.clipboard) return;
  const input = root.querySelector<HTMLTextAreaElement>("#composer-input");
  if (!input) return;
  const text = input.value.replace(/\u0000/g, "");
  if (!text.trim()) return;

  state.busy = true;
  updateComposer();
  try {
    const result = await api.addText(text);
    state.clipboard = result.clipboard;
    input.value = "";
    input.focus();
    updateWorkspace();
    toast("Saved");
  } catch (error) {
    handleError(error);
  } finally {
    state.busy = false;
    updateComposer();
  }
}

async function uploadFiles(files: File[]): Promise<void> {
  if (!state.clipboard) return;

  for (const file of files) {
    if (file.size === 0) {
      toast(`${file.name} is empty`, "error");
      continue;
    }
    if (file.size > LIMITS.maxFileBytes) {
      toast(`${file.name} is over ${Math.round(LIMITS.maxFileBytes / (1024 * 1024))} MB`, "error");
      continue;
    }

    const pendingId = crypto.randomUUID();
    state.pending.push({ id: pendingId, name: file.name });
    renderItems(true);

    try {
      const result = await api.uploadFile(file);
      state.clipboard = result.clipboard;
    } catch (error) {
      handleError(error);
    } finally {
      state.pending = state.pending.filter((entry) => entry.id !== pendingId);
      updateWorkspace();
    }
  }
}

async function copyItem(item: ClipItem, row: HTMLElement): Promise<void> {
  try {
    if (item.kind === "text") {
      const text = state.texts.get(item.id) ?? (await api.fetchText(item));
      state.texts.set(item.id, text);
      await writeClipboard(text);
    } else if (item.inline) {
      const blob = await api.fetchBlob(item);
      await navigator.clipboard.write([new ClipboardItem({ [blob.type || "image/png"]: blob })]);
    } else {
      downloadItem(item);
      toast("Downloading");
      return;
    }

    row.classList.add("is-copied");
    window.setTimeout(() => row.classList.remove("is-copied"), 900);
    toast("Copied");
  } catch (error) {
    if (item.inline) {
      openViewer(item);
      return;
    }
    toast(messageFor(error), "error");
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

async function removeItem(item: ClipItem): Promise<void> {
  try {
    state.clipboard = await api.removeItem(item.id);
    state.texts.delete(item.id);
    updateWorkspace();
  } catch (error) {
    handleError(error);
  }
}

async function clearAll(): Promise<void> {
  const count = state.clipboard?.itemCount ?? 0;
  if (count === 0) return;
  const confirmed = await confirmSheet({
    title: "Clear everything?",
    text: `${count} ${count === 1 ? "item" : "items"} will be deleted. This cannot be undone.`,
    confirm: "Clear",
  });
  if (!confirmed) return;

  try {
    state.clipboard = await api.clearClipboard();
    state.texts.clear();
    updateWorkspace();
    toast("Cleared");
  } catch (error) {
    handleError(error);
  }
}

async function disconnect(): Promise<void> {
  try {
    await api.endSession();
  } catch {
    // The cookie may already be gone; leaving locally is still correct.
  }
  forget();
  state.code = null;
  state.clipboard = null;
  state.pending = [];
  state.texts.clear();
  lastSignature = "";
  renderLanding();
}

/* ------------------------------------------------------------------ syncing */

let timer: number | null = null;

function startPolling(): void {
  stopPolling();
  timer = window.setInterval(() => {
    if (document.visibilityState === "visible" && state.clipboard && !state.busy) void refresh();
  }, POLL_MS);
}

function stopPolling(): void {
  if (timer !== null) {
    window.clearInterval(timer);
    timer = null;
  }
}

async function refresh(): Promise<void> {
  try {
    state.clipboard = await api.getClipboard();
    updateWorkspace();
  } catch (error) {
    if (error instanceof api.ApiError && (error.status === 401 || error.status === 410)) {
      const expired = error.status === 410;
      forget();
      state.code = null;
      state.clipboard = null;
      lastSignature = "";
      renderLanding({
        message: expired ? "That clipboard expired. Create a new one." : "Your session ended. Enter your code again.",
      });
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

/* -------------------------------------------------------- global interactions */

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
      void api
        .addText(text)
        .then((result) => {
          state.clipboard = result.clipboard;
          updateWorkspace();
          toast("Saved");
        })
        .catch(handleError);
    }
  });

  document.addEventListener("dragover", (event) => {
    if (!state.clipboard) return;
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    root.querySelector("#composer")?.classList.add("is-dropping");
  });

  document.addEventListener("dragleave", (event) => {
    if (event.relatedTarget === null) root.querySelector("#composer")?.classList.remove("is-dropping");
  });

  document.addEventListener("drop", (event) => {
    if (!state.clipboard) return;
    const files = Array.from(event.dataTransfer?.files ?? []);
    root.querySelector("#composer")?.classList.remove("is-dropping");
    if (files.length === 0) return;
    event.preventDefault();
    void uploadFiles(files);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.clipboard) void refresh();
  });

  window.setInterval(() => {
    if (state.clipboard) updateWorkspace();
  }, 30_000);
}

/* ---------------------------------------------------------------------- boot */

async function resume(code: string): Promise<void> {
  try {
    const response = await api.connect(code);
    state.code = code;
    state.clipboard = response.clipboard;
    renderWorkspace();
  } catch (error) {
    forget();
    state.code = null;
    if (error instanceof api.ApiError && error.status === 410) {
      renderLanding({ message: "That clipboard expired. Create a new one." });
      return;
    }
    if (error instanceof api.ApiError && error.status === 401) {
      renderLanding({ message: "That code doesn't exist anymore." });
      return;
    }
    renderLanding({ message: messageFor(error) });
  }
}

installGlobalHandlers();

const saved = (() => {
  try {
    return localStorage.getItem(STORE_KEY);
  } catch {
    return null;
  }
})();

if (saved) {
  state.code = saved;
  void resume(saved);
} else {
  renderLanding();
}
