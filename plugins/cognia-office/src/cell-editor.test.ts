/** @jest-environment jsdom */

import type { Artifact } from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"
import { cellEditOperations, cellInputText, parseCellInput } from "./cell-editor"
import {
  applyWorkbookOperations,
  createWorkbook,
  WORKBOOK_ARTIFACT_KIND,
  type WorkbookDocument,
  type WorkbookOperation,
} from "./model"
import { createWorkbookRenderer, preloadWorkbookPreviewEngine } from "./preview"

const EN = manifestJson.i18n.locales.en as Record<string, string>
const t = (key: string, params?: Record<string, string | number>) => {
  let text = EN[key] ?? key
  for (const [name, value] of Object.entries(params ?? {}))
    text = text.replaceAll(`{${name}}`, String(value))
  return text
}

describe("parseCellInput", () => {
  it("follows Excel's typing conventions", () => {
    expect(parseCellInput("=SUM(A1:A2)")).toEqual({ type: "number", formula: "SUM(A1:A2)" })
    expect(parseCellInput("=A1+1", { type: "date", value: "x" })).toEqual({
      type: "date",
      formula: "A1+1",
    })
    expect(parseCellInput("'00123")).toEqual({ type: "string", value: "00123" })
    expect(parseCellInput(" -1.5e2 ")).toEqual({ type: "number", value: -150 })
    expect(parseCellInput("true")).toEqual({ type: "boolean", value: true })
    expect(parseCellInput("2024-02-29")).toEqual({
      type: "date",
      value: new Date(2024, 1, 29).toISOString(),
    })
    expect(parseCellInput("2023-02-29")).toEqual({ type: "string", value: "2023-02-29" })
    expect(parseCellInput("=")).toEqual({ type: "string", value: "=" })
    expect(parseCellInput("hello")).toEqual({ type: "string", value: "hello" })
  })
})

describe("cellInputText", () => {
  it("shows the formula, or the raw value in a form that parses back", () => {
    expect(cellInputText(undefined)).toBe("")
    expect(cellInputText({ type: "number", formula: "A1*2", value: 4 })).toBe("=A1*2")
    expect(cellInputText({ type: "boolean", value: false })).toBe("FALSE")
    expect(cellInputText({ type: "date", value: new Date(2024, 0, 5).toISOString() })).toBe(
      "2024-01-05"
    )
    expect(cellInputText({ type: "string", value: "123" })).toBe("'123")
    expect(cellInputText({ type: "string", value: "abc" })).toBe("abc")
  })
})

describe("cellEditOperations", () => {
  it("returns null for an unchanged entry or clearing an empty cell", () => {
    expect(cellEditOperations("S", "A1", "=A2", { type: "number", formula: "A2" })).toBeNull()
    expect(cellEditOperations("S", "A1", "", undefined)).toBeNull()
  })

  it("keeps formatting when a value is typed and clears only contents", () => {
    const style = { font: { bold: true } }
    expect(cellEditOperations("S", "B2", "5", { type: "string", value: "x", style })).toEqual([
      { op: "setCell", sheet: "S", cell: "B2", value: { type: "number", value: 5, style } },
    ])
    expect(cellEditOperations("S", "B2", " ", { type: "number", value: 1 })).toEqual([
      { op: "clearRange", sheet: "S", range: "B2", target: "contents" },
    ])
  })
})

