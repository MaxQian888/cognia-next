/** @jest-environment jsdom */

import type { Artifact } from "@cognia/plugin-sdk"
import { applyDocumentOperations, createDocument, type DocumentModel } from "./model"
import { createDocumentRenderer, wordCount, type DocumentPreviewDeps } from "./preview"

const LABELS: Record<string, string> = {
  "documents.preview.review": "Review",
  "documents.preview.comments": "Comments",
  "documents.preview.changes": "Tracked changes",
  "documents.preview.validation": "Validation",
  "documents.preview.empty": "This document is empty.",
  "documents.preview.wordCount": "{count} words",
  "documents.preview.source": "Source: {name}",
  "documents.preview.open": "Open",
  "documents.preview.resolved": "Resolved",
  "documents.preview.pending": "Pending",
  "documents.preview.accepted": "Accepted",
  "documents.preview.resolve": "Resolve",
  "documents.preview.reopen": "Reopen",
  "documents.preview.accept": "Accept",
  "documents.preview.reject": "Reject",
  "documents.preview.showBlock": "Show block",
  "documents.preview.actionFailed": "Review action failed: {error}",
}

const t = (key: string, params?: Record<string, string | number>) => {
  let text = LABELS[key] ?? key
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

afterEach(() => document.body.replaceChildren())

it("renders the paper layout with grouped lists, tables, and meta", () => {
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
  expect(container.querySelector("table.cdoc-table th")).toHaveTextContent("H")
  expect(container.querySelector(".cdoc-meta")).toHaveTextContent("Source: brief.docx")
  expect(container.querySelector(".cdoc-meta")).toHaveTextContent("words")
})

it("renders comment and change cards with actions", async () => {
  const model = applyDocumentOperations(createDocument("Doc", "v1"), [
    { op: "addComment", blockId: "b1", text: "Look here", author: "Jane" },
    { op: "replaceText", blockId: "b1", text: "v2", trackChange: true },
  ])
  const applyReview = jest.fn(async () => ({}))
  const { container } = mount(model, { applyReview })

  const cards = container.querySelectorAll(".cdoc-card")
  expect(cards).toHaveLength(2)
  expect(container.querySelector(".cdoc-review")).toHaveTextContent("Look here")
  const diff = container.querySelector(".cdoc-diff")
  expect(diff?.querySelector("del")).toHaveTextContent("v1")
  expect(diff?.querySelector("ins")).toHaveTextContent("v2")

  // Resolve the comment.
  const resolveButton = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Resolve"
  )!
  resolveButton.click()
  await Promise.resolve()
  expect(applyReview).toHaveBeenCalledWith("d1", 1, [
    { op: "resolveComment", commentId: model.comments[0].id },
  ])

  // Accept the change.
  const acceptButton = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Accept"
  )!
  acceptButton.click()
  await Promise.resolve()
  expect(applyReview).toHaveBeenCalledWith("d1", 1, [
    { op: "acceptChange", changeId: model.changes[0].id },
  ])
})

it("shows review errors inline when an action fails", async () => {
  const model = applyDocumentOperations(createDocument("Doc", "v1"), [
    { op: "addComment", blockId: "b1", text: "note" },
  ])
  const applyReview = jest.fn(async () => {
    throw new Error("version conflict")
  })
  const { container } = mount(model, { applyReview })
  const resolveButton = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Resolve"
  )!
  resolveButton.click()
  await Promise.resolve()
  await Promise.resolve()
  expect(container.querySelector(".cdoc-review-error")).toHaveTextContent("version conflict")
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
  localeHandler?.()
  expect(container.querySelector(".cdoc-review")).not.toBeNull()
})

it("renders the empty state and survives invalid content", () => {
  const { container } = mount(createDocument("Empty"))
  expect(container.querySelector(".cdoc-empty")).toHaveTextContent("This document is empty.")

  const bad = document.createElement("div")
  createDocumentRenderer({ t, applyReview: jest.fn(), onLocaleChange: () => () => {} }).mount(
    { id: "bad", version: 1, content: "not json" } as Artifact,
    bad
  )
  expect(bad.querySelector('[role="alert"]')).not.toBeNull()
})

it("counts CJK characters and latin words", () => {
  const model = createDocument("Doc", "hello world 中文测试")
  expect(wordCount(model)).toBe(6)
})
