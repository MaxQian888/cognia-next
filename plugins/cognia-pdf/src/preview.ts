import type { ArtifactRenderer } from "@cognia/plugin-sdk"
import type { FileSaveOutcome } from "./export-file"
import { base64ToBytes, parsePdfArtifact, PDF_MIME, type PdfArtifactDocument } from "./model"
import { isRenderCancelled, openPdfForRender, type PdfRenderSession } from "./pdf-engine"
import { normalizePdfName } from "./runtime"

/** Resolves a plugin i18n key at render time so locale switches take effect. */
export type PreviewTranslator = (key: string, params?: Record<string, string | number>) => string

export interface PdfPreviewDeps {
  t: PreviewTranslator
  /** Called once per mount; must return a disposer. */
  onLocaleChange: (handler: () => void) => () => void
  /** `ctx.files.save` — the preview's save button writes through the same port as the tools. */
  save: (file: {
    suggestedName: string
    mimeType: string
    bytes: Uint8Array
  }) => Promise<FileSaveOutcome>
  /** Test seam; production paints with pdf.js. */
  openDocument?: (bytes: Uint8Array) => Promise<PdfRenderSession>
}

/** Widest a page is painted, in CSS pixels, however wide the panel is. */
const MAX_PAGE_WIDTH = 960
/** Width used before the stage has been laid out (e.g. a hidden panel). */
const FALLBACK_PAGE_WIDTH = 640
/** Stage padding on each side, in CSS pixels (mirrors `.cpdf-stage`). */
const STAGE_PADDING = 12

/** The CSS width a page should be painted at to fill the stage without overflow. */
function pageWidthFor(stage: HTMLElement): number {
  const available = stage.clientWidth - STAGE_PADDING * 2
  return Math.min(MAX_PAGE_WIDTH, available > 0 ? available : FALLBACK_PAGE_WIDTH)
}

type ViewState =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "encrypted" }
  | { kind: "error"; message: string }

type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; outcome: FileSaveOutcome; filename: string }
  | { kind: "cancelled" }
  | { kind: "failed"; message: string }

/**
 * Canvas-based PDF preview. The DOM skeleton (toolbar, status line, page
 * canvas) is built once per mount and only its text, attributes, and pixels
 * change afterwards — so keyboard focus never jumps on a page turn, a save, a
 * locale switch, or an artifact update.
 */
