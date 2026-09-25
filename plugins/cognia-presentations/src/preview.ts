import type { ArtifactRenderer } from "@cognia/plugin-sdk"
import type { PresentationTranslate } from "./i18n"
import {
  normalizeHexColor,
  parsePresentation,
  validatePresentation,
  type PresentationDeck,
  type SlideElement,
} from "./model"

/**
 * Imperative artifact renderer for `cognia-presentations/deck` artifacts. The
 * host owns the container and calls mount/update/dispose; every render
 * resolves labels through `t` so a locale switch restyles the chrome without
 * re-mounting, and keyboard focus returns to the same control after each
 * re-render. Chrome uses host design tokens (`var(--*)`); only the slide
 * canvas carries deck theme colors, which are deck content.
 */
export function createPresentationRenderer(
  t: PresentationTranslate,
  onLocaleChange: (handler: () => void) => () => void
): ArtifactRenderer {
  return {
    name: t("renderer.name"),
    mount: (artifact, container) => {
      let active = 0
      let deck: PresentationDeck | null = null
      let parseError = ""
      const load = (content: string) => {
        try {
          deck = parsePresentation(content)
          parseError = ""
        } catch (error) {
          deck = null
          parseError = error instanceof Error ? error.message : String(error)
        }
      }
      const render = () => {
        const focusKey = activeFocusKey(container)
        if (!deck) {
          const alert = document.createElement("p")
          alert.setAttribute("role", "alert")
          alert.style.cssText = "margin:0;padding:16px;font-size:13px;color:var(--destructive)"
          alert.textContent = t("preview.parseError", { error: parseError })
          container.replaceChildren(alert)
          return
        }
        active = Math.min(Math.max(active, 0), Math.max(0, deck.slides.length - 1))
        container.replaceChildren(buildStyles(), renderDeck(deck, active, select, t))
        restoreFocus(container, focusKey)
      }
      const select = (index: number, focusKey?: string) => {
        if (!deck || index < 0 || index >= deck.slides.length) return
        active = index
        render()
        if (focusKey) restoreFocus(container, focusKey)
      }
      // Chrome labels resolve through `t` at render time — re-render when the
      // host switches locale so a mounted artifact restyles without remount.
      const disposeLocale = onLocaleChange(render)
      load(artifact.content)
      render()
      return {
        update: (updated) => {
          load(updated.content)
          render()
        },
        dispose: () => {
          disposeLocale()
          container.replaceChildren()
        },
      }
    },
  }
}

/** The `data-focus-key` of the focused control inside `container`, if any. */
function activeFocusKey(container: HTMLElement): string | undefined {
  const active = container.ownerDocument.activeElement
  if (!(active instanceof HTMLElement) || !container.contains(active)) return undefined
  return active.dataset.focusKey
}

/** Every render replaces the DOM; put keyboard focus back on the same control. */
function restoreFocus(container: HTMLElement, key: string | undefined): void {
  if (!key) return
  const target = [...container.querySelectorAll<HTMLElement>("[data-focus-key]")].find(
    (element) => element.dataset.focusKey === key
  )
  target?.focus({ preventScroll: true })
}

function buildStyles(): HTMLStyleElement {
  const style = document.createElement("style")
  style.textContent = `
.cpres-thumb { flex:none; max-width:180px; min-height:28px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; padding:5px 10px; border-radius:var(--radius); border:1px solid var(--border); background:var(--card); color:var(--muted-foreground); font:inherit; font-size:12px; cursor:pointer; transition:background-color .15s ease-out, border-color .15s ease-out; }
.cpres-thumb[aria-pressed="true"] { border-color:var(--primary); background:var(--accent); color:var(--accent-foreground); font-weight:500; }
.cpres-thumb:focus-visible, .cpres-canvas:focus-visible { outline:2px solid var(--ring); outline-offset:2px; }
@media (hover:hover) { .cpres-thumb[aria-pressed="false"]:hover { background:var(--accent); color:var(--accent-foreground); } }
@media (pointer:coarse) { .cpres-thumb { min-height:36px; padding:8px 12px; } }
@media (prefers-reduced-motion:reduce) { .cpres-thumb { transition:none; } }
`
  return style
}

