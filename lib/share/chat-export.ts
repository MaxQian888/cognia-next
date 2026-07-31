// Bridges the existing single-export renderer to a share payload: fetch the
// session's messages, render in the chosen format, wrap as a SharePayload.
// Reuses `renderSingleExport` verbatim so shared output matches downloaded output.

import { renderSingleExport, type SingleExportFormat } from "@/lib/export/single"
import { getDb } from "@/lib/db/schema"
import { resolveThemeWallpaper } from "@/lib/export/html/theme-wallpaper"
import { chatExportPayload } from "./payload"
import type { SharePayload } from "./types"
import type { ChatSession, StoredMessage } from "@cognia/agent-config-types"
import type { ThemeId, ThemeTokens } from "@/lib/export/html/syntax-themes"

export interface BuildChatShareArgs {
  format: SingleExportFormat
  session: ChatSession
  theme?: ThemeId
  customTheme?: ThemeTokens
  includeMetadata?: boolean
  includeTimestamps?: boolean
  includeTokens?: boolean
  /** Lay the theme's real wallpaper behind the export (HTML/animated only). */
  withWallpaper?: boolean
}

export interface MultiChatShareCopy {
  count: string
  navigationLabel: string
  previous: string
  next: string
  frameTitle: string
}

export interface BuildMultiChatShareArgs extends Omit<
  BuildChatShareArgs,
  "format" | "session" | "includeTokens"
> {
  sessions: ChatSession[]
  title: string
  copy: MultiChatShareCopy
  lang?: string
}

export async function buildChatSharePayload(args: BuildChatShareArgs): Promise<SharePayload> {
  const messages = await getDb()
    .messages.where("sessionId")
    .equals(args.session.id)
    .sortBy("createdAt")
  const wallpaperDataUrl = await resolveThemeWallpaper(args.theme, args.withWallpaper ?? false)
  const rendered = renderSingleExport({
    format: args.format,
    session: args.session,
    messages,
    theme: args.theme,
    customTheme: args.customTheme,
    includeMetadata: args.includeMetadata,
    includeTimestamps: args.includeTimestamps,
    includeTokens: args.includeTokens,
    wallpaperDataUrl,
  })
  return chatExportPayload(rendered, args.format, args.session.title || "Conversation")
}

/**
 * Build one encrypted share containing several conversations.
 *
 * Each transcript still goes through `renderSingleExport`; the bundle only
 * supplies navigation around those canonical documents. The recipient view
 * keeps a single sandboxed iframe mounted and swaps its `srcdoc`, so selecting
 * many conversations does not mount every transcript at once.
 */
export async function buildMultiChatSharePayload(
  args: BuildMultiChatShareArgs
): Promise<SharePayload> {
  if (args.sessions.length === 0) {
    throw new Error("At least one conversation is required to build a multi-chat share")
  }

  const db = getDb()
  const sessionIds = args.sessions.map((session) => session.id)
  const [wallpaperDataUrl, rows] = await Promise.all([
    resolveThemeWallpaper(args.theme, args.withWallpaper ?? false),
    db.messages.where("sessionId").anyOf(sessionIds).sortBy("createdAt"),
  ])
  const messagesBySession = new Map<string, StoredMessage[]>()
  for (const row of rows) {
    const messages = messagesBySession.get(row.sessionId)
    if (messages) messages.push(row)
    else messagesBySession.set(row.sessionId, [row])
  }
  const exportedAt = new Date()
  const conversations = args.sessions.map((session) => ({
    title: session.title || args.copy.frameTitle,
    html: renderSingleExport({
      format: "html",
      session,
      messages: messagesBySession.get(session.id) ?? [],
      exportedAt,
      theme: args.theme,
      customTheme: args.customTheme,
      includeMetadata: args.includeMetadata,
      includeTimestamps: args.includeTimestamps,
      wallpaperDataUrl,
    }).content,
  }))

  return {
    kind: "chat-animated",
    mime: "text/html",
    data: renderMultiChatDocument({
      title: args.title,
      conversations,
      copy: args.copy,
      lang: args.lang ?? "en",
    }),
    encoding: "utf8",
    title: args.title,
  }
}

