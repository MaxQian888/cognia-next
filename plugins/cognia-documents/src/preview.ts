import type { Artifact, ArtifactRenderer } from "@cognia/plugin-sdk"
import {
  normalizeFeatureId,
  parseDocument,
  validateDocument,
  type DocumentBlock,
  type DocumentFinding,
  type DocumentModel,
  type DocumentOperation,
} from "./model"

/** Resolves a plugin i18n key at render time so locale switches take effect. */
export type PreviewTranslator = (key: string, params?: Record<string, string | number>) => string

export interface DocumentPreviewDeps {
  t: PreviewTranslator
  /** Apply review operations against the artifact; throws on version conflict. */
  applyReview: (
    artifactId: string,
    expectedVersion: number,
    operations: DocumentOperation[]
  ) => Promise<unknown>
  /** Called once per mount; must return a disposer. */
  onLocaleChange: (handler: () => void) => () => void
}

const HIGHLIGHT_MS = 1600

/** Review state the render reads; `pending` locks every mutating action. */
interface ReviewState {
  pending: boolean
  error: string
}

interface ReviewActions {
  act: (operations: DocumentOperation[]) => void
  showBlock: (blockId: string) => void
}

export function createDocumentRenderer(deps: DocumentPreviewDeps): ArtifactRenderer {
  return {
    name: deps.t("renderer.name"),
    mount: (artifact, container) => {
      let current: Artifact = artifact
      let disposed = false
      let highlightTimer: ReturnType<typeof setTimeout> | undefined
      const review: ReviewState = { pending: false, error: "" }
      const disposers: Array<() => void> = []
      const t = deps.t

      const act = (operations: DocumentOperation[]) => {
        // One review write at a time: a second click would race the first
        // against the same `expectedVersion` and always lose.
        if (review.pending) return
        review.pending = true
        review.error = ""
        render()
        Promise.resolve()
          .then(() => deps.applyReview(current.id, current.version, operations))
          .then(
            () => {
              review.pending = false
            },
            (error: unknown) => {
              review.pending = false
              review.error = error instanceof Error ? error.message : String(error)
            }
          )
          .finally(() => {
            if (!disposed) render()
          })
      }

      const showBlock = (blockId: string) => {
        const target = container.querySelector<HTMLElement>(
          `[data-block-id="${cssEscape(blockId)}"]`
        )
        if (!target) return
        target.scrollIntoView({
          behavior: prefersReducedMotion() ? "auto" : "smooth",
          block: "center",
        })
        // Move keyboard focus with the scroll so a screen reader lands on it.
        target.focus({ preventScroll: true })
        target.classList.add("cdoc-flash")
        if (highlightTimer) clearTimeout(highlightTimer)
        highlightTimer = setTimeout(() => target.classList.remove("cdoc-flash"), HIGHLIGHT_MS)
      }

      const render = () => {
        const focusKey = activeFocusKey(container)
        const root = document.createElement("div")
        root.className = "cdoc"
        root.appendChild(buildStyles())
        try {
          root.appendChild(
            renderDocument(parseDocument(current.content), t, { act, showBlock }, review)
          )
        } catch (error) {
          const card = document.createElement("section")
          card.className = "cdoc-error"
          card.setAttribute("role", "alert")
          card.textContent = t("preview.parseError", {
            error: error instanceof Error ? error.message : String(error),
          })
          root.appendChild(card)
        }
        container.replaceChildren(root)
        restoreFocus(container, focusKey)
      }

      disposers.push(deps.onLocaleChange(render))
      render()
      return {
        update: (updated) => {
          current = updated
          review.error = ""
          render()
        },
        dispose: () => {
          disposed = true
          if (highlightTimer) clearTimeout(highlightTimer)
          disposers.forEach((dispose) => dispose())
          container.replaceChildren()
        },
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Focus + motion helpers
// ---------------------------------------------------------------------------

/** The `data-focus-key` of the focused control inside `container`, if any. */
function activeFocusKey(container: HTMLElement): string | undefined {
  const active = container.ownerDocument.activeElement
  if (!(active instanceof HTMLElement) || !container.contains(active)) return undefined
  return active.dataset.focusKey
}

/**
 * Every render replaces the DOM, which would drop keyboard focus onto `body`
 * after each review click or locale switch. Put it back on the control with
 * the same key — or on the review heading when that control is gone (a
 * rejected change removes its own card).
 */
function restoreFocus(container: HTMLElement, key: string | undefined): void {
  if (!key) return
  const candidates = [...container.querySelectorAll<HTMLElement>("[data-focus-key]")]
  const target =
    candidates.find((element) => element.dataset.focusKey === key) ??
    candidates.find((element) => element.dataset.focusKey === "review")
  target?.focus({ preventScroll: true })
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  )
}

/** `CSS.escape` where the runtime has it; a quote/backslash escape otherwise. */
function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value)
  return value.replace(/["\\]/g, "\\$&")
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

function renderDocument(
  model: DocumentModel,
  t: PreviewTranslator,
  actions: ReviewActions,
  review: ReviewState
): HTMLElement {
  const article = document.createElement("article")
  article.className = "cdoc-paper"
  article.appendChild(renderHeader(model, t))

  const body = document.createElement("div")
  body.className = "cdoc-body"
  if (!model.blocks.length) {
    const empty = document.createElement("p")
    empty.className = "cdoc-empty"
    empty.textContent = t("preview.empty")
    body.appendChild(empty)
  }
  // Consecutive same-kind list items share one list element — real ul/ol
  // semantics, real markers.
  let list: HTMLUListElement | HTMLOListElement | null = null
  let listOrdered: boolean | null = null
  for (const block of model.blocks) {
    const isList = block.type === "list-item"
    if (isList && (listOrdered !== block.ordered || !list)) {
      list = document.createElement(block.ordered ? "ol" : "ul")
      list.className = "cdoc-list"
      body.appendChild(list)
      listOrdered = block.ordered
    } else if (!isList) {
      list = null
      listOrdered = null
    }
    const element = renderBlock(block, t)
    if (isList && list) list.appendChild(element)
    else body.appendChild(element)
  }
  article.appendChild(body)

  if (model.comments.length || model.changes.length)
    article.appendChild(renderReview(model, t, actions, review))

  const findings = validateDocument(model)
  if (findings.length) article.appendChild(renderValidation(findings, t))
  return article
}

function renderHeader(model: DocumentModel, t: PreviewTranslator): HTMLElement {
  const header = document.createElement("header")
  header.className = "cdoc-header"
  const title = document.createElement("h1")
  title.className = "cdoc-title"
  title.textContent = model.title
  header.appendChild(title)
  const meta = document.createElement("p")
  meta.className = "cdoc-meta"
  const parts = [t("preview.wordCount", { count: wordCount(model) })]
  if (model.sourceFilename) parts.push(t("preview.source", { name: model.sourceFilename }))
  meta.textContent = parts.join(" · ")
  header.appendChild(meta)
  return header
}

function renderBlock(block: DocumentBlock, t: PreviewTranslator): HTMLElement {
  const tagged = (tag: string, text: string): HTMLElement => {
    const element = document.createElement(tag)
    element.dataset.blockId = block.id
    element.dataset.focusKey = `block:${block.id}`
    // Programmatically focusable so "Show block" can move focus here.
    element.tabIndex = -1
    element.className = `cdoc-block cdoc-${block.type}`
    element.textContent = text
    return element
  }
  switch (block.type) {
    case "heading":
      return tagged(`h${block.level + 1}`, block.text)
    case "list-item":
      return tagged("li", block.text)
    case "paragraph":
      return tagged("p", block.text)
    case "table": {
      const table = tagged("table", "")
      table.classList.add("cdoc-table")
      block.rows.forEach((row, rowIndex) => {
        const tr = document.createElement("tr")
        for (const value of row) {
          const cell = document.createElement(rowIndex === 0 ? "th" : "td")
          cell.textContent = value
          tr.appendChild(cell)
        }
        table.appendChild(tr)
      })
      // Wide tables scroll inside their own region instead of pushing the
      // paper past a 375px screen; the region is focusable so the keyboard
      // can scroll it too.
      const scroller = document.createElement("div")
      scroller.className = "cdoc-table-scroll"
      scroller.setAttribute("role", "region")
      scroller.setAttribute("aria-label", t("preview.table"))
      scroller.tabIndex = 0
      scroller.appendChild(table)
      return scroller
    }
  }
}

// ---------------------------------------------------------------------------
// Review rail — comment and tracked-change cards with actions
// ---------------------------------------------------------------------------

function renderReview(
  model: DocumentModel,
  t: PreviewTranslator,
  actions: ReviewActions,
  review: ReviewState
): HTMLElement {
  const aside = document.createElement("aside")
  aside.className = "cdoc-review"
  aside.setAttribute("aria-busy", String(review.pending))

  const heading = document.createElement("h2")
  heading.className = "cdoc-review-title"
  heading.textContent = t("preview.review")
  heading.tabIndex = -1
  heading.dataset.focusKey = "review"
  aside.appendChild(heading)

  const status = document.createElement("p")
  status.className = review.error ? "cdoc-review-error" : "cdoc-review-status"
  status.setAttribute("role", review.error ? "alert" : "status")
  status.textContent = review.error
    ? t("preview.actionFailed", { error: review.error })
    : review.pending
      ? t("preview.working")
      : ""
  aside.appendChild(status)

  const mutate = (label: string, focusKey: string, operations: DocumentOperation[]) =>
    actionButton(label, focusKey, () => actions.act(operations), review.pending)

  if (model.comments.length) {
    const label = document.createElement("h3")
    label.className = "cdoc-review-group"
    label.textContent = t("preview.comments")
    aside.appendChild(label)
    for (const comment of model.comments) {
      const card = document.createElement("section")
      card.className = `cdoc-card ${comment.resolved ? "is-resolved" : ""}`.trim()
      const byline = document.createElement("div")
      byline.className = "cdoc-card-byline"
      const author = document.createElement("span")
      author.className = "cdoc-card-author"
      author.textContent = comment.author
      const chip = document.createElement("span")
      chip.className = "cdoc-chip"
      chip.textContent = t(comment.resolved ? "preview.resolved" : "preview.open")
      byline.append(author, chip)
      const text = document.createElement("p")
      text.className = "cdoc-card-text"
      text.textContent = comment.text
      card.append(
        byline,
        text,
        cardActions([
          anchorButton(t, comment.blockId, `comment:${comment.id}:show`, actions.showBlock),
          mutate(
            t(comment.resolved ? "preview.reopen" : "preview.resolve"),
            `comment:${comment.id}:toggle`,
            [
              comment.resolved
                ? { op: "reopenComment", commentId: comment.id }
                : { op: "resolveComment", commentId: comment.id },
            ]
          ),
        ])
      )
      aside.appendChild(card)
    }
  }

  if (model.changes.length) {
    const label = document.createElement("h3")
    label.className = "cdoc-review-group"
    label.textContent = t("preview.changes")
    aside.appendChild(label)
    for (const change of model.changes) {
      const card = document.createElement("section")
      card.className = `cdoc-card ${change.accepted ? "is-resolved" : ""}`.trim()
      const byline = document.createElement("div")
      byline.className = "cdoc-card-byline"
      const chip = document.createElement("span")
      chip.className = "cdoc-chip"
      chip.textContent = t(change.accepted ? "preview.accepted" : "preview.pending")
      byline.appendChild(chip)
      const diff = document.createElement("p")
      diff.className = "cdoc-card-text cdoc-diff"
      const before = document.createElement("del")
      before.textContent = change.before
      const arrow = document.createElement("span")
      arrow.className = "cdoc-arrow"
      arrow.setAttribute("aria-hidden", "true")
      arrow.textContent = " → "
      const after = document.createElement("ins")
      after.textContent = change.after
      diff.append(before, arrow, after)
      const show = anchorButton(t, change.blockId, `change:${change.id}:show`, actions.showBlock)
      card.append(
        byline,
        diff,
        cardActions(
          change.accepted
            ? [show]
            : [
                show,
                mutate(t("preview.accept"), `change:${change.id}:accept`, [
                  { op: "acceptChange", changeId: change.id },
                ]),
                mutate(t("preview.reject"), `change:${change.id}:reject`, [
                  { op: "rejectChange", changeId: change.id },
                ]),
              ]
        )
      )
      aside.appendChild(card)
    }
  }
  return aside
}

function cardActions(buttons: HTMLButtonElement[]): HTMLElement {
  const row = document.createElement("div")
  row.className = "cdoc-card-actions"
  row.append(...buttons)
  return row
}

function anchorButton(
  t: PreviewTranslator,
  blockId: string,
  focusKey: string,
  showBlock: (blockId: string) => void
): HTMLButtonElement {
  const button = actionButton(t("preview.showBlock"), focusKey, () => showBlock(blockId), false)
  button.classList.add("cdoc-btn-anchor")
  return button
}

/**
 * `aria-disabled` rather than `disabled` while a review write is in flight: a
 * disabled button drops keyboard focus, so the user would lose their place in
 * the rail on every click. The click handler ignores the press instead.
 */
function actionButton(
  label: string,
  focusKey: string,
  onClick: () => void,
  locked: boolean
): HTMLButtonElement {
  const button = document.createElement("button")
  button.type = "button"
  button.className = "cdoc-btn"
  button.textContent = label
  button.dataset.focusKey = focusKey
  if (locked) button.setAttribute("aria-disabled", "true")
  button.addEventListener("click", () => {
    if (button.getAttribute("aria-disabled") === "true") return
    onClick()
  })
  return button
}

// ---------------------------------------------------------------------------
// Validation footer
// ---------------------------------------------------------------------------

/** A finding in the active locale; unknown codes keep the model's English text. */
export function localizeFinding(finding: DocumentFinding, t: PreviewTranslator): string {
  const key = `finding.${finding.code}`
  const params = { ...(finding.params ?? {}) }
  if (typeof params.feature === "string") {
    const featureKey = `feature.${normalizeFeatureId(params.feature)}`
    const label = t(featureKey)
    if (label !== featureKey) params.feature = label
  }
  const text = t(key, params)
  return text === key ? finding.message : text
}

function renderValidation(findings: DocumentFinding[], t: PreviewTranslator): HTMLElement {
  const section = document.createElement("section")
  section.className = "cdoc-validation"
  section.setAttribute("role", "status")
  const heading = document.createElement("h3")
  heading.className = "cdoc-review-group"
  heading.textContent = t("preview.validation")
  section.appendChild(heading)
  const list = document.createElement("ul")
  for (const finding of findings) {
    const item = document.createElement("li")
    item.className = `cdoc-finding is-${finding.severity}`
    item.textContent = localizeFinding(finding, t)
    list.appendChild(item)
  }
  section.appendChild(list)
  return section
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** CJK characters count as words individually; Latin runs count per word. */
export function wordCount(model: DocumentModel): number {
  const text = model.blocks
    .map((block) => (block.type === "table" ? block.rows.flat().join(" ") : block.text))
    .join(" ")
  const CJK = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uAC00-\uD7AF]/g
  const cjk = (text.match(CJK) ?? []).length
  const latin = text.replace(CJK, " ").split(/\s+/).filter(Boolean).length
  return cjk + latin
}

function buildStyles(): HTMLStyleElement {
  const style = document.createElement("style")
  style.textContent = `
.cdoc { font: inherit; color: var(--foreground); container-type: inline-size; }
.cdoc-paper { max-width: 720px; margin: 24px auto; padding: 48px 56px; background: var(--card); color: var(--card-foreground); border: 1px solid var(--border); border-radius: 8px; box-shadow: 0 8px 30px rgb(0 0 0 / .08); overflow-wrap: anywhere; }
.cdoc-header { border-bottom: 1px solid var(--border); padding-bottom: 16px; margin-bottom: 24px; }
.cdoc-title { font-size: 1.75rem; font-weight: 700; letter-spacing: -0.02em; margin: 0; }
.cdoc-meta { color: var(--muted-foreground); font-size: .8125rem; margin: 8px 0 0; }
.cdoc-body p { margin: 0 0 .75em; line-height: 1.7; }
.cdoc-body h2 { font-size: 1.4rem; font-weight: 650; margin: 1.4em 0 .5em; }
.cdoc-body h3 { font-size: 1.15rem; font-weight: 650; margin: 1.2em 0 .45em; }
.cdoc-body h4 { font-size: 1rem; font-weight: 650; margin: 1em 0 .4em; }
.cdoc-list { margin: 0 0 .75em; padding-left: 1.5em; line-height: 1.7; }
.cdoc-table-scroll { max-width: 100%; overflow-x: auto; margin: 0 0 1em; border-radius: 4px; }
.cdoc-table { width: 100%; border-collapse: collapse; font-size: .9rem; overflow-wrap: normal; }
.cdoc-table th, .cdoc-table td { border: 1px solid var(--border); padding: 6px 10px; text-align: left; vertical-align: top; min-width: 4em; }
.cdoc-table th { background: var(--muted); font-weight: 600; }
.cdoc-empty { color: var(--muted-foreground); font-style: italic; }
.cdoc-block { border-radius: 4px; outline: none; transition: box-shadow .2s ease-out; }
.cdoc-block.cdoc-flash, .cdoc-block:focus-visible { box-shadow: 0 0 0 2px var(--ring); }
.cdoc-review { margin-top: 32px; border-top: 1px solid var(--border); padding-top: 16px; }
.cdoc-review-title { font-size: 1.05rem; font-weight: 650; margin: 0 0 12px; outline: none; }
.cdoc-review-status:empty { display: none; }
.cdoc-review-status { color: var(--muted-foreground); font-size: .8rem; margin: 0 0 8px; }
.cdoc-review-group { font-size: .8125rem; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--muted-foreground); margin: 16px 0 8px; }
.cdoc-card { border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; background: var(--background); }
.cdoc-card.is-resolved { opacity: .62; }
.cdoc-card-byline { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 4px; min-width: 0; }
.cdoc-card-author { font-weight: 600; font-size: .85rem; min-width: 0; overflow-wrap: anywhere; }
.cdoc-chip { font-size: .7rem; padding: 1px 8px; border-radius: 999px; background: var(--muted); color: var(--muted-foreground); }
.cdoc-card-text { margin: 0; font-size: .875rem; line-height: 1.55; }
.cdoc-diff del { color: var(--destructive); text-decoration: line-through; }
.cdoc-diff ins { color: var(--primary); text-decoration: none; border-bottom: 1px dashed currentColor; }
.cdoc-arrow { color: var(--muted-foreground); }
.cdoc-card-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.cdoc-btn { display: inline-flex; align-items: center; justify-content: center; min-height: 28px; font: inherit; font-size: .75rem; padding: 3px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--secondary); color: inherit; cursor: pointer; transition: background-color .15s ease-out; }
.cdoc-btn:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
.cdoc-btn[aria-disabled="true"] { opacity: .55; cursor: progress; }
@media (hover: hover) { .cdoc-btn:not([aria-disabled="true"]):hover { background: var(--accent); } }
@media (pointer: coarse) { .cdoc-btn { min-height: 36px; padding: 6px 14px; } }
.cdoc-review-error { color: var(--destructive); font-size: .8rem; margin: 0 0 8px; }
.cdoc-validation { margin-top: 24px; }
.cdoc-validation ul { margin: 0; padding-left: 1.2em; font-size: .8rem; }
.cdoc-finding { margin-bottom: 2px; }
.cdoc-finding.is-error { color: var(--destructive); }
.cdoc-finding.is-warning { color: var(--muted-foreground); }
.cdoc-error { color: var(--destructive); padding: 16px; }
@container (max-width: 600px) {
  .cdoc-paper { margin: 0; padding: 20px 16px; border-radius: 0; border-left: 0; border-right: 0; box-shadow: none; }
  .cdoc-title { font-size: 1.4rem; }
  .cdoc-btn { min-height: 36px; padding: 6px 14px; }
}
@media (prefers-reduced-motion: reduce) {
  .cdoc-block, .cdoc-btn { transition: none; }
}
`
  return style
}
