import type { Artifact, ArtifactRenderer } from "@cognia/plugin-sdk"
import {
  parseDocument,
  validateDocument,
  type DocumentBlock,
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

export function createDocumentRenderer(deps: DocumentPreviewDeps): ArtifactRenderer {
  return {
    name: "Cognia Document",
    mount: (artifact, container) => {
      let current: Artifact = artifact
      let reviewError = ""
      const disposers: Array<() => void> = []

      const t = deps.t

      const act = (operations: DocumentOperation[]) => {
        reviewError = ""
        Promise.resolve(deps.applyReview(current.id, current.version, operations)).catch(
          (error: unknown) => {
            reviewError = error instanceof Error ? error.message : String(error)
            render(current.content)
          }
        )
      }

      const showBlock = (blockId: string) => {
        const target = container.querySelector<HTMLElement>(`[data-block-id="${blockId}"]`)
        if (!target) return
        target.scrollIntoView({ behavior: "smooth", block: "center" })
        target.classList.add("cdoc-flash")
        setTimeout(() => target.classList.remove("cdoc-flash"), HIGHLIGHT_MS)
      }

      const render = (content: string) => {
        const root = document.createElement("div")
        root.className = "cdoc"
        root.appendChild(buildStyles())
        try {
          root.appendChild(renderDocument(parseDocument(content), t, act, showBlock, reviewError))
        } catch (error) {
          const card = document.createElement("section")
          card.className = "cdoc-error"
          card.setAttribute("role", "alert")
          card.textContent = error instanceof Error ? error.message : String(error)
          root.appendChild(card)
        }
        container.replaceChildren(root)
      }

      disposers.push(deps.onLocaleChange(() => render(current.content)))
      render(artifact.content)
      return {
        update: (updated) => {
          current = updated
          reviewError = ""
          render(updated.content)
        },
        dispose: () => {
          disposers.forEach((dispose) => dispose())
          container.replaceChildren()
        },
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

function renderDocument(
  model: DocumentModel,
  t: DocumentPreviewDeps["t"],
  act: (operations: DocumentOperation[]) => void,
  showBlock: (blockId: string) => void,
  reviewError: string
): HTMLElement {
  const article = document.createElement("article")
  article.className = "cdoc-paper"
  article.appendChild(renderHeader(model, t))

  const body = document.createElement("div")
  body.className = "cdoc-body"
  if (!model.blocks.length) {
    const empty = document.createElement("p")
    empty.className = "cdoc-empty"
    empty.textContent = t("documents.preview.empty")
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
    const element = renderBlock(block)
    if (isList && list) list.appendChild(element)
    else body.appendChild(element)
  }
  article.appendChild(body)

  if (model.comments.length || model.changes.length)
    article.appendChild(renderReview(model, t, act, showBlock, reviewError))

  const findings = validateDocument(model)
  if (findings.length) article.appendChild(renderValidation(findings, t))
  return article
}

function renderHeader(model: DocumentModel, t: DocumentPreviewDeps["t"]): HTMLElement {
  const header = document.createElement("header")
  header.className = "cdoc-header"
  const title = document.createElement("h1")
  title.className = "cdoc-title"
  title.textContent = model.title
  header.appendChild(title)
  const meta = document.createElement("p")
  meta.className = "cdoc-meta"
  const parts = [t("documents.preview.wordCount", { count: wordCount(model) })]
  if (model.sourceFilename)
    parts.push(t("documents.preview.source", { name: model.sourceFilename }))
  meta.textContent = parts.join(" · ")
  header.appendChild(meta)
  return header
}

function renderBlock(block: DocumentBlock): HTMLElement {
  const tagged = (tag: string, text: string): HTMLElement => {
    const element = document.createElement(tag)
    element.dataset.blockId = block.id
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
      return table
    }
  }
}

// ---------------------------------------------------------------------------
// Review rail — comment and tracked-change cards with actions
// ---------------------------------------------------------------------------

function renderReview(
  model: DocumentModel,
  t: DocumentPreviewDeps["t"],
  act: (operations: DocumentOperation[]) => void,
  showBlock: (blockId: string) => void,
  reviewError: string
): HTMLElement {
  const aside = document.createElement("aside")
  aside.className = "cdoc-review"

  const heading = document.createElement("h2")
  heading.className = "cdoc-review-title"
  heading.textContent = t("documents.preview.review")
  aside.appendChild(heading)

  if (reviewError) {
    const error = document.createElement("p")
    error.className = "cdoc-review-error"
    error.setAttribute("role", "alert")
    error.textContent = t("documents.preview.actionFailed", { error: reviewError })
    aside.appendChild(error)
  }

  if (model.comments.length) {
    const label = document.createElement("h3")
    label.className = "cdoc-review-group"
    label.textContent = t("documents.preview.comments")
    aside.appendChild(label)
    for (const comment of model.comments) {
      const card = document.createElement("section")
      card.className = `cdoc-card ${comment.resolved ? "is-resolved" : ""}`
      const byline = document.createElement("div")
      byline.className = "cdoc-card-byline"
      const author = document.createElement("span")
      author.className = "cdoc-card-author"
      author.textContent = comment.author
      const status = document.createElement("span")
      status.className = "cdoc-chip"
      status.textContent = t(
        comment.resolved ? "documents.preview.resolved" : "documents.preview.open"
      )
      byline.append(author, status)
      const text = document.createElement("p")
      text.className = "cdoc-card-text"
      text.textContent = comment.text
      card.append(
        byline,
        text,
        cardActions([
          anchorButton(t, comment.blockId, showBlock),
          actionButton(
            t(comment.resolved ? "documents.preview.reopen" : "documents.preview.resolve"),
            () =>
              act([
                comment.resolved
                  ? { op: "reopenComment", commentId: comment.id }
                  : { op: "resolveComment", commentId: comment.id },
              ])
          ),
        ])
      )
      aside.appendChild(card)
    }
  }

  if (model.changes.length) {
    const label = document.createElement("h3")
    label.className = "cdoc-review-group"
    label.textContent = t("documents.preview.changes")
    aside.appendChild(label)
    for (const change of model.changes) {
      const card = document.createElement("section")
      card.className = `cdoc-card ${change.accepted ? "is-resolved" : ""}`
      const byline = document.createElement("div")
      byline.className = "cdoc-card-byline"
      const status = document.createElement("span")
      status.className = "cdoc-chip"
      status.textContent = t(
        change.accepted ? "documents.preview.accepted" : "documents.preview.pending"
      )
      byline.appendChild(status)
      const diff = document.createElement("p")
      diff.className = "cdoc-card-text cdoc-diff"
      const before = document.createElement("del")
      before.textContent = change.before
      const arrow = document.createElement("span")
      arrow.className = "cdoc-arrow"
      arrow.textContent = " → "
      const after = document.createElement("ins")
      after.textContent = change.after
      diff.append(before, arrow, after)
      card.append(
        byline,
        diff,
        cardActions(
          change.accepted
            ? [anchorButton(t, change.blockId, showBlock)]
            : [
                anchorButton(t, change.blockId, showBlock),
                actionButton(t("documents.preview.accept"), () =>
                  act([{ op: "acceptChange", changeId: change.id }])
                ),
                actionButton(t("documents.preview.reject"), () =>
                  act([{ op: "rejectChange", changeId: change.id }])
                ),
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
  t: DocumentPreviewDeps["t"],
  blockId: string,
  showBlock: (blockId: string) => void
): HTMLButtonElement {
  return actionButton(t("documents.preview.showBlock"), () => showBlock(blockId), "cdoc-btn-anchor")
}

function actionButton(label: string, onClick: () => void, className = ""): HTMLButtonElement {
  const button = document.createElement("button")
  button.type = "button"
  button.className = `cdoc-btn ${className}`.trim()
  button.textContent = label
  button.addEventListener("click", onClick)
  return button
}

// ---------------------------------------------------------------------------
// Validation footer
// ---------------------------------------------------------------------------

function renderValidation(
  findings: ReturnType<typeof validateDocument>,
  t: DocumentPreviewDeps["t"]
): HTMLElement {
  const section = document.createElement("section")
  section.className = "cdoc-validation"
  section.setAttribute("role", "status")
  const heading = document.createElement("h3")
  heading.className = "cdoc-review-group"
  heading.textContent = t("documents.preview.validation")
  section.appendChild(heading)
  const list = document.createElement("ul")
  for (const finding of findings) {
    const item = document.createElement("li")
    item.className = `cdoc-finding is-${finding.severity}`
    item.textContent = `${finding.code}: ${finding.message}`
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
.cdoc { font: inherit; color: var(--foreground); }
.cdoc-paper { max-width: 720px; margin: 24px auto; padding: 48px 56px; background: var(--card); color: var(--card-foreground); border: 1px solid var(--border); border-radius: 8px; box-shadow: 0 8px 30px rgb(0 0 0 / .08); }
.cdoc-header { border-bottom: 1px solid var(--border); padding-bottom: 16px; margin-bottom: 24px; }
.cdoc-title { font-size: 1.75rem; font-weight: 700; letter-spacing: -0.02em; margin: 0; }
.cdoc-meta { color: var(--muted-foreground); font-size: .8125rem; margin: 8px 0 0; }
.cdoc-body p { margin: 0 0 .75em; line-height: 1.7; }
.cdoc-body h2 { font-size: 1.4rem; font-weight: 650; margin: 1.4em 0 .5em; }
.cdoc-body h3 { font-size: 1.15rem; font-weight: 650; margin: 1.2em 0 .45em; }
.cdoc-body h4 { font-size: 1rem; font-weight: 650; margin: 1em 0 .4em; }
.cdoc-list { margin: 0 0 .75em; padding-left: 1.5em; line-height: 1.7; }
.cdoc-table { width: 100%; border-collapse: collapse; margin: 0 0 1em; font-size: .9rem; }
.cdoc-table th, .cdoc-table td { border: 1px solid var(--border); padding: 6px 10px; text-align: left; vertical-align: top; }
.cdoc-table th { background: var(--muted); font-weight: 600; }
.cdoc-empty { color: var(--muted-foreground); font-style: italic; }
.cdoc-block { border-radius: 4px; transition: box-shadow .3s; }
.cdoc-block.cdoc-flash { box-shadow: 0 0 0 2px var(--ring, #6366f1); }
.cdoc-review { margin-top: 32px; border-top: 1px solid var(--border); padding-top: 16px; }
.cdoc-review-title { font-size: 1.05rem; font-weight: 650; margin: 0 0 12px; }
.cdoc-review-group { font-size: .8125rem; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--muted-foreground); margin: 16px 0 8px; }
.cdoc-card { border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; background: var(--background); }
.cdoc-card.is-resolved { opacity: .62; }
.cdoc-card-byline { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.cdoc-card-author { font-weight: 600; font-size: .85rem; }
.cdoc-chip { font-size: .7rem; padding: 1px 8px; border-radius: 999px; background: var(--muted); color: var(--muted-foreground); }
.cdoc-card-text { margin: 0; font-size: .875rem; line-height: 1.55; }
.cdoc-diff del { color: var(--destructive, #dc2626); text-decoration: line-through; }
.cdoc-diff ins { color: var(--primary, #16a34a); text-decoration: none; border-bottom: 1px dashed currentColor; }
.cdoc-arrow { color: var(--muted-foreground); }
.cdoc-card-actions { display: flex; gap: 6px; margin-top: 8px; }
.cdoc-btn { font-size: .75rem; padding: 3px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--secondary, transparent); color: inherit; cursor: pointer; }
.cdoc-btn:hover { background: var(--accent, var(--muted)); }
.cdoc-review-error { color: var(--destructive, #dc2626); font-size: .8rem; }
.cdoc-validation { margin-top: 24px; }
.cdoc-validation ul { margin: 0; padding-left: 1.2em; font-size: .8rem; }
.cdoc-finding { margin-bottom: 2px; }
.cdoc-finding.is-error { color: var(--destructive, #dc2626); }
.cdoc-finding.is-warning { color: var(--warning, #d97706); }
.cdoc-error { color: var(--destructive, #dc2626); padding: 16px; }
`
  return style
}