describe("editable preview grid", () => {
  beforeAll(async () => {
    await preloadWorkbookPreviewEngine()
  })
  afterEach(() => document.body.replaceChildren())

  function mount(workbook: WorkbookDocument, applyEdit: jest.Mock) {
    const artifact: Artifact = {
      id: "a1",
      sessionId: "s1",
      messageId: "m1",
      type: "code",
      title: "Book",
      content: JSON.stringify(workbook),
      language: "json",
      version: 3,
      createdAt: new Date(),
      updatedAt: new Date(),
      metadata: {
        plugin: { kind: WORKBOOK_ARTIFACT_KIND, schemaVersion: 1, ownerPluginId: "cognia-office" },
      },
    }
    const container = document.createElement("div")
    document.body.appendChild(container)
    const handle = createWorkbookRenderer({ t, onLocaleChange: () => () => {}, applyEdit }).mount(
      artifact,
      container
    )
    const grid = () => container.querySelector<HTMLTableElement>("table[role='grid']")!
    const td = (ref: string) => container.querySelector<HTMLElement>(`td[data-ref="${ref}"]`)!
    const input = () => container.querySelector<HTMLInputElement>(".copv-cell-input")
    const key = (target: HTMLElement, name: string, init: KeyboardEventInit = {}) =>
      target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, ...init }))
    const type = (value: string) => {
      const field = input()!
      field.value = value
      field.dispatchEvent(new Event("input"))
    }
    return { artifact, container, handle, grid, td, input, key, type }
  }

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

  const sample = () =>
    applyWorkbookOperations(createWorkbook("Book"), [
      {
        op: "setRange",
        sheet: "Sheet1",
        range: "A1:B2",
        values: [
          [
            { type: "number", value: 1 },
            { type: "number", value: 2 },
          ],
          [
            { type: "number", formula: "A1+B1", value: 3 },
            { type: "string", value: "note" },
          ],
        ],
      },
    ])

  it("is an ARIA grid with one active cell and a spare row and column to type into", () => {
    const { grid, td } = mount(sample(), jest.fn())
    expect(grid().tabIndex).toBe(0)
    expect(grid().getAttribute("aria-label")).toContain("Sheet1")
    expect(grid().getAttribute("aria-activedescendant")).toBe(td("A1").id)
    expect(td("A1").getAttribute("aria-selected")).toBe("true")
    expect(td("C3")).not.toBeNull()
  })

  it("moves with arrow keys and commits a typed value with its version", async () => {
    const applyEdit = jest.fn().mockResolvedValue({ ok: true })
    const { grid, td, input, key, type } = mount(sample(), applyEdit)
    key(grid(), "ArrowRight")
    key(grid(), "ArrowDown")
    expect(grid().getAttribute("aria-activedescendant")).toBe(td("B2").id)
    key(grid(), "Enter")
    expect(input()?.value).toBe("note")
    type("=A1*10")
    key(input()!, "Enter")
    await flush()
    expect(applyEdit).toHaveBeenCalledWith("a1", 3, [
      {
        op: "setCell",
        sheet: "Sheet1",
        cell: "B2",
        value: { type: "number", formula: "A1*10" },
      },
    ] satisfies WorkbookOperation[])
    // Enter moves down, like Excel.
    expect(grid().getAttribute("aria-activedescendant")).toBe(td("B3").id)
    expect(input()).toBeNull()
  })

  it("starts an edit from a typed character and cancels with Escape", async () => {
    const applyEdit = jest.fn()
    const { grid, input, key } = mount(sample(), applyEdit)
    key(grid(), "7")
    expect(input()?.value).toBe("7")
    key(input()!, "Escape")
    await flush()
    expect(input()).toBeNull()
    expect(applyEdit).not.toHaveBeenCalled()
  })

  it("clears contents with Delete and commits on leaving the field", async () => {
    const applyEdit = jest.fn().mockResolvedValue({ ok: true })
    const { container, grid, td, input, key, type } = mount(sample(), applyEdit)
    key(grid(), "Delete")
    await flush()
    expect(applyEdit).toHaveBeenLastCalledWith("a1", 3, [
      { op: "clearRange", sheet: "Sheet1", range: "A1", target: "contents" },
    ])
    td("B1").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))
    type("4")
    input()!.dispatchEvent(new FocusEvent("blur"))
    await flush()
    expect(applyEdit).toHaveBeenLastCalledWith("a1", 3, [
      { op: "setCell", sheet: "Sheet1", cell: "B1", value: { type: "number", value: 4 } },
    ])
    expect(container.querySelector(".copv-edit-status")).toBeNull()
  })

  it("keeps the draft across a re-render and uses the updated version", async () => {
    const applyEdit = jest.fn().mockResolvedValue({ ok: true })
    const { artifact, grid, handle, input, key, type } = mount(sample(), applyEdit)
    key(grid(), "F2")
    type("42")
    handle.update?.({ ...artifact, version: 4 })
    expect(input()?.value).toBe("42")
    key(input()!, "Tab")
    await flush()
    expect(applyEdit).toHaveBeenCalledWith("a1", 4, expect.any(Array))
  })

  it("explains a version conflict and blocks edits while saving", async () => {
    let reject: (error: Error) => void = () => {}
    const applyEdit = jest.fn(
      () =>
        new Promise((_, fail) => {
          reject = fail
        })
    )
    const { container, grid, input, key } = mount(sample(), applyEdit)
    key(grid(), "9")
    key(input()!, "Enter")
    await flush()
    expect(container.querySelector(".copv-edit-status")?.textContent).toBe(EN["edit.saving"])
    expect(grid().getAttribute("aria-busy")).toBe("true")
    key(grid(), "Enter")
    expect(input()).toBeNull()
    reject(new Error("artifact version conflict for a1: expected 3, current 4"))
    await flush()
    const status = container.querySelector(".copv-edit-status")
    expect(status?.getAttribute("role")).toBe("alert")
    expect(status?.textContent).toBe(EN["edit.conflict"])
  })

  it("reports any other failure with its message", async () => {
    const applyEdit = jest.fn().mockRejectedValue(new Error("merge.overlap: bad"))
    const { container, grid, input, key } = mount(sample(), applyEdit)
    // A1 holds 1: typing 5 is a change (typing 1 would be a no-op).
    key(grid(), "5")
    key(input()!, "Enter")
    await flush()
    expect(container.querySelector(".copv-edit-status")?.textContent).toBe(
      "The edit was not applied: merge.overlap: bad"
    )
  })

  it("steps over cells a merge covers", () => {
    const workbook = applyWorkbookOperations(sample(), [
      { op: "merge", sheet: "Sheet1", range: "A1:B1" },
    ])
    const { grid, td, key } = mount(workbook, jest.fn())
    key(grid(), "ArrowRight")
    expect(grid().getAttribute("aria-activedescendant")).toBe(td("C1").id)
  })

  it("stays read-only without an edit channel", async () => {
    const container = document.createElement("div")
    createWorkbookRenderer({ t, onLocaleChange: () => () => {} }).mount(
      {
        id: "a1",
        type: "code",
        title: "Book",
        content: JSON.stringify(sample()),
        version: 1,
        sessionId: "s",
        messageId: "m",
        createdAt: new Date(),
        updatedAt: new Date(),
      } as Artifact,
      container
    )
    expect(container.querySelector("table[role='grid']")).toBeNull()
    expect(container.querySelector("td[data-ref='C3']")).toBeNull()
  })
})
