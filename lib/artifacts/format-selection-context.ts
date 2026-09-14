/**
 * Format staged context selections into a block prepended to the outgoing chat
 * message, so the assistant sees the exact material the user pointed at plus
 * their comment. Pure + framework-free for easy testing.
 *
 * Seven kinds share this pipeline (artifact / file / comment / web / external /
 * plugin / entity). Each gets
 * its own heading so the assistant can tell a snippet it may be asked to revise
 * from a page it may only cite — the artifact heading is load-bearing for that
 * reason, not decoration.
 */

import type {
  ArtifactSelectionRef,
  ContextSelectionRef,
  EntityExcerpt,
  EntityExcerptDerivation,
  EntitySelectionKind,
  EntitySelectionRef,
  FileSelectionRef,
} from "@/types/artifact/artifact"
import type { ContextCommentAnchor } from "@/types/context-comment"
import type { ElementSelectionCore } from "@/types/element-selection"

/** `12-18`, or a bare `12` when the range covers a single line. */
function rangeLabel(range: { startLine: number; endLine: number }): string {
  return range.endLine > range.startLine
    ? `${range.startLine}-${range.endLine}`
    : `${range.startLine}`
}

/**
 * How a comment's anchor reads inside the prompt heading above.
 *
 * English on purpose, like every other string in this file: it is prompt
 * scaffolding for the assistant, not UI copy, so it must not follow the user's
 * locale. It lives here rather than in the comments panel for exactly that
 * reason — in a `.tsx` it read as an untranslated interface string, and it had
 * grown its own copy of the line-range formatting `rangeLabel` already owns.
 *
 * Offsets mean nothing to the assistant on their own, so a text range prefers
 * line numbers and otherwise names the quoted text instead of raw positions.
 */
export function commentAnchorLabel(anchor: ContextCommentAnchor): string | undefined {
  switch (anchor.kind) {
    case "text-range":
      if (anchor.lineRange) {
        const { startLine, endLine } = anchor.lineRange
        return endLine > startLine
          ? `lines ${rangeLabel(anchor.lineRange)}`
          : `line ${rangeLabel(anchor.lineRange)}`
      }
      return anchor.quotedText ? `on "${anchor.quotedText}"` : undefined
    case "workflow-node":
      return `node ${anchor.nodeId}`
    case "workflow-edge":
      return `edge ${anchor.edgeId}`
    case "resource":
      return undefined
  }
}

/** `:12`, `:12-18`, or nothing when the citation names a whole file. */
function citationLines(citation: { startLine?: number; endLine?: number }): string {
  if (citation.startLine === undefined) return ""
  const end = citation.endLine ?? citation.startLine
  return end > citation.startLine ? `:${citation.startLine}-${end}` : `:${citation.startLine}`
}

/**
 * How each referenced record is NAMED to the assistant.
 *
 * English, like every other string in this file: it is prompt scaffolding, not
 * UI copy, and must not follow the user's locale. The noun is load-bearing —
 * "Conversation" tells the model the block is a transcript it may cite, where
 * "Plan" tells it the block is work it may be asked to continue. Collapsing
 * them into one generic heading is exactly the information the model needs to
 * tell those two apart.
 */
const ENTITY_NOUNS: Record<EntitySelectionKind, string> = {
  memory: "Stored memory",
  issue: "Issue",
  plan: "Plan",
  session: "Another conversation",
  message: "A message from another conversation",
  result: "A result produced in another conversation",
  artifact: "Artifact",
  // Not "a teammate": the block is the ROLE, not something the member said.
  // A model handed "Reviewer" plus a description and a spawn prompt has to
  // know it is being told how to answer, not shown a transcript.
  teammate: "A Squad teammate's role definition",
}

/**
 * The nouns for a record that lives in the conversation being written in.
 *
 * `ENTITY_NOUNS` said "from another conversation" for every message and result,
 * which was false the moment a reference could be made from the transcript the
 * user is looking at — and a model told a turn came from elsewhere reasons about
 * it as context it has not seen, rather than as something earlier in this thread.
 */