function renderDeck(
  deck: PresentationDeck,
  active: number,
  select: (index: number, focusKey?: string) => void,
  t: PresentationTranslate
) {
  const root = document.createElement("section")
  root.style.cssText =
    "display:flex;flex-direction:column;gap:10px;min-height:100%;padding:12px;box-sizing:border-box;background:var(--background);color:var(--foreground)"

  const header = document.createElement("header")
  header.style.cssText =
    "display:flex;align-items:baseline;justify-content:space-between;gap:12px;min-width:0"
  const title = document.createElement("h2")
  title.textContent = deck.title
  title.style.cssText =
    "margin:0;min-width:0;font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
  const counter = document.createElement("span")
  counter.style.cssText = "flex:none;font-size:12px;color:var(--muted-foreground)"
  counter.setAttribute("aria-live", "polite")
  counter.textContent = deck.slides.length
    ? t("preview.slideOf", { index: active + 1, total: deck.slides.length })
    : ""
  header.append(title, counter)
  root.appendChild(header)

  const findings = validatePresentation(deck)
  if (findings.length) {
    const status = document.createElement("div")
    status.setAttribute("role", "status")
    status.style.cssText =
      "border:1px solid var(--border);border-radius:var(--radius);background:var(--muted);padding:8px 10px;font-size:12px"
    const heading = document.createElement("strong")
    heading.textContent = t("preview.validation")
    heading.style.cssText = "display:block;margin-bottom:4px;color:var(--foreground)"
    const list = document.createElement("ul")
    list.style.cssText = "margin:0;padding-left:16px;display:grid;gap:2px;list-style:disc"
    for (const finding of findings) {
      const item = document.createElement("li")
      item.dataset.severity = finding.severity
      item.style.color =
        finding.severity === "error" ? "var(--destructive)" : "var(--muted-foreground)"
      item.textContent = finding.message
      const code = document.createElement("code")
      code.textContent = ` ${finding.code}`
      code.style.cssText = "font-size:11px;color:var(--muted-foreground)"
      item.appendChild(code)
      list.appendChild(item)
    }
    status.append(heading, list)
    root.appendChild(status)
  }

  if (!deck.slides.length) {
    const empty = document.createElement("p")
    empty.style.cssText =
      "margin:0;padding:32px 12px;text-align:center;font-size:13px;color:var(--muted-foreground);border:1px dashed var(--border);border-radius:var(--radius)"
    empty.textContent = t("preview.empty")
    root.appendChild(empty)
    return root
  }

  const nav = document.createElement("nav")
  nav.setAttribute("aria-label", t("preview.slides"))
  nav.style.cssText = "display:flex;gap:6px;overflow-x:auto;padding-bottom:2px"
  deck.slides.forEach((slide, index) => {
    const button = document.createElement("button")
    button.type = "button"
    button.className = "cpres-thumb"
    button.dataset.focusKey = `slide:${index}`
    button.textContent = `${index + 1}. ${slide.title}`
    button.title = t("preview.slideLabel", { index: index + 1, title: slide.title })
    button.setAttribute("aria-pressed", String(index === active))
    button.addEventListener("click", () => select(index))
    nav.appendChild(button)
  })
  root.appendChild(nav)

  const slide = deck.slides[active]
  // A labelled group, not role="img": an img role would hide every text run,
  // table cell, and image alt on the slide from assistive technology.
  const canvas = document.createElement("div")
  canvas.className = "cpres-canvas"
  canvas.setAttribute("role", "group")
  canvas.setAttribute("aria-roledescription", t("preview.slideRole"))
  canvas.setAttribute(
    "aria-label",
    t("preview.slideLabel", { index: active + 1, title: slide.title })
  )
  canvas.tabIndex = 0
  canvas.dataset.focusKey = "canvas"
  canvas.addEventListener("keydown", (event) => {
    const target =
      event.key === "ArrowRight" || event.key === "PageDown"
        ? active + 1
        : event.key === "ArrowLeft" || event.key === "PageUp"
          ? active - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? deck.slides.length - 1
              : null
    if (target === null) return
    event.preventDefault()
    select(target, "canvas")
  })
  canvas.style.cssText =
    `position:relative;width:100%;aspect-ratio:${deck.width}/${deck.height};overflow:hidden;` +
    `container-type:size;border:1px solid var(--border);border-radius:var(--radius);` +
    `background:#${normalizeHexColor(deck.theme.background, "FFFFFF")};` +
    `color:#${normalizeHexColor(deck.theme.foreground, "0F172A")};` +
    `font-family:${deck.theme.fontFamily || "sans-serif"},sans-serif`
  for (const element of slide.elements) canvas.appendChild(renderElement(element, deck, t))
  root.appendChild(canvas)

  if (slide.speakerNotes) {
    const notes = document.createElement("aside")
    notes.setAttribute("aria-label", t("preview.notes"))
    notes.style.cssText =
      "border-left:3px solid var(--border);border-radius:var(--radius);background:var(--muted);padding:8px 10px;font-size:12px;color:var(--muted-foreground);white-space:pre-wrap"
    const label = document.createElement("strong")
    label.textContent = t("preview.notes")
    label.style.cssText = "display:block;margin-bottom:2px;color:var(--foreground)"
    notes.appendChild(label)
    notes.appendChild(document.createTextNode(slide.speakerNotes))
    root.appendChild(notes)
  }
  return root
}

/** fontSize is in points; `cqh` scales it with the slide-height container. */
function scaledFontSize(fontSize: number, deck: PresentationDeck): string {
  const points = Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 24
  const cqh = (points / (deck.height * 72)) * 100
  return `font-size:${points}pt;font-size:${cqh.toFixed(3)}cqh`
}

