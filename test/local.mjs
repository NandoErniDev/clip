/**
 * End-to-end HTTP tests against a running Worker.
 *
 *   npm run test:local                              # local Miniflare
 *   BASE_URL=https://clip.naerdev.ch node test/local.mjs
 */

const BASE = (process.env.BASE_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const ORIGIN = new URL(BASE).origin;

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

async function call(path, { token, method = "GET", body, cookie, origin = ORIGIN } = {}) {
  const headers = {};
  if (origin) headers.origin = origin;
  if (token) headers.authorization = `Bearer ${token}`;
  if (cookie) headers.cookie = cookie;
  if (body !== undefined && !(body instanceof FormData)) headers["content-type"] = "application/json";

  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    redirect: "manual",
  });

  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, text, json };
}

function upload(buffer, name, type) {
  const form = new FormData();
  form.append("file", new Blob([buffer], { type }), name);
  return form;
}

const newClipboard = () => call("/api/clipboards", { method: "POST", body: {} });

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");

async function main() {
  console.log(`Clip integration tests against ${BASE}`);

  section("Health and static assets");
  const health = await call("/api/health");
  check("health returns ok", health.status === 200 && health.json?.ok === true);

  const page = await call("/");
  check("index document is served", page.status === 200 && page.text.includes("<div id=\"app\""), `status ${page.status}`);
  check("index has a restrictive CSP", (page.headers.get("content-security-policy") ?? "").includes("frame-ancestors 'none'"));
  check("index is not cached", (page.headers.get("cache-control") ?? "").includes("no-cache"));
  check("index sends nosniff", page.headers.get("x-content-type-options") === "nosniff");

  section("Authentication");
  const anonymous = await call("/api/clipboard");
  check("clipboard requires a token", anonymous.status === 401 && anonymous.json?.error?.code === "missing_token");

  const created = await newClipboard();
  const token = created.json?.token;
  check("clipboard creation succeeds", created.status === 201, `status ${created.status}`);
  check("token format is CLIP-XXXX", /^CLIP(-[0-9A-HJKMNP-TV-Z]{4}){8}$/.test(token ?? ""), token);
  check("creation sets a session cookie", (created.headers.get("set-cookie") ?? "").includes("HttpOnly"));
  check("new clipboard is empty", created.json?.clipboard?.itemCount === 0 && created.json?.clipboard?.usedBytes === 0);
  check("lifetime is 24 hours", created.json?.clipboard?.expiresAt - created.json?.clipboard?.createdAt === 86_400_000);
  const cookie = (created.headers.get("set-cookie") ?? "").split(";")[0];

  const connect = await call("/api/session", { method: "POST", body: { token } });
  check("token opens the clipboard", connect.status === 200);
  check("connect issues a cookie", (connect.headers.get("set-cookie") ?? "").includes("clip_session="));
  check("tokens are case and dash insensitive", (await call("/api/session", { method: "POST", body: { token: token.toLowerCase() } })).status === 200);
  check("malformed token is rejected", (await call("/api/session", { method: "POST", body: { token: "CLIP-ABCD" } })).status === 401);

  const unknown = await call("/api/session", {
    method: "POST",
    body: { token: "CLIP-0000-0000-0000-0000-0000-0000-0000-0000" },
  });
  check("unknown token is rejected", unknown.status === 401 && unknown.json?.error?.code === "invalid_token");
  check("session cookie authenticates reads", (await call("/api/clipboard", { cookie })).status === 200);

  section("Text items");
  const textItem = "Hello from Clip — line two.\nThird line.";
  const addedText = await call("/api/items", { token, method: "POST", body: { text: textItem } });
  check("text item is created", addedText.status === 201, `status ${addedText.status}`);
  check("text is counted in storage", addedText.json?.clipboard?.usedBytes === Buffer.byteLength(textItem));
  check("text item exposes a preview", addedText.json?.item?.preview?.startsWith("Hello from Clip"));
  const textId = addedText.json?.item?.id;
  check("empty text is rejected", (await call("/api/items", { token, method: "POST", body: { text: "   " } })).status === 400);

  const fetchedText = await call(`/api/items/${textId}/content`, { token });
  check("text content round-trips", fetchedText.status === 200 && fetchedText.text === textItem);
  check("text download is an attachment", (fetchedText.headers.get("content-disposition") ?? "").startsWith("attachment"));

  section("Uploads");
  const png = await call("/api/items", { token, method: "POST", body: upload(PNG, "Pixel.png", "image/png") });
  check("PNG upload succeeds", png.status === 201, `status ${png.status}`);
  check("PNG is marked inline", png.json?.item?.inline === true);
  check("PNG size is stored", png.json?.item?.size === PNG.length);

  const imageContent = await call(png.json.item.contentUrl, { token });
  check("image streams back", imageContent.status === 200);
  check("image content type preserved", imageContent.headers.get("content-type") === "image/png");
  check("image is served inline", (imageContent.headers.get("content-disposition") ?? "").startsWith("inline"));
  check("image response is sandboxed", (imageContent.headers.get("content-security-policy") ?? "").includes("sandbox"));
  check(
    "image download forces attachment",
    ((await call(`${png.json.item.contentUrl}?download=1`, { token })).headers.get("content-disposition") ?? "").startsWith("attachment"),
  );

  const pdfUpload = await call("/api/items", { token, method: "POST", body: upload(PDF, "notes.pdf", "application/pdf") });
  check("PDF upload succeeds", pdfUpload.status === 201);
  check("PDF is not inline", pdfUpload.json?.item?.inline === false);
  const pdfContent = await call(pdfUpload.json.item.contentUrl, { token });
  check("PDF is served as attachment", (pdfContent.headers.get("content-disposition") ?? "").startsWith("attachment"));
  check("PDF keeps its type", pdfContent.headers.get("content-type") === "application/pdf");

  const markup = Buffer.from("<!doctype html><h1>uploaded document</h1>");
  const markupUpload = await call("/api/items", { token, method: "POST", body: upload(markup, "page.html", "text/html") });
  check("HTML upload is neutralised", markupUpload.status === 201 && markupUpload.json?.item?.mime === "application/octet-stream");
  const markupContent = await call(markupUpload.json.item.contentUrl, { token });
  check(
    "HTML is never served as HTML",
    markupContent.headers.get("content-type") === "application/octet-stream" &&
      (markupContent.headers.get("content-disposition") ?? "").startsWith("attachment"),
  );

  const windowsPath = "C:\\Users\\me\\clips\\report.pdf";
  const renamed = await call("/api/items", { token, method: "POST", body: upload(PDF, windowsPath, "application/pdf") });
  check("upload names keep only the base name", renamed.json?.item?.name === "report.pdf", renamed.json?.item?.name);

  section("Deletion and isolation");
  const otherToken = (await newClipboard()).json.token;
  check("tokens cannot read other clipboards", (await call(`/api/items/${textId}/content`, { token: otherToken })).status === 404);
  check("tokens cannot delete other clipboards", (await call(`/api/items/${textId}`, { token: otherToken, method: "DELETE" })).status === 404);

  const beforeDelete = await call("/api/clipboard", { token });
  const deleted = await call(`/api/items/${textId}`, { token, method: "DELETE" });
  check("item deletion works", deleted.status === 200 && !deleted.json.clipboard.items.some((item) => item.id === textId));
  check("deleted content is unreachable", (await call(`/api/items/${textId}/content`, { token })).status === 404);
  check(
    "storage is released",
    deleted.json.clipboard.usedBytes === beforeDelete.json.clipboard.usedBytes - Buffer.byteLength(textItem),
    `${beforeDelete.json.clipboard.usedBytes} -> ${deleted.json.clipboard.usedBytes}`,
  );

  const cleared = await call("/api/clipboard/items", { token, method: "DELETE" });
  check("clear all empties the clipboard", cleared.status === 200 && cleared.json.clipboard.itemCount === 0);
  check("clear all releases storage", cleared.json.clipboard.usedBytes === 0);

  section("Origin protection");
  check(
    "cross-origin writes are blocked",
    (await call("/api/items", { token, method: "POST", body: { text: "nope" }, origin: "https://other.example" })).status === 403,
  );

  section("Limits");
  check(
    "files over 5 MB are rejected",
    (await call("/api/items", { token, method: "POST", body: upload(Buffer.alloc(6 * 1024 * 1024, 7), "big.pdf", "application/pdf") })).status === 413,
  );
  check(
    "text over 256 KB is rejected",
    (await call("/api/items", { token, method: "POST", body: { text: "x".repeat(300 * 1024) } })).status === 413,
  );

  const fullToken = (await newClipboard()).json.token;
  let lastStatus = 0;
  for (let index = 0; index < 20; index += 1) {
    lastStatus = (await call("/api/items", { token: fullToken, method: "POST", body: { text: `item ${index}` } })).status;
  }
  check("20 items fit", lastStatus === 201, `last status ${lastStatus}`);
  const twentyFirst = await call("/api/items", { token: fullToken, method: "POST", body: { text: "overflow" } });
  check("21st item is rejected", twentyFirst.status === 409 && twentyFirst.json?.error?.code === "item_limit");

  const concurrentToken = (await newClipboard()).json.token;
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      call("/api/items", { token: concurrentToken, method: "POST", body: { text: `parallel ${index}` } }),
    ),
  );
  check("parallel writes all succeed", results.every((result) => result.status === 201));
  const concurrentState = await call("/api/clipboard", { token: concurrentToken });
  check("parallel writes keep counters exact", concurrentState.json.clipboard.itemCount === 8);
  check(
    "parallel writes keep byte counts exact",
    concurrentState.json.clipboard.usedBytes ===
      Array.from({ length: 8 }, (_, index) => Buffer.byteLength(`parallel ${index}`)).reduce((a, b) => a + b, 0),
  );

  const totalToken = (await newClipboard()).json.token;
  const fiveMb = Buffer.alloc(5 * 1024 * 1024, 3);
  let uploadStatus = 0;
  for (let index = 0; index < 4; index += 1) {
    uploadStatus = (await call("/api/items", { token: totalToken, method: "POST", body: upload(fiveMb, `part-${index}.pdf`, "application/pdf") })).status;
  }
  check("four 5 MB files fill the clipboard", uploadStatus === 201, `last status ${uploadStatus}`);
  const overTotal = await call("/api/items", { token: totalToken, method: "POST", body: { text: "one byte over" } });
  check(
    "total storage limit is enforced",
    overTotal.status === 413 && overTotal.json?.error?.code === "storage_limit",
    `status ${overTotal.status}`,
  );

  section("Disconnect");
  const disconnected = await call("/api/session", { method: "DELETE" });
  check("disconnect succeeds", disconnected.status === 204);
  check("disconnect clears the cookie", /Max-Age=0/.test(disconnected.headers.get("set-cookie") ?? ""));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("\nFailures:");
    for (const failure of failures) console.log(` - ${failure}`);
    process.exitCode = 1;
  }
}

await main();
