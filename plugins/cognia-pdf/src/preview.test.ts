/** @jest-environment jsdom */

jest.mock("./pdf-engine", () => ({
  openPdfForRender: jest.fn(),
  isRenderCancelled: (error: unknown) =>
    (error as { name?: string } | null)?.name === "RenderingCancelledException",
}))

import type { Artifact } from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"
import { createPdfArtifactDocument, PDF_ARTIFACT_KIND } from "./model"
import type { PdfRenderSession } from "./pdf-engine"
import { createPdfRenderer, type PdfPreviewDeps } from "./preview"

const LOCALES = manifestJson.i18n.locales as Record<string, Record<string, string>>
let locale = "en"
const t = (key: string, params?: Record<string, string | number>) => {
  let text = LOCALES[locale]?.[key] ?? LOCALES.en[key] ?? key
  for (const [name, value] of Object.entries(params ?? {}))
    text = text.replace(`{${name}}`, String(value))
  return text
}

function artifact(
  options: { content?: string; encrypted?: boolean; title?: string } = {}
): Artifact {
  return {
    id: "pdf-1",
    sessionId: "",
    messageId: "",
    type: "code",
    title: "Form",
    content:
      options.content ??
      JSON.stringify(
        createPdfArtifactDocument({
          title: options.title ?? "Form",
          bytes: Uint8Array.from([1, 2, 3]),
          inspection: {
            pageCount: 3,
            encrypted: options.encrypted ?? false,
            signed: false,
            fields: [],
            metadata: {},
            warnings: [],
          },
        })
      ),
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    metadata: {
      plugin: { kind: PDF_ARTIFACT_KIND, schemaVersion: 1, ownerPluginId: "cognia-pdf" },
    },
  }
}

function fakeSession(pageCount = 3) {
  const renderPage = jest.fn(async (_page: number, _canvas: HTMLCanvasElement) => ({
    cssWidth: 600,
    cssHeight: 800,
  }))
  const destroy = jest.fn(async () => undefined)
  const session: PdfRenderSession = { pageCount, renderPage, destroy }
  return { session, renderPage, destroy }
}

const flush = async () => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve()
}

function mount(overrides: Partial<PdfPreviewDeps> = {}, source = artifact()) {
  const { session, renderPage, destroy } = fakeSession()
  let localeHandler: () => void = () => {}
  const save = jest.fn(async () => ({ saved: true, platform: "desktop" as const }))
  const openDocument = jest.fn(async () => session)
  const container = document.createElement("div")
  document.body.appendChild(container)
  const handle = createPdfRenderer({
    t,
    onLocaleChange: (handler) => {
      localeHandler = handler
      return () => {}
    },
    save,
    openDocument,
    ...overrides,
  }).mount(source, container)
  const button = (label: string) =>
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) =>
        candidate.textContent === label || candidate.getAttribute("aria-label") === label
    )!
  return {
    container,
    handle,
    save,
    openDocument,
    renderPage,
    destroy,
    button,
    switchLocale(next: string) {
      locale = next
      localeHandler()
    },
  }
}

afterEach(() => {
  locale = "en"
  document.body.replaceChildren()
})

it("paints the first page on a canvas instead of embedding a blob iframe", async () => {
  const env = mount()
  expect(env.container.querySelector('[role="status"]')).toHaveTextContent("Rendering PDF…")
  await flush()
  expect(env.container.querySelector("iframe")).toBeNull()
  expect(env.openDocument).toHaveBeenCalledWith(Uint8Array.from([1, 2, 3]))
  const canvas = env.container.querySelector("canvas")!
  expect(env.renderPage).toHaveBeenCalledWith(1, canvas, expect.objectContaining({ cssWidth: 640 }))
  expect(canvas).toHaveAttribute("aria-label", "Form, page 1 of 3")
  expect(env.container.textContent).toContain("Page 1 of 3")
})

