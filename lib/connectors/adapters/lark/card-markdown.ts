/**
 * Lark card Markdown (`markdown` component, legacy `div` `lark_md` text) →
 * CommonMark, for the inbound projection.
 *
 * Lark's dialect is CommonMark plus platform tags. Left alone, those tags are
 * either shown literally or stripped together with the content they carry by
 * the chat renderer's sanitizer (a mention `<at id=…></at>` has no inner
 * text). This keeps their meaning as plain Markdown:
 *
 *   - `<at id=all></at>` / `<at user_id="ou_x">Name</at>` → `@all` / `@Name`
 *   - `<link url="…">label</link>` → `[label](…)`
 *   - `<text_tag …>x</text_tag>` → `` `x` ``
 *   - `<font …>`, `<number_tag>`, other styling tags → their inner text
 *   - `<br>` and single newlines → hard line breaks
 *
 * See https://open.feishu.cn/document/feishu-cards/card-json-v2-components/content-components/rich-text
 */

import {
  markdownLinkDestination,
  preserveLineBreaks,
  splitMarkdownCode,
} from "../_shared/inbound-markdown"

function attr(attrs: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(attrs)
  return match ? (match[1] ?? match[2] ?? match[3]) : undefined
}

// Every pattern stops at the next `<` (attributes and inner text never span a
// tag), so each match attempt is bounded by the distance to the next tag and
// a run of unmatched opening tags stays linear.

/** Tags whose content is kept and whose markup is styling only. */
const STYLING_TAGS = /<\/?(?:font|number_tag|local_datetime|person|standard_icon)\b[^<>]*>/gi

function convertTags(prose: string): string {
  let text = prose.replace(STYLING_TAGS, "")
  text = text.replace(/<at\b([^<>]*)>([^<]*)<\/at>/gi, (_m, attrs: string, inner: string) => {
    const name = inner.trim()
    if (name) return name.startsWith("@") ? name : `@${name}`
    const id = attr(attrs, "id") ?? attr(attrs, "user_id") ?? attr(attrs, "open_id")
    const email = attr(attrs, "email")
    return `@${id ?? email ?? "user"}`
  })
  text = text.replace(/<link\b([^<>]*)>([^<]*)<\/link>/gi, (_m, attrs: string, inner: string) => {
    const url = attr(attrs, "url") ?? attr(attrs, "pc_url")
    const label = inner.trim() || url || ""
    return url ? `[${label}](${markdownLinkDestination(url)})` : label
  })
  text = text.replace(/<text_tag\b[^<>]*>([^<]*)<\/text_tag>/gi, (_m, inner: string) =>
    inner.trim() ? `\`${inner.trim()}\`` : ""
  )
  return text.replace(/<br\s*\/?>/gi, "\n")
}

export function larkCardMarkdownToCommonMark(source: string): string {
  // Platform tags are only markup in prose; inside a fence or a code span
  // they are literal text the sender meant to show.
  const converted = splitMarkdownCode(source)
    .map((chunk) => (chunk.code ? chunk.text : convertTags(chunk.text)))
    .join("")
  return preserveLineBreaks(converted)
}
