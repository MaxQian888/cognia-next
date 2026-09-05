import { createRequire } from "node:module"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

jest.mock("@monaco-editor/react", () => ({
  loader: { __getMonacoInstance: jest.fn(() => null) },
}))

import { loader } from "@monaco-editor/react"

import { Range, Selection, SelectionDirection } from "./monaco-editor-api"

const getMonacoInstance = (loader as unknown as { __getMonacoInstance: jest.Mock })
  .__getMonacoInstance

class FakeRange {
  constructor(
    public startLineNumber: number,
    public startColumn: number,
    public endLineNumber: number,
    public endColumn: number
  ) {}
}

class FakeSelection {
  static createWithDirection = jest.fn(
    (startLine: number, startCol: number, endLine: number, endCol: number, direction: number) => ({
      startLine,
      startCol,
      endLine,
      endCol,
      direction,
    })
  )
  constructor(
    public startLineNumber: number,
    public startColumn: number,
    public endLineNumber: number,
    public endColumn: number
  ) {}
}

const FAKE_MONACO = {
  Range: FakeRange,
  Selection: FakeSelection,
  SelectionDirection: { LTR: 0, RTL: 1 },
}

function installGlobalMonaco(instance: unknown) {
  ;(globalThis as { monaco?: unknown }).monaco = instance
}

beforeEach(() => {
  jest.clearAllMocks()
  getMonacoInstance.mockReturnValue(null)
  installGlobalMonaco(FAKE_MONACO)
})

afterEach(() => {
  delete (globalThis as { monaco?: unknown }).monaco
})

describe("monaco-editor api shim", () => {
  it("forwards `new Range(...)` to the runtime class", () => {
    const range = new Range(1, 2, 3, 4)
    expect(range).toBeInstanceOf(FakeRange)
    expect(range).toMatchObject({
      startLineNumber: 1,
      startColumn: 2,
      endLineNumber: 3,
      endColumn: 4,
    })
  })

  it("forwards `new Selection(...)` to the runtime class", () => {
    const selection = new Selection(5, 6, 7, 8)
    expect(selection).toBeInstanceOf(FakeSelection)
    expect(selection).toMatchObject({
      startLineNumber: 5,
      startColumn: 6,
      endLineNumber: 7,
      endColumn: 8,
    })
  })

  it("forwards the `Selection.createWithDirection` static y-monaco calls", () => {
    const result = Selection.createWithDirection(1, 1, 2, 2, 1)
    expect(FakeSelection.createWithDirection).toHaveBeenCalledWith(1, 1, 2, 2, 1)
    expect(result).toMatchObject({ direction: 1 })
  })

  it("reads SelectionDirection through to the runtime enum", () => {
    // Identity with the runtime values is the whole point: y-monaco compares
    // `selection.getDirection()` against `monaco.SelectionDirection.RTL`, and a
    // copied enum would only compare equal by luck.
    expect(SelectionDirection.RTL).toBe(FAKE_MONACO.SelectionDirection.RTL)
    expect(SelectionDirection.LTR).toBe(FAKE_MONACO.SelectionDirection.LTR)
    expect("RTL" in SelectionDirection).toBe(true)
    expect(Object.keys(SelectionDirection)).toEqual(["LTR", "RTL"])
  })

  it("prefers the loader's instance over the global", () => {
    // The loader holds the Monaco `@monaco-editor/react` handed to `onMount`,
    // which is the one every editor model belongs to.
    class LoaderRange extends FakeRange {}
    getMonacoInstance.mockReturnValue({ ...FAKE_MONACO, Range: LoaderRange })
    expect(new Range(1, 1, 1, 1)).toBeInstanceOf(LoaderRange)
  })

  it("falls back to globalThis.monaco when the loader holds nothing", () => {
    getMonacoInstance.mockReturnValue(null)
    expect(new Range(1, 1, 1, 1)).toBeInstanceOf(FakeRange)
  })

  it("throws a directing error when Monaco has not loaded yet", () => {
    getMonacoInstance.mockReturnValue(null)
    delete (globalThis as { monaco?: unknown }).monaco
    expect(() => new Range(1, 1, 1, 1)).toThrow(/before the runtime instance loaded/)
    expect(() => new Selection(1, 1, 1, 1)).toThrow(/before the runtime instance loaded/)
    expect(() => SelectionDirection.RTL).toThrow(/before the runtime instance loaded/)
  })
})

describe("y-monaco value-member contract", () => {
  // The shim only covers what y-monaco actually reads at runtime. If an upgrade
  // reaches for a fourth member, this fails here rather than as an undefined
  // constructor inside the canvas.
  const require_ = createRequire(__filename)

  function readYMonacoSource(): string | null {
    let manifest: string
    try {
      manifest = require_.resolve("y-monaco/package.json")
    } catch {
      return null
    }
    const source = path.join(path.dirname(manifest), "src", "y-monaco.js")
    return existsSync(source) ? readFileSync(source, "utf8") : null
  }

  it("covers every monaco member y-monaco uses as a value", () => {
    const source = readYMonacoSource()
    if (source === null) {
      // Slim CI images install without optional trees. Mirrors the same skip in
      // scripts/build/copy-monaco-assets.mjs.
      console.warn("[monaco-shim] y-monaco source not found, skipping contract check")
      return
    }
    // JSDoc comments name `monaco.editor.ITextModel` and friends, and those
    // erase at build time. Strip block comments before scanning so only real
    // value-level property reads survive.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "")
    const used = new Set(Array.from(code.matchAll(/\bmonaco\.(\w+)/g), (m) => m[1]))
    expect(used.size).toBeGreaterThan(0)
    expect([...used].sort()).toEqual(["Range", "Selection", "SelectionDirection"])
  })

  it("imports Monaco through the legacy specifier next.config.ts aliases", () => {
    const source = readYMonacoSource()
    if (source === null) return
    // If y-monaco ever moves to the post-`exports` path, the alias in
    // next.config.ts stops matching and this shim goes silently unused.
    expect(source).toContain("monaco-editor/esm/vs/editor/editor.api.js")
  })
})