it("pages with touch-sized buttons and the keyboard without losing focus", async () => {
  const env = mount()
  await flush()
  const previous = env.button("Previous page")
  const next = env.button("Next page")
  expect(previous).toHaveAttribute("aria-disabled", "true")
  next.focus()
  next.click()
  await flush()
  expect(env.renderPage).toHaveBeenLastCalledWith(2, expect.anything(), expect.anything())
  expect(document.activeElement).toBe(next)
  next.click()
  await flush()
  expect(next).toHaveAttribute("aria-disabled", "true")
  next.click()
  expect(env.renderPage).toHaveBeenCalledTimes(3)

  const stage = env.container.querySelector<HTMLElement>(".cpdf-stage")!
  stage.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }))
  await flush()
  expect(env.renderPage).toHaveBeenLastCalledWith(1, expect.anything(), expect.anything())
  stage.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))
  await flush()
  expect(env.renderPage).toHaveBeenLastCalledWith(2, expect.anything(), expect.anything())

  const css = env.container.querySelector("style")?.textContent ?? ""
  expect(css).toContain("min-height:36px; min-width:36px")
  expect(css).toContain(":focus-visible")
  expect(css).toContain("prefers-reduced-motion")
})

it("saves through ctx.files.save and reports where the file went", async () => {
  const env = mount({}, artifact({ title: "Signed/Form" }))
  await flush()
  env.save.mockResolvedValueOnce({ saved: true, platform: "mobile" } as never)
  env.button("Save PDF").click()
  expect(env.button("Saving…")).toHaveAttribute("aria-disabled", "true")
  await flush()
  expect(env.save).toHaveBeenCalledWith({
    suggestedName: "Signed-Form.pdf",
    mimeType: "application/pdf",
    bytes: Uint8Array.from([1, 2, 3]),
  })
  expect(env.container.querySelector(".cpdf-status")).toHaveTextContent(
    "Saved Signed-Form.pdf to Documents/cognia/exports."
  )

  env.save.mockResolvedValueOnce({ saved: false } as never)
  env.button("Save PDF").click()
  await flush()
  expect(env.container.querySelector(".cpdf-status")).toHaveTextContent("Save cancelled.")

  env.save.mockRejectedValueOnce(new Error("disk full"))
  env.button("Save PDF").click()
  await flush()
  const status = env.container.querySelector(".cpdf-status")!
  expect(status).toHaveAttribute("role", "alert")
  expect(status).toHaveTextContent("Could not save the PDF: disk full")
})

it("follows locale changes without rebuilding the toolbar", async () => {
  const env = mount()
  await flush()
  const next = env.button("Next page")
  next.focus()
  env.switchLocale("zh-CN")
  expect(next).toHaveAttribute("aria-label", "下一页")
  expect(document.activeElement).toBe(next)
  expect(env.container.textContent).toContain("第 1 页，共 3 页")
  expect(env.button("保存 PDF")).toBeDefined()
})

it("explains encrypted PDFs, surfaces load errors, and recovers on update", async () => {
  const encrypted = mount({}, artifact({ encrypted: true }))
  await flush()
  expect(encrypted.openDocument).not.toHaveBeenCalled()
  expect(encrypted.container.querySelector(".cpdf-status")).toHaveTextContent("password-protected")

  const broken = mount({ openDocument: jest.fn(async () => Promise.reject(new Error("bad xref"))) })
  await flush()
  const alert = broken.container.querySelector('[role="alert"]')!
  expect(alert).toHaveTextContent("Unable to render this PDF: bad xref")

  const malformed = mount({}, artifact({ content: "not json" }))
  await flush()
  expect(malformed.container.querySelector('[role="alert"]')).not.toBeNull()
  malformed.handle.update?.(artifact())
  await flush()
  expect(malformed.renderPage).toHaveBeenCalledWith(1, expect.anything(), expect.anything())
})

it("ignores cancelled renders and releases the pdf.js document on dispose", async () => {
  const env = mount()
  await flush()
  env.renderPage.mockRejectedValueOnce(
    Object.assign(new Error("cancelled"), { name: "RenderingCancelledException" })
  )
  env.button("Next page").click()
  await flush()
  expect(env.container.querySelector('[role="alert"]')).toBeNull()
  env.handle.dispose()
  expect(env.destroy).toHaveBeenCalled()
  expect(env.container).toBeEmptyDOMElement()
})