const SAME_CONVERSATION_NOUNS: Partial<Record<EntitySelectionKind, string>> = {
  message: "A message from earlier in this conversation",
  result: "A result produced earlier in this conversation",
}

/** Plural headings for a combined reference, by where its members came from. */
const MEMBER_NOUNS: Partial<Record<EntitySelectionKind, { same: string; other: string }>> = {
  message: {
    same: "messages from earlier in this conversation, in order",
    other: "messages from another conversation, in order",
  },
}

/**
 * How an excerpt's body is introduced, by what the body is.
 *
 * The three generated kinds say so. A model told "text from a message" when the
 * body is a summary the app wrote would quote the summary back as something the
 * conversation said.
 */
const EXCERPT_LEADS: Record<EntityExcerptDerivation, string> = {
  quote: "Text the user selected from",
  summary: "A summary, generated by the app, of text the user selected from",
  explanation: "An explanation, generated by the app, of text the user selected from",
  translation: "A translation, generated by the app, of text the user selected from",
}

/** Where an excerpt was selected, by how many records it runs across. */
const EXCERPT_SOURCES: Partial<Record<EntitySelectionKind, { one: string; many: string }>> = {
  message: { one: "a message", many: "messages" },
  result: { one: "a result", many: "results" },
}

function excerptHeading(
  sel: EntitySelectionRef & { excerpt: EntityExcerpt },
  same: boolean
): string {
  const count = sel.members && sel.members.length > 1 ? sel.members.length : 1
  const nouns = EXCERPT_SOURCES[sel.entityKind] ?? { one: "a record", many: "records" }
  const where = same ? "earlier in this conversation" : "in another conversation"
  const source = count > 1 ? `${count} ${nouns.many} ${where}` : `${nouns.one} ${where}`
  const { derivation, language } = sel.excerpt
  const into = derivation === "translation" && language ? `, into ${language}` : ""
  const link = sel.href ? ` — ${sel.href}` : ""
  return `${EXCERPT_LEADS[derivation]} ${source}${into}${link}:`
}

/** What the formatter needs to know about the turn it is writing for. */
export interface SelectionFormatContext {
  /** The conversation this turn is sent in. Absent when it does not exist yet. */
  sessionId?: string | null
}

function isSameConversation(
  sel: { sourceSessionId?: string },
  ctx: SelectionFormatContext
): boolean {
  return Boolean(sel.sourceSessionId && ctx.sessionId && sel.sourceSessionId === ctx.sessionId)
}

/**
 * How a picked element is NAMED in the heading above.
 *
 * Component name first when there is one: `<SubmitButton>` identifies the thing
 * a developer would edit, where a `:nth-of-type` chain identifies only where it
 * sits. The CSS selector follows as the unambiguous fallback, and a source hint
 * — read from real `data-inspector-*` attributes — wins outright when present,
 * because it names the file to change.
 *
 * English, like every other string in this file: prompt scaffolding, not UI
 * copy, so it must not follow the user's locale.
 */
function elementLabel(element: ElementSelectionCore): string {
  const parts: string[] = []
  if (element.componentName) parts.push(`<${element.componentName}>`)
  if (element.selector) parts.push(element.selector)
  if (element.sourceHint) {
    const { path, line, column } = element.sourceHint
    parts.push(`${path}:${line}${column != null ? `:${column}` : ""}`)
  }
  return parts.length > 0 ? ` — ${parts.join(", ")}` : ""
}

/**
 * The facts about a picked element that its markup alone does not carry.
 *
 * Deliberately short. The snapshot above is already the element's outerHTML, so
 * repeating tag/class/text here would be noise; what a model cannot derive from
 * the markup is where the node sits, what it actually computed to, and which
 * component owns it.
 */
