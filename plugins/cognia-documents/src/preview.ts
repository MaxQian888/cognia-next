import type { ArtifactRenderer } from "@/types/plugin"
import { parseDocument, validateDocument, type DocumentBlock } from "./model"

export function createDocumentRenderer(labels: {
  comments: string
  changes: string
  validation: string
}): ArtifactRenderer {
  return {
    name: "Cognia Document",
    mount: (artifact, container) => {
      const render = (content: string) => {
        const model = parseDocument(content)
        const root = document.createElement("article")
        root.style.cssText =
          "max-width:816px;margin:24px auto;padding:56px;background:var(--card);color:var(--card-foreground);box-shadow:0 8px 30px rgb(0 0 0/.08)"
        const title = document.createElement("h1")
        title.textContent = model.title
        root.appendChild(title)
        for (const block of model.blocks) root.appendChild(renderBlock(block))
        if (model.comments.length) {
          const aside = document.createElement("aside")
          aside.setAttribute("aria-label", labels.comments)
          aside.textContent = `${labels.comments}: ${model.comments.map((comment) => `${comment.author}: ${comment.text}`).join(" · ")}`
          root.appendChild(aside)
        }
        if (model.changes.some((change) => !change.accepted)) {
          const aside = document.createElement("aside")
          aside.setAttribute("aria-label", labels.changes)
          aside.textContent = `${labels.changes}: ${model.changes.filter((change) => !change.accepted).length}`
          root.appendChild(aside)
        }
        const findings = validateDocument(model)
        if (findings.length) {
          const status = document.createElement("div")
          status.setAttribute("role", "status")
          status.textContent = `${labels.validation}: ${findings.map((finding) => finding.message).join(" · ")}`
          root.appendChild(status)
        }
        container.replaceChildren(root)
      }
      render(artifact.content)
      return {
        update: (updated) => render(updated.content),
        dispose: () => container.replaceChildren(),
      }
    },
  }
}

function renderBlock(block: DocumentBlock): HTMLElement {
  if (block.type === "table") {
    const table = document.createElement("table")
    for (const row of block.rows) {
      const tr = document.createElement("tr")
      for (const value of row) {
        const td = document.createElement("td")
        td.textContent = value
        td.style.cssText = "border:1px solid var(--border);padding:6px"
        tr.appendChild(td)
      }
      table.appendChild(tr)
    }
    return table
  }
  const tag =
    block.type === "heading"
      ? (`h${block.level + 1}` as "h2")
      : block.type === "list-item"
        ? "li"
        : "p"
  const element = document.createElement(tag)
  element.textContent = block.text
  element.dataset.blockId = block.id
  return element
}
