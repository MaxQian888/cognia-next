import type { ArtifactRenderer } from "@cognia/plugin-sdk"
import {
  parsePresentation,
  validatePresentation,
  type PresentationDeck,
  type SlideElement,
} from "./model"

export function createPresentationRenderer(labels: {
  slides: string
  notes: string
  validation: string
}): ArtifactRenderer {
  return {
    name: "Cognia Presentation",
    mount: (artifact, container) => {
      let active = 0
      let deck = parsePresentation(artifact.content)
      const render = () => {
        active = Math.min(active, Math.max(0, deck.slides.length - 1))
        container.replaceChildren(
          renderDeck(
            deck,
            active,
            (index) => {
              active = index
              render()
            },
            labels
          )
        )
      }
      render()
      return {
        update: (updated) => {
          deck = parsePresentation(updated.content)
          render()
        },
        dispose: () => container.replaceChildren(),
      }
    },
  }
}

function renderDeck(
  deck: PresentationDeck,
  active: number,
  select: (index: number) => void,
  labels: { slides: string; notes: string; validation: string }
) {
  const root = document.createElement("section")
  root.style.cssText = "display:grid;gap:12px;padding:12px"
  const nav = document.createElement("nav")
  nav.setAttribute("aria-label", labels.slides)
  nav.style.cssText = "display:flex;gap:6px;overflow:auto"
  deck.slides.forEach((slide, index) => {
    const button = document.createElement("button")
    button.type = "button"
    button.textContent = `${index + 1}. ${slide.title}`
    button.setAttribute("aria-pressed", String(index === active))
    button.addEventListener("click", () => select(index))
    nav.appendChild(button)
  })
  root.appendChild(nav)
  const slide = deck.slides[active]
  if (slide) {
    const canvas = document.createElement("div")
    canvas.setAttribute("role", "img")
    canvas.setAttribute("aria-label", slide.title)
    canvas.style.cssText = `position:relative;aspect-ratio:${deck.width}/${deck.height};width:100%;overflow:hidden;background:#${deck.theme.background};color:#${deck.theme.foreground};font-family:${deck.theme.fontFamily},sans-serif`
    for (const element of slide.elements) canvas.appendChild(renderElement(element, deck))
    root.appendChild(canvas)
    if (slide.speakerNotes) {
      const notes = document.createElement("aside")
      notes.setAttribute("aria-label", labels.notes)
      notes.textContent = slide.speakerNotes
      root.appendChild(notes)
    }
  }
  const findings = validatePresentation(deck)
  if (findings.length) {
    const status = document.createElement("div")
    status.setAttribute("role", "status")
    status.textContent = `${labels.validation}: ${findings.map((finding) => finding.message).join(" · ")}`
    root.appendChild(status)
  }
  return root
}

function renderElement(element: SlideElement, deck: PresentationDeck): HTMLElement {
  const node = document.createElement(
    element.type === "image" ? "img" : element.type === "table" ? "table" : "div"
  )
  node.style.cssText = `position:absolute;left:${(element.x / deck.width) * 100}%;top:${(element.y / deck.height) * 100}%;width:${(element.width / deck.width) * 100}%;height:${(element.height / deck.height) * 100}%;box-sizing:border-box;overflow:hidden`
  if (element.type === "text") {
    node.textContent = element.text
    node.style.fontSize = `${element.fontSize ?? 24}px`
    node.style.fontWeight = element.bold ? "700" : "400"
    node.style.color = `#${element.color ?? deck.theme.foreground}`
  } else if (element.type === "shape") {
    node.textContent = element.text ?? ""
    node.style.background = `#${element.fill ?? "FFFFFF"}`
    node.style.border = `1px solid #${element.line ?? "CBD5E1"}`
    if (element.shape === "ellipse") node.style.borderRadius = "50%"
  } else if (element.type === "image") {
    const image = node as HTMLImageElement
    image.src = `data:${element.mimeType};base64,${element.dataBase64}`
    image.alt = element.alt
    image.style.objectFit = "contain"
  } else if (element.type === "table") {
    const table = node as HTMLTableElement
    for (const row of element.rows) {
      const tr = table.insertRow()
      for (const value of row) {
        const td = tr.insertCell()
        td.textContent = value
        td.style.border = "1px solid currentColor"
      }
    }
  } else {
    const max = Math.max(...element.values.map(Math.abs), 1)
    node.setAttribute("aria-label", element.title ?? "Chart")
    node.style.display = "flex"
    node.style.alignItems = "end"
    node.style.gap = "4px"
    element.values.forEach((value, index) => {
      const bar = document.createElement("span")
      bar.title = `${element.labels[index]}: ${value}`
      bar.style.cssText = `flex:1;height:${(Math.abs(value) / max) * 100}%;background:#${deck.theme.accent}`
      node.appendChild(bar)
    })
  }
  return node
}
