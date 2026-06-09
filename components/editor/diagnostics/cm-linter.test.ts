import { EditorState } from "@codemirror/state"
import { setDiagnostics } from "@codemirror/lint"
import {
  editorDiagnostics,
  externalDiagnosticsField,
  setExternalDiagnostics,
  toCmDiagnostic,
  runDiagnostics,
  buildLintSource,
  getDiagnosticSummary,
  pushDiagnostics,
  DEFAULT_LINT_DELAY,
} from "./cm-linter"
import { getDiagnosticsProducer } from "./registry"

jest.mock("@codemirror/lint", () => ({
  ...jest.requireActual("@codemirror/lint"),
  forceLinting: jest.fn(),
}))
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { forceLinting } = require("@codemirror/lint")

// Mock the registry but delegate to the real producers by default, so only the
// throw-path test overrides it (ESM live bindings can't be re-spied in place).
jest.mock("./registry", () => {
  const actual = jest.requireActual("./registry")
  return { getDiagnosticsProducer: jest.fn(actual.getDiagnosticsProducer) }
})
const mockedGetProducer = getDiagnosticsProducer as jest.Mock

describe("toCmDiagnostic", () => {
  it("clamps from/to into document bounds and keeps from <= to", () => {
    const d = toCmDiagnostic({ from: -5, to: 999, severity: "error", message: "x" }, 10)
    expect(d.from).toBe(0)
    expect(d.to).toBe(10)
    const d2 = toCmDiagnostic({ from: 8, to: 2, severity: "warning", message: "y" }, 10)
    expect(d2.from).toBe(8)
    expect(d2.to).toBe(8)
  })
})

describe("runDiagnostics", () => {
  it("produces in-browser diagnostics for the language", async () => {
    const out = await runDiagnostics("json", '{ "a": }', [])
    expect(out.length).toBeGreaterThanOrEqual(1)
    expect(out[0].severity).toBe("error")
  })

  it("merges external diagnostics on top of producer output", async () => {
    const external = [{ from: 0, to: 1, severity: "warning" as const, message: "ext" }]
    const out = await runDiagnostics("json", '{ "a": 1 }', external)
    expect(out).toHaveLength(1)
    expect(out[0].message).toBe("ext")
  })

  it("returns only external diagnostics for languages without a producer", async () => {
    const external = [{ from: 0, to: 2, severity: "info" as const, message: "lsp" }]
    const out = await runDiagnostics("plaintext", "anything", external)
    expect(out).toHaveLength(1)
    expect(out[0].message).toBe("lsp")
  })

  it("swallows a producer that throws", async () => {
    mockedGetProducer.mockReturnValueOnce(() => {
      throw new Error("boom")
    })
    const out = await runDiagnostics("json", "x", [])
    expect(out).toEqual([])
  })
})

describe("externalDiagnosticsField + setExternalDiagnostics", () => {
  it("starts empty and updates on the effect", () => {
    const state = EditorState.create({ extensions: [externalDiagnosticsField] })
    expect(state.field(externalDiagnosticsField)).toEqual([])
    const next = state.update({
      effects: setExternalDiagnostics.of([{ from: 0, to: 1, severity: "error", message: "e" }]),
    }).state
    expect(next.field(externalDiagnosticsField)).toHaveLength(1)
  })
})

describe("editorDiagnostics", () => {
  it("builds an extension array and exposes a default delay", () => {
    const ext = editorDiagnostics({ language: "typescript" })
    expect(Array.isArray(ext)).toBe(true)
    expect(DEFAULT_LINT_DELAY).toBeGreaterThan(0)
  })
})

describe("buildLintSource", () => {
  it("reads the document and external field, merging both", async () => {
    const base = EditorState.create({ doc: '{ "a": }', extensions: [externalDiagnosticsField] })
    const state = base.update({
      effects: setExternalDiagnostics.of([{ from: 0, to: 1, severity: "info", message: "ext" }]),
    }).state
    const out = await buildLintSource("json")({ state } as never)
    // one JSON syntax error + the external diagnostic
    expect(out.length).toBeGreaterThanOrEqual(2)
    expect(out.some((d) => d.message === "ext")).toBe(true)
  })

  it("defaults to an empty external set when the field is absent", async () => {
    const state = EditorState.create({ doc: "{}" })
    const out = await buildLintSource("json")({ state } as never)
    expect(out).toEqual([])
  })
})

describe("getDiagnosticSummary", () => {
  it("counts diagnostics by severity", () => {
    const state = EditorState.create({ doc: "abcdef" })
    const next = state.update(
      setDiagnostics(state, [
        { from: 0, to: 1, severity: "error", message: "a" },
        { from: 1, to: 2, severity: "error", message: "b" },
        { from: 2, to: 3, severity: "warning", message: "c" },
        { from: 3, to: 4, severity: "info", message: "d" },
      ])
    ).state
    expect(getDiagnosticSummary(next)).toEqual({ errors: 2, warnings: 1, infos: 1 })
  })

  it("reports zeros for a clean document", () => {
    const state = EditorState.create({ doc: "ok" })
    expect(getDiagnosticSummary(state)).toEqual({ errors: 0, warnings: 0, infos: 0 })
  })
})

describe("pushDiagnostics", () => {
  it("dispatches the external effect and forces a lint run", () => {
    const dispatch = jest.fn()
    const view = { dispatch } as never
    pushDiagnostics(view, [{ from: 0, to: 1, severity: "error", message: "e" }])
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(forceLinting).toHaveBeenCalledWith(view)
  })
})
