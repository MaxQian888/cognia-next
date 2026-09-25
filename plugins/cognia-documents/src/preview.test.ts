/** @jest-environment jsdom */

import type { Artifact } from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"
import { applyDocumentOperations, createDocument, type DocumentModel } from "./model"
import {
  createDocumentRenderer,
  localizeFinding,
  wordCount,
  type DocumentPreviewDeps,
} from "./preview"

const LOCALES = manifestJson.i18n.locales as Record<string, Record<string, string>>
let locale = "en"

const t = (key: string, params?: Record<string, string | number>) => {
  let text = LOCALES[locale]?.[key] ?? LOCALES.en[key] ?? key
  for (const [name, value] of Object.entries(params ?? {}))
    text = text.replace(`{${name}}`, String(value))
  return text
}

const artifactOf = (model: DocumentModel, version = 1): Artifact =>
  ({
    id: "d1",
    version,
    content: JSON.stringify(model),
  }) as Artifact

function mount(model: DocumentModel, overrides: Partial<DocumentPreviewDeps> = {}) {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const deps: DocumentPreviewDeps = {
    t,
    applyReview: jest.fn(async () => ({})),
    onLocaleChange: () => () => {},
    ...overrides,
  }
  const handle = createDocumentRenderer(deps).mount(artifactOf(model), container)
  return { container, deps, handle }
}

const button = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll("button")].find((candidate) => candidate.textContent === label)!

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

afterEach(() => {
  locale = "en"
  document.body.replaceChildren()
})

it("names the renderer in the active locale", () => {
  expect(
    createDocumentRenderer({ t, applyReview: jest.fn(), onLocaleChange: () => () => {} }).name
  ).toBe("Cognia Document")
})

it("renders the paper layout with grouped lists, scrollable tables, and meta", () => {
  const model = applyDocumentOperations(createDocument("Brief", "Intro"), [
    { op: "appendListItem", text: "one", ordered: true },
    { op: "appendListItem", text: "two", ordered: true },
    { op: "appendListItem", text: "bullet", ordered: false },
    { op: "appendTable", rows: [["H"], ["v"]] },
  ])
  model.sourceFilename = "brief.docx"
  const { container } = mount(model)
  expect(container.querySelector("h1")).toHaveTextContent("Brief")
  const lists = container.querySelectorAll(".cdoc-list")
  expect(lists).toHaveLength(2)
  expect(lists[0].tagName).toBe("OL")
  expect(lists[0].querySelectorAll("li")).toHaveLength(2)
  expect(lists[1].tagName).toBe("UL")
  const scroller = container.querySelector(".cdoc-table-scroll")
  expect(scroller).toHaveAttribute("role", "region")
  expect(scroller).toHaveAttribute("aria-label", "Table")
  expect(scroller?.querySelector("table.cdoc-table th")).toHaveTextContent("H")
  expect(container.querySelector(".cdoc-meta")).toHaveTextContent("Source: brief.docx")
  expect(container.querySelector(".cdoc-meta")).toHaveTextContent("words")
  // The narrow-screen layout is a container query on the preview root.
  expect(container.querySelector("style")?.textContent).toContain("@container (max-width: 600px)")
  expect(container.querySelector("style")?.textContent).toContain("prefers-reduced-motion")
})

it("renders comment and change cards with actions", async () => {
  const model = applyDocumentOperations(createDocument("Doc", "v1"), [
    { op: "addComment", blockId: "b1", text: "Look here", author: "Jane" },
    { op: "replaceText", blockId: "b1", text: "v2", trackChange: true },
  ])
  const applyReview = jest.fn(async () => ({}))
  const { container } = mount(model, { applyReview })

  expect(container.querySelectorAll(".cdoc-card")).toHaveLength(2)
  expect(container.querySelector(".cdoc-review")).toHaveTextContent("Look here")
  const diff = container.querySelector(".cdoc-diff")
  expect(diff?.querySelector("del")).toHaveTextContent("v1")
  expect(diff?.querySelector("ins")).toHaveTextContent("v2")

  button(container, "Resolve").click()
  await flush()
  expect(applyReview).toHaveBeenCalledWith("d1", 1, [
    { op: "resolveComment", commentId: model.comments[0].id },
  ])

  button(container, "Accept").click()
  await flush()
  expect(applyReview).toHaveBeenCalledWith("d1", 1, [
    { op: "acceptChange", changeId: model.changes[0].id },
  ])
})

it("locks review actions while one is pending and unlocks when it settles", async () => {
  const model = applyDocumentOperations(createDocument("Doc", "v1"), [
    { op: "addComment", blockId: "b1", text: "note" },
    { op: "replaceText", blockId: "b1", text: "v2", trackChange: true },
  ])
  let settle: () => void = () => {}
  const applyReview = jest.fn(() => new Promise<void>((resolve) => (settle = resolve)))
  const { container } = mount(model, { applyReview })

  button(container, "Resolve").click()
  await flush()
  expect(button(container, "Accept")).toHaveAttribute("aria-disabled", "true")
  expect(container.querySelector(".cdoc-review")).toHaveAttribute("aria-busy", "true")
  expect(container.querySelector(".cdoc-review-status")).toHaveTextContent("Saving review…")
  // "Show block" never mutates, so it stays live.
  expect(button(container, "Show block")).not.toHaveAttribute("aria-disabled")

  button(container, "Accept").click()
  await flush()
  expect(applyReview).toHaveBeenCalledTimes(1)

  settle()
  await flush()
  expect(button(container, "Accept")).not.toHaveAttribute("aria-disabled")
  expect(container.querySelector(".cdoc-review")).toHaveAttribute("aria-busy", "false")
})