export function createPdfRenderer(deps: PdfPreviewDeps): ArtifactRenderer {
  const openDocument = deps.openDocument ?? ((bytes: Uint8Array) => openPdfForRender(bytes))
  return {
    name: deps.t("renderer.name"),
    mount: (artifact, container) => {
      const t = deps.t
      let disposed = false
      let loadToken = 0
      let document_: PdfArtifactDocument | null = null
      let session: PdfRenderSession | null = null
      let page = 1
      let view: ViewState = { kind: "loading" }
      let saveState: SaveState = { kind: "idle" }
      let paintedWidth = 0

      const root = document.createElement("section")
      root.className = "cpdf"
      const style = document.createElement("style")
      style.textContent = PREVIEW_STYLES

      const toolbar = document.createElement("div")
      toolbar.className = "cpdf-toolbar"
      const prev = iconButton("‹")
      const pageLabel = document.createElement("span")
      pageLabel.className = "cpdf-page-label"
      pageLabel.setAttribute("aria-live", "polite")
      const next = iconButton("›")
      const saveButton = document.createElement("button")
      saveButton.type = "button"
      saveButton.className = "cpdf-btn cpdf-save"
      toolbar.append(prev, pageLabel, next, saveButton)

      const status = document.createElement("p")
      status.className = "cpdf-status"
      status.setAttribute("role", "status")

      const stage = document.createElement("div")
      stage.className = "cpdf-stage"
      stage.tabIndex = 0
      const canvas = document.createElement("canvas")
      canvas.className = "cpdf-canvas"
      canvas.setAttribute("role", "img")
      stage.appendChild(canvas)

      root.append(style, toolbar, status, stage)
      container.replaceChildren(root)

      const pageCount = () => session?.pageCount ?? document_?.inspection.pageCount ?? 0

      const updateChrome = () => {
        const total = pageCount()
        const title = document_?.title ?? ""
        root.setAttribute("aria-label", t("preview.title"))
        prev.setAttribute("aria-label", t("preview.previous"))
        next.setAttribute("aria-label", t("preview.next"))
        const navigable = view.kind === "ready" && total > 0
        setDisabled(prev, !navigable || page <= 1)
        setDisabled(next, !navigable || page >= total)
        pageLabel.textContent = navigable ? t("preview.pageOf", { page, total }) : ""
        saveButton.textContent =
          saveState.kind === "saving" ? t("preview.saving") : t("preview.save")
        setDisabled(saveButton, !document_ || saveState.kind === "saving")
        saveButton.setAttribute("aria-busy", String(saveState.kind === "saving"))
        canvas.setAttribute("aria-label", t("preview.pageImage", { title, page, total }))
        canvas.hidden = view.kind !== "ready"
        stage.hidden = view.kind === "error" || view.kind === "encrypted"
        stage.setAttribute("aria-label", t("preview.title"))

        const saveText = describeSave(saveState, t)
        const viewText =
          view.kind === "loading"
            ? t("preview.loading")
            : view.kind === "encrypted"
              ? t("preview.encrypted")
              : view.kind === "error"
                ? t("preview.error", { error: view.message })
                : ""
        status.textContent = [viewText, saveText].filter(Boolean).join(" ")
        const isError = view.kind === "error" || saveState.kind === "failed"
        status.setAttribute("role", isError ? "alert" : "status")
        status.classList.toggle("is-error", isError)
      }

      const paint = async () => {
        if (!session || view.kind !== "ready") return
        const width = pageWidthFor(stage)
        const pixelRatio = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1
        paintedWidth = width
        try {
          await session.renderPage(page, canvas, { cssWidth: width, pixelRatio })
        } catch (error) {
          if (disposed || isRenderCancelled(error)) return
          view = { kind: "error", message: errorMessage(error) }
          updateChrome()
        }
      }

      const goTo = (target: number) => {
        const total = pageCount()
        if (view.kind !== "ready" || target < 1 || target > total || target === page) return
        page = target
        updateChrome()
        void paint()
      }

      const load = async (content: string) => {
        const token = ++loadToken
        const previous = session
        session = null
        if (previous) void previous.destroy()
        try {
          document_ = parsePdfArtifact(content)
        } catch (error) {
          document_ = null
          view = { kind: "error", message: errorMessage(error) }
          updateChrome()
          return
        }
        if (document_.inspection.encrypted) {
          view = { kind: "encrypted" }
          updateChrome()
          return
        }
        view = { kind: "loading" }
        updateChrome()
        try {
          const opened = await openDocument(base64ToBytes(document_.dataBase64))
          if (disposed || token !== loadToken) {
            void opened.destroy()
            return
          }
          session = opened
          page = Math.min(Math.max(1, page), Math.max(1, opened.pageCount))
          view = { kind: "ready" }
          updateChrome()
          await paint()
        } catch (error) {
          if (disposed || token !== loadToken) return
          view = { kind: "error", message: errorMessage(error) }
          updateChrome()
        }
      }

      const save = async () => {
        if (!document_ || saveState.kind === "saving") return
        const filename = normalizePdfName(document_.title)
        saveState = { kind: "saving" }
        updateChrome()
        try {
          const outcome = await deps.save({
            suggestedName: filename,
            mimeType: PDF_MIME,
            bytes: base64ToBytes(document_.dataBase64),
          })
          saveState = outcome.saved ? { kind: "saved", outcome, filename } : { kind: "cancelled" }
        } catch (error) {
          saveState = { kind: "failed", message: errorMessage(error) }
        }
        if (!disposed) updateChrome()
      }

      prev.addEventListener("click", () => {
        if (prev.getAttribute("aria-disabled") !== "true") goTo(page - 1)
      })
      next.addEventListener("click", () => {
        if (next.getAttribute("aria-disabled") !== "true") goTo(page + 1)
      })
      saveButton.addEventListener("click", () => {
        if (saveButton.getAttribute("aria-disabled") !== "true") void save()
      })
      stage.addEventListener("keydown", (event) => {
        const delta =
          event.key === "ArrowRight" || event.key === "PageDown"
            ? 1
            : event.key === "ArrowLeft" || event.key === "PageUp"
              ? -1
              : 0
        if (event.key === "Home") goTo(1)
        else if (event.key === "End") goTo(pageCount())
        else if (delta) goTo(page + delta)
        else return
        event.preventDefault()
      })

      // Re-rasterize when the panel is resized (rotation, split view) so the
      // page stays sharp and fits the width.
      const resizeObserver =
        typeof ResizeObserver === "function"
          ? new ResizeObserver(() => {
              if (Math.abs(pageWidthFor(stage) - paintedWidth) > 4) void paint()
            })
          : null
      resizeObserver?.observe(stage)

      const disposeLocale = deps.onLocaleChange(updateChrome)
      updateChrome()
      void load(artifact.content)

      return {
        update: (updated) => {
          saveState = { kind: "idle" }
          void load(updated.content)
        },
        dispose: () => {
          disposed = true
          loadToken += 1
          disposeLocale()
          resizeObserver?.disconnect()
          if (session) void session.destroy()
          session = null
          container.replaceChildren()
        },
      }
    },
  }
}