function renderElement(
  element: SlideElement,
  deck: PresentationDeck,
  t: PresentationTranslate
): HTMLElement {
  const node = document.createElement(
    element.type === "image" ? "img" : element.type === "table" ? "table" : "div"
  )
  node.style.cssText = `position:absolute;left:${(element.x / deck.width) * 100}%;top:${(element.y / deck.height) * 100}%;width:${(element.width / deck.width) * 100}%;height:${(element.height / deck.height) * 100}%;box-sizing:border-box;overflow:hidden`
  if (element.type === "text") {
    node.textContent = element.text
    node.style.cssText += `;${scaledFontSize(element.fontSize ?? 24, deck)};line-height:1.25;white-space:pre-wrap;font-weight:${element.bold ? "700" : "400"};color:#${normalizeHexColor(element.color, deck.theme.foreground)}`
  } else if (element.type === "shape") {
    node.textContent = element.text ?? ""
    node.style.cssText +=
      `;display:flex;align-items:center;justify-content:center;text-align:center;` +
      `${scaledFontSize(14, deck)};padding:0.4em;white-space:pre-wrap;` +
      `background:#${normalizeHexColor(element.fill, "FFFFFF")};` +
      `border:1px solid #${normalizeHexColor(element.line, "CBD5E1")}`
    if (element.shape === "ellipse") node.style.borderRadius = "50%"
    else if (element.shape === "roundRect") node.style.borderRadius = "12%"
  } else if (element.type === "image") {
    const image = node as HTMLImageElement
    image.src = `data:${element.mimeType};base64,${element.dataBase64}`
    image.alt = element.alt
    image.style.objectFit = "contain"
  } else if (element.type === "table") {
    renderTable(node as HTMLTableElement, element, deck)
  } else {
    renderChart(node, element, deck, t)
  }
  return node
}

function renderTable(
  table: HTMLTableElement,
  element: Extract<SlideElement, { type: "table" }>,
  deck: PresentationDeck
): void {
  const accent = normalizeHexColor(deck.theme.accent, "2563EB")
  const foreground = normalizeHexColor(deck.theme.foreground, "0F172A")
  table.style.cssText += `;border-collapse:collapse;${scaledFontSize(12, deck)}`
  element.rows.forEach((row, rowIndex) => {
    const tr = table.insertRow()
    for (const value of row) {
      const td = tr.insertCell()
      td.textContent = value
      td.style.cssText =
        `border:1px solid #${foreground};border:1px solid color-mix(in srgb, #${foreground} 30%, transparent);` +
        `padding:0.3em 0.5em;overflow:hidden;text-overflow:ellipsis` +
        (rowIndex === 0
          ? `;background:#${accent};color:#FFFFFF;font-weight:600;border-color:#${accent}`
          : "")
    }
  })
}

function renderChart(
  node: HTMLElement,
  element: Extract<SlideElement, { type: "chart" }>,
  deck: PresentationDeck,
  t: PresentationTranslate
): void {
  const values = element.values.filter((value) => Number.isFinite(value))
  const max = Math.max(...values, 0)
  const min = Math.min(...values, 0)
  const range = max - min || 1
  const accent = normalizeHexColor(deck.theme.accent, "2563EB")
  const foreground = normalizeHexColor(deck.theme.foreground, "0F172A")
  node.setAttribute("role", "img")
  node.setAttribute(
    "aria-label",
    element.title
      ? t("preview.chartSummary", { title: element.title, count: values.length })
      : t("preview.chart")
  )
  node.style.cssText += ";display:flex;flex-direction:column"

  if (element.title) {
    const title = document.createElement("div")
    title.textContent = element.title
    title.style.cssText = `${scaledFontSize(12, deck)};font-weight:600;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap`
    node.appendChild(title)
  }

  const plot = document.createElement("div")
  plot.style.cssText =
    "position:relative;flex:1;display:flex;align-items:stretch;gap:4%;min-height:0"
  const baselineTop = (max / range) * 100
  const baseline = document.createElement("div")
  baseline.style.cssText = `position:absolute;left:0;right:0;top:${baselineTop}%;height:1px;background:#${foreground};background:color-mix(in srgb, #${foreground} 40%, transparent)`
  plot.appendChild(baseline)
  element.values.forEach((value, index) => {
    const column = document.createElement("div")
    column.style.cssText = "position:relative;flex:1;min-width:0"
    const bar = document.createElement("div")
    const height = Math.abs(value / range) * 100
    const top = ((max - Math.max(value, 0)) / range) * 100
    bar.style.cssText = `position:absolute;left:8%;right:8%;top:${top}%;height:${height}%;min-height:1px;background:#${accent};border-radius:2px 2px 0 0`
    bar.title = `${element.labels[index] ?? index + 1}: ${value}`
    column.appendChild(bar)
    plot.appendChild(column)
  })
  node.appendChild(plot)

  const labels = document.createElement("div")
  labels.style.cssText = `display:flex;gap:4%;${scaledFontSize(9, deck)};color:#${foreground};color:color-mix(in srgb, #${foreground} 70%, transparent)`
  element.values.forEach((_, index) => {
    const label = document.createElement("span")
    label.style.cssText =
      "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:center"
    label.textContent = element.labels[index] ?? ""
    labels.appendChild(label)
  })
  node.appendChild(labels)
}
