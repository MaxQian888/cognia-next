/**
 * What a Bot writes back to GitHub, made safe to read again.
 *
 * GitHub never marks a Bot's own comment as self-produced, so a Bot that
 * reacts to comments must recognise its output itself:
 *
 *  - every comment it writes carries an invisible marker
 *    (`<!-- <namespace>:v1:<id> -->`), and its parser skips any comment
 *    carrying one. Copying the marker into a human comment only makes that
 *    comment ignored; ownership of an output is the Bot's own durable record,
 *    never the marker;
 *  - its own mention never appears live in what it writes, so the output
 *    cannot address the Bot (or notify it) even when the writer and the
 *    commenter are the same account (a personal-token install).
 */

import { maskMarkdown, normalizeNewlines } from "./markdown"

const NAMESPACE = /^[a-z0-9][a-z0-9-]{0,39}$/
const MARKER_ID = /^[A-Za-z0-9_-]{1,64}$/

export function renderOutputMarker(namespace: string, id: string): string {
  if (!NAMESPACE.test(namespace)) throw new Error("Invalid output marker namespace")
  if (!MARKER_ID.test(id)) throw new Error("Invalid output marker id")
  return `<!-- ${namespace}:v1:${id} -->`
}

/** The id of the first marker of `namespace` in `body`, if any. */
export function findOutputMarker(body: string, namespace: string): string | undefined {
  if (!NAMESPACE.test(namespace)) throw new Error("Invalid output marker namespace")
  const pattern = new RegExp(`<!--\\s*${namespace}:v1:([A-Za-z0-9_-]{1,64})\\s*-->`)
  return pattern.exec(body)?.[1]
}

/**
 * Wrap every live occurrence of `mention` in inline code: GitHub neither
 * links nor notifies a mention inside code, and the command parser masks it.
 * Mentions already in code stay as they are.
 */
export function neutralizeMention(text: string, mention: string): string {
  const source = normalizeNewlines(text)
  const masked = maskMarkdown(source, { quotes: false })
  const name = mention.replace(/^@/, "").replace(/\[bot\]$/i, "")
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const pattern = new RegExp(`(?<![A-Za-z0-9_/-])@${escaped}(?:\\[bot\\])?(?![A-Za-z0-9-])`, "gi")
  const sourceLines = source.split("\n")
  return masked
    .split("\n")
    .map((maskedLine, index) => {
      const line = sourceLines[index]
      let out = ""
      let cursor = 0
      for (const match of maskedLine.matchAll(pattern)) {
        const start = match.index ?? 0
        const end = start + match[0].length
        out += `${line.slice(cursor, start)}\`${line.slice(start, end)}\``
        cursor = end
      }
      return out + line.slice(cursor)
    })
    .join("\n")
}

/** A Bot comment body: the neutralised text, then the marker on its own line. */
export function renderBotComment(
  text: string,
  options: { namespace: string; id: string; mention?: string }
): string {
  const body = options.mention ? neutralizeMention(text, options.mention) : normalizeNewlines(text)
  return `${body.replace(/\s+$/, "")}\n\n${renderOutputMarker(options.namespace, options.id)}`
}
