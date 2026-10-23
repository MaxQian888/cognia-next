/**
 * Slack `mrkdwn` → CommonMark, for the inbound Block Kit projection.
 *
 * mrkdwn looks like Markdown but disagrees on the basics: `*x*` is bold,
 * `_x_` italic, `~x~` strikethrough, links are `<url|label>`, mentions are
 * `<@U123>` / `<#C123|name>` / `<!here>`, the three HTML-significant
 * characters arrive entity-escaped, and a single newline is a line break.
 * Shown as-is, a section reads as markup soup; rendered as CommonMark
 * unconverted, `*bold*` comes out italic and every link disappears.
 *
 * The entities stay escaped in prose (CommonMark decodes them, and a bare
 * `<` would open raw HTML); code gets them decoded, since CommonMark shows
 * code verbatim.
 *
 * Code spans and fences are copied through untouched (mrkdwn does not format
 * inside them either). See https://api.slack.com/reference/surfaces/formatting
 */

import { markdownLinkDestination, preserveLineBreaks } from "../_shared/inbound-markdown"

function unescapeEntities(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
}

/** Escape what CommonMark would read as link syntax inside a label. */
function escapeLabel(label: string): string {
  return label.replace(/[[\]]/g, "\\$&")
}

function convertAngle(body: string): string {
  const pipe = body.indexOf("|")
  const target = pipe === -1 ? body : body.slice(0, pipe)
  const label = pipe === -1 ? undefined : body.slice(pipe + 1)
  if (target.startsWith("@")) return `@${label ?? target.slice(1)}`
  if (target.startsWith("#")) return `#${label ?? target.slice(1)}`
  if (target.startsWith("!")) {
    const command = target.slice(1)
    if (command === "here" || command === "channel" || command === "everyone") return `@${command}`
    // `<!subteam^ID|@team>`, `<!date^…|fallback>`: the label is the readable form.
    return label ?? `@${command.split("^")[0]}`
  }
  const url = unescapeEntities(target)
  return `[${escapeLabel(label ?? target)}](${markdownLinkDestination(url)})`
}

/** Convert emphasis + links in a run of text that holds no code. */
function convertInline(text: string): string {
  let out = text.replace(/<([^<>\n]+)>/g, (_m, body: string) => convertAngle(body))
  // Emphasis markers only count at a word edge, as in Slack's own renderer.
  out = out.replace(/(^|[\s(>"'])\*(?!\s)([^*\n]+?)(?<!\s)\*(?=$|[\s).,!?:;"'<])/g, "$1**$2**")
  out = out.replace(/(^|[\s(>"'])_(?!\s)([^_\n]+?)(?<!\s)_(?=$|[\s).,!?:;"'<])/g, "$1*$2*")
  out = out.replace(/(^|[\s(>"'])~(?!\s)([^~\n]+?)(?<!\s)~(?=$|[\s).,!?:;"'<])/g, "$1~~$2~~")
  // A quote marker arrives escaped like any other `>`; restore it at line start.
  return out.replace(/^&gt;/gm, ">")
}

export function slackMrkdwnToMarkdown(source: string): string {
  // Split out fences first, then inline code spans; convert only prose.
  const pieces = source.split(/(```[\s\S]*?```)/g)
  const converted = pieces
    .map((piece) => {
      if (piece.startsWith("```") && piece.endsWith("```") && piece.length >= 6) {
        const inner = unescapeEntities(piece.slice(3, -3)).replace(/^\n|\n$/g, "")
        return `\n\`\`\`\n${inner}\n\`\`\`\n`
      }
      return piece
        .split(/(`[^`\n]+`)/g)
        .map((span) =>
          span.startsWith("`") && span.endsWith("`") && span.length >= 2
            ? unescapeEntities(span)
            : convertInline(span)
        )
        .join("")
    })
    .join("")
  return preserveLineBreaks(converted.replace(/^\n+|\n+$/g, ""))
}