it("keeps keyboard focus on the same control across re-renders", async () => {
  const model = applyDocumentOperations(createDocument("Doc", "v1"), [
    { op: "addComment", blockId: "b1", text: "note" },
  ])
  let localeHandler: () => void = () => {}
  const { container, handle } = mount(model, {
    onLocaleChange: (handler) => {
      localeHandler = handler
      return () => {}
    },
  })
  button(container, "Resolve").focus()
  locale = "zh-CN"
  localeHandler()
  expect(document.activeElement).toBe(button(container, "标记已解决"))

  const resolved = applyDocumentOperations(model, [
    { op: "resolveComment", commentId: model.comments[0].id },
  ])
  handle.update?.(artifactOf(resolved, 2))
  // Same toggle, now labelled "Reopen" — focus follows it.
  expect(document.activeElement).toBe(button(container, "重新打开"))
})

it("moves focus to the review heading when the focused card disappears", () => {
  const model = applyDocumentOperations(createDocument("Doc", "v1"), [
    { op: "addComment", blockId: "b1", text: "note" },
    { op: "replaceText", blockId: "b1", text: "v2", trackChange: true },
  ])
  const { container, handle } = mount(model)
  button(container, "Reject").focus()
  const rejected = applyDocumentOperations(model, [
    { op: "rejectChange", changeId: model.changes[0].id },
  ])
  handle.update?.(artifactOf(rejected, 2))
  expect(document.activeElement).toBe(container.querySelector(".cdoc-review-title"))
})

it("shows review errors inline when an action fails", async () => {
  const model = applyDocumentOperations(createDocument("Doc", "v1"), [
    { op: "addComment", blockId: "b1", text: "note" },
  ])
  const applyReview = jest.fn(async () => {
    throw new Error("version conflict")
  })
  const { container } = mount(model, { applyReview })
  button(container, "Resolve").click()
  await flush()
  expect(container.querySelector(".cdoc-review-error")).toHaveTextContent("version conflict")
  expect(button(container, "Resolve")).not.toHaveAttribute("aria-disabled")
})

it("scrolls to and focuses a block, escaping its id and honouring reduced motion", () => {
  const model = createDocument("Doc", "target")
  model.blocks[0].id = 'b"1'
  model.comments.push({ id: "m1", blockId: 'b"1', text: "n", author: "A", resolved: false })
  const matchMedia = jest.fn(() => ({ matches: true }) as MediaQueryList)
  Object.defineProperty(window, "matchMedia", { configurable: true, value: matchMedia })
  const scrollIntoView = jest.fn()
  Element.prototype.scrollIntoView = scrollIntoView
  const { container } = mount(model)
  button(container, "Show block").click()
  const block = container.querySelector(".cdoc-paragraph") as HTMLElement
  expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "auto", block: "center" })
  expect(document.activeElement).toBe(block)
  expect(block.classList.contains("cdoc-flash")).toBe(true)
})

it("re-renders on update and on locale change", () => {
  const model = applyDocumentOperations(createDocument("Doc", "x"), [
    { op: "addComment", blockId: "b1", text: "note" },
  ])
  let localeHandler: (() => void) | undefined
  const { container, handle } = mount(model, {
    onLocaleChange: (handler) => {
      localeHandler = handler
      return () => {}
    },
  })
  const next = applyDocumentOperations(model, [{ op: "resolveComment", commentId: "m2" }])
  handle.update?.(artifactOf(next, 2))
  expect(container.querySelector(".cdoc-card.is-resolved")).not.toBeNull()
  expect(container.querySelector(".cdoc-chip")).toHaveTextContent("Resolved")
  locale = "zh-CN"
  localeHandler?.()
  expect(container.querySelector(".cdoc-chip")).toHaveTextContent("已解决")
})

it("localizes validation findings, including legacy feature labels", () => {
  const model = createDocument("Doc", "x")
  model.importedFeatures = ["tracked changes", "fields"]
  locale = "zh-CN"
  const { container } = mount(model)
  const findings = [...container.querySelectorAll(".cdoc-finding")].map((item) => item.textContent)
  expect(findings).toEqual([
    "导入的内容需要复核：修订记录",
    "导入的内容需要复核：域（目录、交叉引用）",
  ])
  expect(
    localizeFinding({ severity: "warning", code: "unknown.code", message: "raw text" }, t)
  ).toBe("raw text")
})

it("renders the empty state and a localized error for invalid content", () => {
  const { container } = mount(createDocument("Empty"))
  expect(container.querySelector(".cdoc-empty")).toHaveTextContent("This document is empty.")

  const bad = document.createElement("div")
  createDocumentRenderer({ t, applyReview: jest.fn(), onLocaleChange: () => () => {} }).mount(
    { id: "bad", version: 1, content: "not json" } as Artifact,
    bad
  )
  const alert = bad.querySelector('[role="alert"]')
  expect(alert?.textContent).toContain("This artifact is not a valid Cognia document")
})

it("counts CJK characters and latin words", () => {
  const model = createDocument("Doc", "hello world 中文测试")
  expect(wordCount(model)).toBe(6)
})