function elementFacts(element: ElementSelectionCore): string[] {
  const facts: string[] = []
  if (element.componentStack) facts.push(`Component path: ${element.componentStack}`)
  if (element.props && Object.keys(element.props).length > 0) {
    facts.push(
      `Props: ${Object.entries(element.props)
        .map(([key, value]) => `${key}=${value}`)
        .join(", ")}`
    )
  }
  if (element.computedStyles && Object.keys(element.computedStyles).length > 0) {
    facts.push(
      `Computed styles: ${Object.entries(element.computedStyles)
        .map(([key, value]) => `${key}: ${value}`)
        .join("; ")}`
    )
  }
  if (element.accessibility?.role || element.accessibility?.name) {
    facts.push(
      `Accessibility: role=${element.accessibility.role || "none"}, name=${element.accessibility.name || "none"}`
    )
  }
  return facts
}

function headingFor(sel: ContextSelectionRef, ctx: SelectionFormatContext): string {
  switch (sel.kind) {
    case "artifact":
      // An element pick names the element, because "lines 40-44" is the least
      // useful thing we know about a node the user pointed at on screen.
      return sel.element
        ? `Selected element in artifact "${sel.title}"${elementLabel(sel.element)} (lines ${rangeLabel(sel.range)}):`
        : `Selection from artifact "${sel.title}" (lines ${rangeLabel(sel.range)}):`
    case "file":
      return sel.range
        ? `Selection from file "${sel.relPath}" (lines ${rangeLabel(sel.range)}):`
        : `File "${sel.relPath}":`
    case "comment":
      return sel.anchorLabel
        ? `Comment on "${sel.title}" (${sel.anchorLabel}):`
        : `Comment on "${sel.title}":`
    case "web":
      return `From the page "${sel.title}" (${sel.url}):`
    case "external": {
      const sourceTitle = sel.sourceTitle ? `, window "${sel.sourceTitle}"` : ""
      const truncation = sel.truncated ? " (truncated to 20,000 characters)" : ""
      const origin =
        sel.origin === "ocr"
          ? " (captured via OCR; recognition errors are possible)"
          : sel.origin === "clipboard"
            ? " (captured from the clipboard)"
            : ""
      const sourceUrl = sel.sourceUrl ? `, source ${sel.sourceUrl}` : ""
      const capturedAt =
        typeof sel.capturedAt === "number" && Number.isFinite(sel.capturedAt)
          ? `, captured at ${new Date(sel.capturedAt).toISOString()}`
          : ""
      return `Selection from app "${sel.sourceApp}"${sourceTitle}${origin}${truncation}${sourceUrl}${capturedAt}:`
    }
    case "entity": {
      const same = isSameConversation(sel, ctx)
      const { excerpt } = sel
      // Before the member count: an excerpt that runs across several messages
      // is still one selection, not a list of whole messages.
      if (excerpt) return excerptHeading({ ...sel, excerpt }, same)
      const detail = sel.subtitle ? ` (${sel.subtitle})` : ""
      const members = sel.members ?? []
      const plural = MEMBER_NOUNS[sel.entityKind]
      if (members.length > 1 && plural) {
        // The body carries each member's own label and link; the heading only
        // has to say how many there are and where they came from.
        return `${members.length} ${same ? plural.same : plural.other}:`
      }
      const noun =
        (same ? SAME_CONVERSATION_NOUNS[sel.entityKind] : undefined) ?? ENTITY_NOUNS[sel.entityKind]
      // A message reference names WHERE it came from, because the assistant can
      // hand that link back: `hooks/chat/use-message-permalink.ts` consumes
      // `?session=&message=` and lands on the exact turn. Only this kind — the
      // others open a record whose own surface is the better destination, and a
      // heading full of routes is noise the model has to read past.
      if (sel.entityKind === "message" && sel.href) {
        const span = sel.span
        const turns =
          span && (span.before > 0 || span.after > 0)
            ? ` and the ${span.before + span.after} turn(s) around it`
            : ""
        return `${noun}${turns}${detail} — ${sel.href}:`
      }
      return `${noun} "${sel.title}"${detail}:`
    }
    case "plugin": {
      // Citations are the point of this kind: without them the assistant is
      // told some prose and cannot tell which code it describes.
      const cited = (sel.citations ?? [])
        .map((citation) => `${citation.path}${citationLines(citation)}`)
        .filter((entry, index, all) => all.indexOf(entry) === index)
      const from = cited.length > 0 ? ` [from ${cited.join(", ")}]` : ""
      return `Selection from ${sel.sourceLabel} "${sel.title}"${from}:`
    }
  }
}

