const PALETTE = new Set(["red", "orange", "green", "blue", "purple", "grey", "neutral"])
const TEXT_SIZES = new Set(["heading-2", "heading-4", "normal", "notation"])

function escape(value) {
  return (typeof value === "string" ? value : "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]
  )
}

function plainText(text) {
  return text?.tag === "plain_text" ? escape(text.content) : ""
}

function githubUrl(value) {
  if (
    typeof value !== "string" ||
    !/^https:\/\/github\.com\//.test(value) ||
    /[\s\\"'<>]/.test(value)
  )
    return null
  try {
    const url = new URL(value)
    return url.hostname === "github.com" && !url.username && !url.password && !url.port
      ? url.href
      : null
  } catch {
    return null
  }
}

function elementHtml(element, depth = 0) {
  if (!element || depth > 8) return ""
  if (element.tag === "hr") return '<hr class="divider">'
  if (element.tag === "div") {
    const size = TEXT_SIZES.has(element.text?.text_size) ? element.text.text_size : "normal"
    const muted = element.text?.text_color === "grey" ? " muted" : ""
    return `<div class="text text-${size}${muted}">${plainText(element.text)}</div>`
  }
  if (element.tag === "button") {
    const open = element.behaviors?.find((behavior) => behavior?.type === "open_url")
    const url = githubUrl(open?.default_url)
    if (!url) return ""
    const primary = element.type === "primary_filled" || element.type === "primary"
    return `<a class="button${primary ? " button-primary" : ""}" href="${escape(url)}" target="_blank" rel="noopener noreferrer">${plainText(element.text)}</a>`
  }
  if (element.tag === "column_set") {
    const columns = Array.isArray(element.columns) ? element.columns.slice(0, 12) : []
    const flow = element.flex_mode === "flow"
    return `<div class="${flow ? "actions" : "columns"}" style="--columns:${Math.max(1, columns.length)}">${columns
      .map((column) => {
        const metric = column.background_style === "metric-surface"
        return `<div class="column${metric ? " metric" : ""}">${Array.isArray(column.elements) ? column.elements.map((child) => elementHtml(child, depth + 1)).join("") : ""}</div>`
      })
      .join("")}</div>`
  }
  return `<p class="unsupported">Unsupported preview element: ${escape(element.tag)}</p>`
}

/** Offline layout approximation of the actual outbound Card JSON 2.0 payload. */
export function renderPreview(payload) {
  const card = payload?.card
  if (payload?.msg_type !== "interactive" || card?.schema !== "2.0")
    throw new Error("Preview requires an interactive Card JSON 2.0 payload")
  const header = card.header ?? {}
  const status = PALETTE.has(header.template) ? header.template : "blue"
  const tags = Array.isArray(header.text_tag_list)
    ? header.text_tag_list
        .map(
          (tag) =>
            `<span class="tag tag-${PALETTE.has(tag.color) ? tag.color : "neutral"}">${plainText(tag.text)}</span>`
        )
        .join("")
    : ""
  const elements = Array.isArray(card.body?.elements)
    ? card.body.elements.map((element) => elementHtml(element)).join("")
    : ""
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; img-src 'none'; connect-src 'none'">
<title>${plainText(header.title)} · Cognia preview</title>
<style>
* { box-sizing: border-box; }
:root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #1f2329; background: #f2f3f5; }
body { margin: 0; padding: 32px 20px 56px; }
.preview { max-width: 680px; margin: 0 auto; }
.preview-caption { margin: 0 0 22px; padding: 12px 14px; color: #515b69; background: #e9edf2; border: 1px solid #d9dfe7; border-radius: 8px; font-size: 12px; line-height: 1.6; }
.sender { display: flex; align-items: center; gap: 10px; margin: 0 0 12px; color: #465365; font-size: 13px; font-weight: 600; }
.avatar { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 9px; color: white; background: #283c53; font-size: 16px; }
.sender-detail { color: #7c8795; font-size: 11px; font-weight: 400; margin-left: 2px; }
.card { --accent: #245bdb; --tint: #edf3ff; width: 100%; background: #fff; border: 1px solid #dee3e9; border-radius: 12px; overflow: hidden; box-shadow: 0 3px 12px #1f232908; }
.status-red { --accent: #be3541; --tint: #fff0f0; }
.status-orange { --accent: #a86108; --tint: #fff5e7; }
.status-green { --accent: #238452; --tint: #ecf9f1; }
.status-purple { --accent: #7249b8; --tint: #f4efff; }
.status-grey, .status-neutral { --accent: #606b78; --tint: #f1f3f5; }
.card-header { padding: 16px 20px; background: var(--tint); border-top: 3px solid var(--accent); }
h1 { margin: 0; color: var(--accent); font-size: 18px; line-height: 1.45; font-weight: 650; letter-spacing: -.2px; overflow-wrap: anywhere; }
.subtitle { margin: 6px 0 0; color: #657082; font-size: 12px; line-height: 1.6; white-space: pre-line; overflow-wrap: anywhere; }
.tags { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
.tag { display: inline-flex; padding: 2px 7px; border-radius: 5px; color: #526070; background: #ffffffb8; font-size: 10px; font-weight: 600; line-height: 1.6; }
.tag-red { color: #be3541; }.tag-green { color: #238452; }.tag-orange { color: #a86108; }
.card-body { display: flex; flex-direction: column; gap: 12px; padding: 20px; }
.text { margin: 0; font-size: 13px; line-height: 1.65; white-space: pre-line; overflow-wrap: anywhere; }
.text-heading-2 { font-size: 23px; line-height: 1.35; font-weight: 650; letter-spacing: -.5px; }
.text-heading-4 { font-size: 13px; font-weight: 650; line-height: 1.5; }
.text-notation { color: #748092; font-size: 11px; line-height: 1.6; }
.muted { color: #748092; }
.columns { display: grid; grid-template-columns: repeat(var(--columns), minmax(0, 1fr)); gap: 12px; }
.column { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.metric { padding: 12px; border-radius: 8px; background: #f5f6f8; }
.divider { width: 100%; height: 1px; margin: 2px 0; border: 0; background: #ebedf0; }
.actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 2px; }
.button { display: inline-flex; align-items: center; justify-content: center; width: fit-content; max-width: 100%; min-height: 34px; padding: 6px 12px; border-radius: 6px; border: 1px solid #d4dbe5; background: white; color: #3f4c60; text-decoration: none; font-size: 12px; font-weight: 550; line-height: 1.5; text-align: center; overflow-wrap: anywhere; }
.button-primary { color: white; background: #3370ff; border-color: #3370ff; }
.button:hover { filter: brightness(.96); }.button:focus-visible { outline: 3px solid #84aaff; outline-offset: 3px; }
.unsupported { padding: 10px; color: #8a5a13; background: #fff6e8; font-size: 12px; overflow-wrap: anywhere; }
.preview-footnote { margin-top: 14px; color: #7c8795; font-size: 11px; line-height: 1.7; }
@media (max-width: 480px) {
  body { padding: 18px 12px 32px; }
  .preview-caption { margin-bottom: 16px; font-size: 11px; }
  .card-header { padding: 14px 16px; }
  .card-body { padding: 16px; gap: 12px; }
  h1 { font-size: 17px; }
  .columns { gap: 8px; }
  .metric { padding: 10px; }
  .text-heading-2 { font-size: 20px; }
  .text-notation { font-size: 10px; }
  .button { padding: 6px 10px; font-size: 11px; }
}
</style>
</head>
<body>
<main class="preview">
<p class="preview-caption">Local layout preview · verify final appearance in Feishu</p>
<div class="sender"><span class="avatar" aria-hidden="true">C</span>Cognia<span class="sender-detail">Workflow notifications</span></div>
<article class="card status-${status}" aria-label="Workflow notification card">
<header class="card-header"><h1>${plainText(header.title)}</h1>${header.subtitle ? `<p class="subtitle">${plainText(header.subtitle)}</p>` : ""}${tags ? `<div class="tags">${tags}</div>` : ""}</header>
<div class="card-body">${elements}</div>
</article>
<p class="preview-footnote">Rendered from the outbound JSON payload. Feishu may apply different fonts, spacing, and client-specific layout.</p>
</main>
</body>
</html>`
}