function renderMultiChatDocument({
  title,
  conversations,
  copy,
  lang,
}: {
  title: string
  conversations: Array<{ title: string; html: string }>
  copy: MultiChatShareCopy
  lang: string
}): string {
  const serialized = serializeForInlineScript({ conversations, copy })
  return `<!DOCTYPE html>
<html lang="${escapeHtml(lang)}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; background: #09090b; color: #fafafa; }
.shell { display: grid; grid-template-rows: auto auto minmax(0, 1fr); min-height: 100vh; }
.topbar { display: flex; align-items: center; gap: 16px; padding: 18px 20px 14px; border-bottom: 1px solid #27272a; background: rgba(9, 9, 11, .92); backdrop-filter: blur(16px); }
.heading { min-width: 0; flex: 1; }
.eyebrow { margin-bottom: 3px; color: #a1a1aa; font-size: 12px; }
h1 { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 18px; }
.pager { display: flex; align-items: center; gap: 8px; }
.pager button { display: grid; place-items: center; width: 34px; height: 34px; border: 1px solid #3f3f46; border-radius: 10px; background: #18181b; color: inherit; cursor: pointer; transition: border-color .18s ease, background .18s ease, transform .18s ease; }
.pager button:hover:not(:disabled) { border-color: #71717a; background: #27272a; transform: translateY(-1px); }
.pager button:disabled { cursor: default; opacity: .35; }
#position { min-width: 48px; text-align: center; color: #d4d4d8; font-variant-numeric: tabular-nums; font-size: 12px; }
.rail { display: flex; gap: 8px; overflow-x: auto; padding: 10px 20px; border-bottom: 1px solid #27272a; scrollbar-width: thin; }
.rail button { max-width: min(280px, 70vw); flex: 0 0 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border: 1px solid transparent; border-radius: 999px; padding: 7px 12px; background: #18181b; color: #a1a1aa; cursor: pointer; transition: color .18s ease, border-color .18s ease, background .18s ease, transform .18s ease; }
.rail button:hover { color: #fafafa; transform: translateY(-1px); }
.rail button[aria-current="true"] { border-color: #52525b; background: #27272a; color: #fafafa; }
.viewer { min-height: 0; padding: 12px; overflow: hidden; }
.viewer iframe { display: block; width: 100%; height: calc(100vh - 134px); min-height: 420px; border: 1px solid #27272a; border-radius: 14px; background: #fff; opacity: 1; transform: translateX(0) scale(1); transition: opacity .18s ease, transform .18s ease; }
.viewer.is-changing iframe { opacity: 0; transform: translateX(10px) scale(.995); }
@media (max-width: 600px) {
  .topbar { padding: 14px 12px 10px; }
  .rail { padding: 8px 12px; }
  .viewer { padding: 8px; }
  .viewer iframe { height: calc(100vh - 120px); min-height: 360px; border-radius: 10px; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; transition-duration: 0s !important; animation-duration: 0s !important; }
}
</style>
</head>
<body>
<div class="shell">
  <header class="topbar">
    <div class="heading">
      <div class="eyebrow">${escapeHtml(copy.count)}</div>
      <h1>${escapeHtml(title)}</h1>
    </div>
    <div class="pager">
      <button id="previous" type="button" aria-label="${escapeHtml(copy.previous)}">←</button>
      <span id="position" aria-live="polite"></span>
      <button id="next" type="button" aria-label="${escapeHtml(copy.next)}">→</button>
    </div>
  </header>
  <nav id="rail" class="rail" aria-label="${escapeHtml(copy.navigationLabel)}"></nav>
  <main id="viewer" class="viewer">
    <iframe id="conversation" sandbox="" title="${escapeHtml(copy.frameTitle)}"></iframe>
  </main>
</div>
<script id="share-data" type="application/json">${serialized}</script>
<script>
(() => {
  const data = JSON.parse(document.getElementById("share-data").textContent);
  const items = data.conversations;
  const rail = document.getElementById("rail");
  const viewer = document.getElementById("viewer");
  const frame = document.getElementById("conversation");
  const position = document.getElementById("position");
  const previous = document.getElementById("previous");
  const next = document.getElementById("next");
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let active = 0;
  const buttons = items.map((item, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = item.title;
    button.title = item.title;
    button.addEventListener("click", () => show(index));
    rail.appendChild(button);
    return button;
  });

  function commit(index) {
    active = index;
    const item = items[index];
    frame.title = data.copy.frameTitle + ": " + item.title;
    frame.onload = () => viewer.classList.remove("is-changing");
    frame.srcdoc = item.html;
    buttons.forEach((button, buttonIndex) => {
      if (buttonIndex === index) button.setAttribute("aria-current", "true");
      else button.removeAttribute("aria-current");
    });
    buttons[index].scrollIntoView({ block: "nearest", inline: "nearest" });
    position.textContent = (index + 1) + " / " + items.length;
    previous.disabled = index === 0;
    next.disabled = index === items.length - 1;
    if (reduceMotion) viewer.classList.remove("is-changing");
  }

  function show(index) {
    if (index < 0 || index >= items.length || index === active) return;
    if (reduceMotion) commit(index);
    else {
      viewer.classList.add("is-changing");
      window.setTimeout(() => commit(index), 120);
    }
  }

  previous.addEventListener("click", () => show(active - 1));
  next.addEventListener("click", () => show(active + 1));
  document.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft") show(active - 1);
    if (event.key === "ArrowRight") show(active + 1);
  });
  commit(0);
})();
</script>
</body>
</html>`
}

function serializeForInlineScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}