/**
 * Say when a copy was taken, and only when it has since diverged.
 *
 * The snapshot is deliberately not refreshed (see
 * `lib/chat/mentions/selection-freshness.ts`) — the user approved this body.
 * But a model reasoning from a plan that has advanced three steps since, or a
 * memory that was invalidated, should be told the copy is behind rather than
 * left to state it as current. English, like every other string here: it is
 * prompt scaffolding, not UI copy.
 */
function stalenessNote(sel: ContextSelectionRef): string | null {
  if (sel.kind !== "entity" || !sel.stale) return null
  return `[This copy was taken at ${new Date(sel.capturedAt).toISOString()}; the record has changed since. Treat it as a snapshot, not as the current state.]`
}

/**
 * A fence the snapshot cannot close.
 *
 * A fixed three-backtick fence broke on the first code block inside a
 * referenced message or file: the snapshot's own fence ended the block, and
 * everything after it read to the model as loose prompt text. CommonMark closes
 * a fence only with a run at least as long as the opener, so one backtick more
 * than the longest run inside is always enough.
 */
export function fenceFor(text: string): string {
  let longest = 0
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  return "`".repeat(Math.max(3, longest + 1))
}

function formatOne(sel: ContextSelectionRef, ctx: SelectionFormatContext): string {
  const fence = fenceFor(sel.snapshot)
  const lines = [headingFor(sel, ctx), fence, sel.snapshot, fence]
  if (sel.kind === "artifact" && sel.element) lines.push(...elementFacts(sel.element))
  const note = stalenessNote(sel)
  if (note) lines.push(note)
  if (sel.comment.trim()) {
    lines.push(`Comment: ${sel.comment.trim()}`)
  }
  return lines.join("\n")
}

/**
 * The selection that means "all of it" — what "Reference in chat" stages when
 * the user picked a whole artifact rather than a range inside one.
 *
 * Lives here rather than at the call site because the range convention is not
 * self-evident: `startLine` is 1-based and `endLine` is inclusive, so the whole
 * document is `1 … <line count>`, and `rangeLabel` above collapses the label to
 * a single number when the two are equal — which a one-line artifact must hit.
 */
export function wholeArtifactSelection(artifact: {
  id: string
  title: string
  content: string
}): ArtifactSelectionRef {
  return {
    kind: "artifact",
    artifactId: artifact.id,
    title: artifact.title,
    snapshot: artifact.content,
    comment: "",
    range: { startLine: 1, endLine: artifact.content.split("\n").length },
  }
}

/**
 * The whole-file counterpart, staged by the dock's workspace panel.
 *
 * No range, deliberately: "this file" is a different statement from "lines
 * 1..N of this file", and collapsing the two would make the chip claim a
 * hand-picked excerpt. `range` stays optional on `FileSelectionRef` so a diff
 * hunk can carry one.
 */
export function wholeFileSelection(file: {
  relPath: string
  content: string
  title?: string
}): FileSelectionRef {
  return {
    kind: "file",
    relPath: file.relPath,
    title: file.title ?? file.relPath.split("/").pop() ?? file.relPath,
    snapshot: file.content,
    comment: "",
  }
}

/**
 * Returns a markdown context block, or an empty string when there are no
 * selections (so callers can prepend unconditionally without adding noise).
 */
export function formatContextSelectionsForLLM(
  selections: readonly ContextSelectionRef[],
  ctx: SelectionFormatContext = {}
): string {
  if (selections.length === 0) {
    return ""
  }
  return ["Referenced context:", ...selections.map((sel) => formatOne(sel, ctx))].join("\n\n")
}