function describeSave(state: SaveState, t: PreviewTranslator): string {
  switch (state.kind) {
    case "saved":
      return t(
        state.outcome.platform === "mobile"
          ? "preview.savedMobile"
          : state.outcome.platform === "web"
            ? "preview.savedWeb"
            : "preview.savedDesktop",
        { name: state.filename }
      )
    case "cancelled":
      return t("preview.saveCancelled")
    case "failed":
      return t("preview.saveFailed", { error: state.message })
    default:
      return ""
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * `aria-disabled` keeps a control focusable while it cannot act — a disabled
 * "Next" on the last page would otherwise throw keyboard focus to `body`.
 */
function setDisabled(button: HTMLButtonElement, disabled: boolean): void {
  if (disabled) button.setAttribute("aria-disabled", "true")
  else button.removeAttribute("aria-disabled")
}

function iconButton(glyph: string): HTMLButtonElement {
  const button = document.createElement("button")
  button.type = "button"
  button.className = "cpdf-btn cpdf-icon-btn"
  const icon = document.createElement("span")
  icon.setAttribute("aria-hidden", "true")
  icon.textContent = glyph
  button.appendChild(icon)
  return button
}

const PREVIEW_STYLES = `
.cpdf { display:flex; flex-direction:column; min-height:100%; background:var(--background); color:var(--foreground); font:inherit; }
.cpdf-toolbar { position:sticky; top:0; z-index:1; display:flex; flex-wrap:wrap; align-items:center; gap:6px; padding:6px 8px; border-bottom:1px solid var(--border); background:var(--background); }
.cpdf-page-label { min-width:0; font-size:12px; color:var(--muted-foreground); font-variant-numeric:tabular-nums; }
.cpdf-btn { display:inline-flex; align-items:center; justify-content:center; min-height:36px; min-width:36px; padding:0 10px; border:1px solid var(--border); border-radius:6px; background:var(--secondary); color:var(--secondary-foreground); font:inherit; font-size:13px; cursor:pointer; transition:background-color .15s ease-out; }
.cpdf-icon-btn { padding:0; font-size:20px; line-height:1; }
.cpdf-save { margin-left:auto; }
.cpdf-btn:focus-visible, .cpdf-stage:focus-visible { outline:2px solid var(--ring); outline-offset:2px; }
.cpdf-btn[aria-disabled="true"] { opacity:.5; cursor:default; }
@media (hover:hover) { .cpdf-btn:not([aria-disabled="true"]):hover { background:var(--accent); color:var(--accent-foreground); } }
.cpdf-status { margin:0; padding:6px 12px; font-size:12px; color:var(--muted-foreground); }
.cpdf-status:empty { display:none; }
.cpdf-status.is-error { color:var(--destructive); }
.cpdf-stage { flex:1; min-width:0; overflow:auto; padding:${STAGE_PADDING}px; display:flex; justify-content:center; align-items:flex-start; outline:none; }
.cpdf-canvas { display:block; flex:none; box-shadow:0 1px 3px rgb(0 0 0 / .15); border-radius:2px; }
@media (prefers-reduced-motion:reduce) { .cpdf-btn { transition:none; } }
`
