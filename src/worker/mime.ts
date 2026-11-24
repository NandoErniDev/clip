/** Content type and filename handling for uploads. */

const INLINE_PREVIEW_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/**
 * Types that must never be interpreted by the browser as active content.
 * They are stored and served as generic binary downloads instead.
 */
const ACTIVE_TYPES = new Set([
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
  "text/javascript",
  "application/javascript",
  "application/x-javascript",
  "application/ecmascript",
  "text/ecmascript",
  "application/xml",
  "text/xml",
  "text/xsl",
  "application/x-shockwave-flash",
]);

const EXTENSION_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jfif: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  heic: "image/heic",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  rtf: "application/rtf",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  xml: "application/octet-stream",
  yml: "application/yaml",
  yaml: "application/yaml",
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
  "7z": "application/x-7z-compressed",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  pages: "application/octet-stream",
  numbers: "application/octet-stream",
  key: "application/octet-stream",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};

/** Removes path separators and control characters, and bounds the length. */
export function sanitizeFilename(raw: string | undefined, fallback = "file"): string {
  if (!raw) return fallback;

  const base = raw.split(/[\\/]/).pop() ?? fallback;
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/^\.+/, "")
    .trim();

  if (!cleaned) return fallback;
  return cleaned.slice(0, 160);
}

export function extensionOf(filename: string): string {
  const index = filename.lastIndexOf(".");
  if (index <= 0 || index === filename.length - 1) return "";
  return filename.slice(index + 1).toLowerCase();
}

/**
 * Resolves the MIME type to store and serve. Active content types are
 * downgraded to application/octet-stream so they can only be downloaded.
 */
export function resolveMime(declared: string | undefined, filename: string): string {
  const candidate = (declared ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  const fromDeclared = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(candidate) ? candidate : "";

  if (fromDeclared && ACTIVE_TYPES.has(fromDeclared)) return "application/octet-stream";
  if (fromDeclared && fromDeclared !== "application/octet-stream") return fromDeclared;

  const fromExtension = EXTENSION_TYPES[extensionOf(filename)] ?? "";
  if (fromExtension) return fromExtension;

  if (fromDeclared) return fromDeclared;
  return "application/octet-stream";
}

export function isInlinePreview(mime: string): boolean {
  return INLINE_PREVIEW_TYPES.has(mime);
}

/** RFC 6266 Content-Disposition with an ASCII fallback and UTF-8 filename*. */
export function contentDisposition(kind: "inline" | "attachment", filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(filename);
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
