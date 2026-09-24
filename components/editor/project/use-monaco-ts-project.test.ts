/**
 * The workspace→worker sync that makes monaco-typescript behave like a
 * project instead of a single buffer: compiler options, extra-lib
 * registration, watch-driven updates, and the ambient module shim.
 */

import { act, renderHook } from "@testing-library/react"

import { loadConfiguredMonaco } from "@/lib/canvas/monaco-loader"
import type { WorkspaceFsChange } from "@/lib/files/workspace-watch"
import {
  bindMonacoModelRegistry,
  getModelRetainCount,
  resetMonacoModelRegistry,
  retainModel,
} from "@/lib/editor-workbench/monaco-model-registry"

import {
  ambientModuleShim,
  configureJsonLanguageService,
  configureTsLanguageService,
  isTsProjectFile,
  packageNamesFromManifest,
  syncMonacoTsProject,
  useMonacoTsProject,
  type MonacoProjectApi,
  type MonacoTsNamespace,
  type MonacoTsProjectDeps,
} from "./use-monaco-ts-project"

// The hook resolves Monaco through the configured loader; the pure sync
// tests never touch it. A bare jest.fn keeps the factory TDZ-safe.
jest.mock("@/lib/canvas/monaco-loader", () => ({ loadConfiguredMonaco: jest.fn() }))
const mockLoadConfiguredMonaco = jest.mocked(loadConfiguredMonaco)

const flush = () => new Promise<void>((r) => setTimeout(r, 0))

function makeTs() {
  // Each defaults gets its own lib table so tests can assert WHICH
  // worker a copy lands in (cross-worker copies differ per family).
  const tsLibs = new Map<string, { content: string; version: number }>()
  const jsLibs = new Map<string, { content: string; version: number }>()
  let version = 0
  const makeDefaults = (table: Map<string, { content: string; version: number }>) => ({
    compilerOptions: null as Record<string, unknown> | null,
    diagnosticsOptions: {} as Record<string, unknown>,
    eagerSync: false,
    setCompilerOptions(options: Record<string, unknown>) {
      this.compilerOptions = options
    },
    getDiagnosticsOptions() {
      return this.diagnosticsOptions
    },
    setDiagnosticsOptions: jest.fn(function (
      this: { diagnosticsOptions: Record<string, unknown> },
      options: Record<string, unknown>
    ) {
      this.diagnosticsOptions = options
    }),
    setEagerModelSync: jest.fn(function (this: { eagerSync: boolean }, value: boolean) {
      this.eagerSync = value
    }),
    addExtraLib: jest.fn((content: string, fileName = "lib.d.ts") => {
      table.set(fileName, { content, version: ++version })
      return {
        dispose: jest.fn(() => {
          table.delete(fileName)
        }),
      }
    }),
  })
  const ts: MonacoTsNamespace & {
    typescriptDefaults: ReturnType<typeof makeDefaults>
    javascriptDefaults: ReturnType<typeof makeDefaults>
  } = {
    typescriptDefaults: makeDefaults(tsLibs),
    javascriptDefaults: makeDefaults(jsLibs),
    ScriptTarget: { ESNext: 99 },
    ModuleKind: { ESNext: 99 },
    ModuleResolutionKind: { Bundler: 100, NodeJs: 2 },
    JsxEmit: { ReactJSX: 5 },
  }
  return { ts, tsLibs, jsLibs }
}

function makeDeps(over: Partial<MonacoTsProjectDeps> = {}) {
  const watchers: Array<(change: WorkspaceFsChange) => void> = []
  const files = new Map<string, string>([
    ["src/a.ts", "export const a = 1"],
    ["src/b.tsx", "export const B = () => <div/>"],
    ["package.json", '{"dependencies":{"react":"*"},"devDependencies":{"zustand":"*"}}'],
  ])
  const deps: MonacoTsProjectDeps = {
    walk: jest.fn(async () => ({
      entries: [
        { relPath: "src", absolutePath: "/repo/src", isDir: true, size: 0, mtimeMs: null },
        ...[...files.keys()].map((relPath) => ({
          relPath,
          absolutePath: `/repo/${relPath}`,
          isDir: false,
          size: files.get(relPath)!.length,
          mtimeMs: 0,
        })),
        { relPath: "doc.md", absolutePath: "/repo/doc.md", isDir: false, size: 3, mtimeMs: 0 },
      ],
      truncated: false,
      skippedSensitive: 0,
    })),
    readFile: jest.fn(async (_root: string, relPath: string) => {
      const content = files.get(relPath)
      if (content === undefined) throw new Error(`ENOENT: ${relPath}`)
      return content
    }),
    watch: jest.fn((_root: string, cb: (change: WorkspaceFsChange) => void) => {
      watchers.push(cb)
      return () => watchers.splice(watchers.indexOf(cb), 1)
    }),
    ...over,
  }
  return { deps, files, watchers }
}

describe("isTsProjectFile", () => {
  it("matches script extensions including .d.ts and m/c variants", () => {
    for (const ok of [
      "a.ts",
      "b.tsx",
      "c.js",
      "d.jsx",
      "e.mts",
      "f.mjs",
      "g.cts",
      "h.cjs",
      "i.d.ts",
    ]) {
      expect(isTsProjectFile(ok)).toBe(true)
    }
    for (const no of ["a.md", "b.json", "c.css", "d.map", "e.tsx.snap.png"]) {
      expect(isTsProjectFile(no)).toBe(false)
    }
  })
})

describe("configureTsLanguageService", () => {
  it("enables JSX, bundler resolution and strict checking on both defaults", () => {
    const { ts } = makeTs()
    configureTsLanguageService(ts)
    expect(ts.typescriptDefaults.compilerOptions).toEqual(
      expect.objectContaining({ jsx: 5, moduleResolution: 100, strict: true })
    )
    // JS files keep the same project view without checkJs noise.
    expect(ts.javascriptDefaults.compilerOptions).toEqual(
      expect.objectContaining({ jsx: 5, checkJs: false })
    )
    expect(
      (ts.typescriptDefaults.compilerOptions as { allowNonTsExtensions: boolean })
        .allowNonTsExtensions
    ).toBe(true)
  })

  it("enables eager model sync so spawned workers pull the full model set", () => {
    const { ts } = makeTs()
    configureTsLanguageService(ts)
    // The WorkerManager syncs only the validated URI without this —
    // single-file programs are what "Cannot find module './x'" storms
    // look like. Both workers need it.
    expect(ts.typescriptDefaults.setEagerModelSync).toHaveBeenCalledWith(true)
    expect(ts.javascriptDefaults.setEagerModelSync).toHaveBeenCalledWith(true)
  })
})

describe("configureJsonLanguageService", () => {
  type JsonSchemaEntry = {
    uri: string
    fileMatch: string[]
    schema: {
      type: string
      properties: Record<string, { type?: unknown; enum?: string[]; properties?: unknown }>
    }
  }
  type JsonDiagnostics = {
    validate: boolean
    comments: string
    trailingCommas: string
    schemas: JsonSchemaEntry[]
  }

  const configure = () => {
    const setDiagnosticsOptions = jest.fn()
    configureJsonLanguageService({ jsonDefaults: { setDiagnosticsOptions } })
    expect(setDiagnosticsOptions).toHaveBeenCalledTimes(1)
    return {
      setDiagnosticsOptions,
      options: setDiagnosticsOptions.mock.calls[0][0] as JsonDiagnostics,
    }
  }

  it("turns validation on and tolerates JSONC comments and trailing commas", () => {
    const { options } = configure()
    expect(options.validate).toBe(true)
    // tsconfig.json is JSONC — flagging comments/trailing commas is noise.
    expect(options.comments).toBe("ignore")
    expect(options.trailingCommas).toBe("ignore")
  })

  it("associates an inline tsconfig schema with every tsconfig file shape", () => {
    const { options } = configure()
    const tsconfig = options.schemas.find((s) => s.fileMatch.includes("tsconfig.json"))
    expect(tsconfig).toBeDefined()
    expect(tsconfig!.uri).toBe("https://json.schemastore.org/tsconfig")
    expect(tsconfig!.fileMatch).toEqual(["tsconfig.json", "tsconfig.*.json", "*.tsconfig.json"])
    // Inline, not a remote `$ref` — the Tauri build must validate offline.
    expect(tsconfig!.schema.type).toBe("object")
    const compilerOptions = tsconfig!.schema.properties.compilerOptions as {
      properties: Record<string, { enum?: string[]; type?: unknown }>
    }
    // tsc reads these enums case-insensitively — both casings validate.
    expect(compilerOptions.properties.target.enum).toEqual(
      expect.arrayContaining(["ESNext", "esnext", "ES2022", "es2022"])
    )
    expect(compilerOptions.properties.moduleResolution.enum).toEqual(
      expect.arrayContaining(["bundler", "Bundler", "NodeNext"])
    )
    expect(compilerOptions.properties.jsx.enum).toEqual(
      expect.arrayContaining(["react-jsx", "ReactJSX", "preserve"])
    )
    expect(compilerOptions.properties.strict.type).toBe("boolean")
    expect(tsconfig!.schema.properties).toEqual(
      expect.objectContaining({ include: expect.anything(), extends: expect.anything() })
    )
  })

  it("associates an inline package.json schema", () => {
    const { options } = configure()
    const pkg = options.schemas.find((s) => s.fileMatch.includes("package.json"))
    expect(pkg).toBeDefined()
    expect(pkg!.uri).toBe("https://json.schemastore.org/package")
    expect(pkg!.fileMatch).toEqual(["package.json"])
    expect(pkg!.schema.properties.type.enum).toEqual(["module", "commonjs"])
    // Dependency maps are name → version-string objects.
    expect(pkg!.schema.properties.dependencies).toEqual({
      type: "object",
      additionalProperties: { type: "string" },
    })
    expect(pkg!.schema.properties.devDependencies).toBe(pkg!.schema.properties.dependencies)
    expect(options.schemas).toHaveLength(2)
  })

  it("is idempotent — a second call replaces with the same options instead of stacking", () => {
    const setDiagnosticsOptions = jest.fn()
    const json = { jsonDefaults: { setDiagnosticsOptions } }
    configureJsonLanguageService(json)
    configureJsonLanguageService(json)
    expect(setDiagnosticsOptions).toHaveBeenCalledTimes(2)
    expect(setDiagnosticsOptions.mock.calls[1][0]).toEqual(setDiagnosticsOptions.mock.calls[0][0])
    expect((setDiagnosticsOptions.mock.calls[1][0] as JsonDiagnostics).schemas).toHaveLength(2)
  })
})

describe("packageNamesFromManifest / ambientModuleShim", () => {
  it("reads deps + devDeps and emits declare-module lines", () => {
    const names = packageNamesFromManifest(
      '{"dependencies":{"lodash-es":"*"},"devDependencies":{"vitest":"*"},"other":1}'
    )
    expect(names).toEqual(["lodash-es", "vitest"])
    expect(ambientModuleShim(names)).toBe('declare module "lodash-es";\ndeclare module "vitest";')
  })

  it("emits the typed react surface (with the JSX namespace) for react-family deps", () => {
    const shim = ambientModuleShim(["react", "react-dom", "lodash-es"])
    // A typed `interface` shim — a bare `declare module "react";` would type
    // the package as `any` and break `extends ButtonHTMLAttributes` code.
    expect(shim).toContain('declare module "react" {')
    expect(shim).toContain("ButtonHTMLAttributes")
    expect(shim).toContain("declare namespace JSX")
    expect(shim).toContain('declare module "react/jsx-runtime"')
    // The family is emitted once — no bare duplicates alongside the block.
    expect(shim).not.toContain('declare module "react-dom";')
    expect(shim).toContain('declare module "lodash-es";')
  })

  it("emits the typed zustand surface so store selectors stay typed", () => {
    const shim = ambientModuleShim(["zustand"])
    expect(shim).toContain("UseStore<T>")
    expect(shim).not.toBe('declare module "zustand";')
  })
})

describe("syncMonacoTsProject", () => {
  it("registers every script file as an extra lib in both workers under its model URI", async () => {
    const { ts, tsLibs, jsLibs } = makeTs()
    const { deps } = makeDeps()
    // No monaco API → lib-only mirror → both workers get every file.
    syncMonacoTsProject(ts, "/repo", deps)
    await flush()
    await flush()

    expect(tsLibs.get("file:///repo/src/a.ts")?.content).toBe("export const a = 1")
    expect(jsLibs.get("file:///repo/src/a.ts")?.content).toBe("export const a = 1")
    expect(tsLibs.get("file:///repo/src/b.tsx")?.content).toContain("<div/>")
    // Non-script files never reach the table.
    expect(tsLibs.has("file:///repo/doc.md")).toBe(false)
    expect(jsLibs.has("file:///repo/doc.md")).toBe(false)
    // The ambient shim covers package.json deps — react/zustand get the
    // typed surfaces, not the `any` shorthand — in BOTH workers so `.jsx`
    // files resolve bare imports too.
    const ambient = [...tsLibs.entries()].find(([uri]) => uri.includes("ambient-modules"))
    expect(ambient?.[1].content).toContain('declare module "react" {')
    expect(ambient?.[1].content).toContain("UseStore<T>")
    expect([...jsLibs.keys()].some((uri) => uri.includes("ambient-modules"))).toBe(true)
  })

  it("updates a lib on modify and drops it on delete", async () => {
    const { ts, tsLibs, jsLibs } = makeTs()
    const { deps, files, watchers } = makeDeps()
    syncMonacoTsProject(ts, "/repo", deps)
    await flush()
    await flush()

    files.set("src/a.ts", "export const a = 2")
    watchers[0]({ kind: "modify", path: "/repo/src/a.ts" })
    await flush()
    expect(tsLibs.get("file:///repo/src/a.ts")?.content).toBe("export const a = 2")
    expect(jsLibs.get("file:///repo/src/a.ts")?.content).toBe("export const a = 2")

    files.delete("src/a.ts")
    watchers[0]({ kind: "delete", path: "/repo/src/a.ts" })
    expect(tsLibs.has("file:///repo/src/a.ts")).toBe(false)
    expect(jsLibs.has("file:///repo/src/a.ts")).toBe(false)
  })

  it("a directory delete drops every lib beneath it", async () => {
    const { ts, tsLibs, jsLibs } = makeTs()
    const { deps, watchers } = makeDeps()
    syncMonacoTsProject(ts, "/repo", deps)
    await flush()
    await flush()

    watchers[0]({ kind: "delete", path: "/repo/src" })
    expect(tsLibs.has("file:///repo/src/a.ts")).toBe(false)
    expect(jsLibs.has("file:///repo/src/b.tsx")).toBe(false)
  })

  it("a new file registers on its create event", async () => {
    const { ts, tsLibs } = makeTs()
    const { deps, files, watchers } = makeDeps()
    syncMonacoTsProject(ts, "/repo", deps)
    await flush()
    await flush()

    files.set("src/new.ts", "export const n = 0")
    watchers[0]({ kind: "create", path: "/repo/src/new.ts" })
    await flush()
    expect(tsLibs.get("file:///repo/src/new.ts")?.content).toBe("export const n = 0")
  })

  it("re-reads the manifest when package.json changes", async () => {
    const { ts, tsLibs } = makeTs()
    const { deps, files, watchers } = makeDeps()
    syncMonacoTsProject(ts, "/repo", deps)
    await flush()
    await flush()

    files.set("package.json", '{"dependencies":{"solid-js":"*"}}')
    watchers[0]({ kind: "modify", path: "/repo/package.json" })
    await flush()
    const ambient = [...tsLibs.entries()].find(([uri]) => uri.includes("ambient-modules"))
    expect(ambient?.[1].content).toBe('declare module "solid-js";')
  })

  it("dispose unregisters everything it added", async () => {
    const { ts, tsLibs, jsLibs } = makeTs()
    const { deps } = makeDeps()
    const sync = syncMonacoTsProject(ts, "/repo", deps)
    await flush()
    await flush()
    expect(tsLibs.size).toBeGreaterThan(0)
    expect(jsLibs.size).toBeGreaterThan(0)

    sync.dispose()
    expect(tsLibs.size).toBe(0)
    expect(jsLibs.size).toBe(0)
  })

  it("a raced delete during the initial sync leaves no lib behind", async () => {
    const { ts, tsLibs } = makeTs()
    const { deps, files, watchers } = makeDeps()
    // Delete mid-flight: walk already listed the file, the read now fails.
    deps.readFile = jest.fn(async (_root: string, relPath: string) => {
      if (relPath === "src/a.ts") {
        files.delete("src/a.ts")
        watchers[0]?.({ kind: "delete", path: "/repo/src/a.ts" })
        throw new Error("ENOENT")
      }
      return files.get(relPath)!
    })
    syncMonacoTsProject(ts, "/repo", deps)
    await flush()
    await flush()
    expect(tsLibs.has("file:///repo/src/a.ts")).toBe(false)
    expect(tsLibs.has("file:///repo/src/b.tsx")).toBe(true)
  })
})

// ── Model-backed project mirror ─────────────────────────────────────────
// With a real `monaco` the sync mirrors workspace files as *models*, not
// extra libs: the TS/JSON workers diagnose every model, which is what
// makes the Problems view project-wide. Each model gets one workspace
// hold in the registry; an editor adds its own while the file is open.

interface FakeModel {
  value: string
  language: string
  disposed: boolean
  getValue(): string
  setValue(v: string): void
  isDisposed(): boolean
  dispose(): void
}

function makeMonaco() {
  const models = new Map<string, FakeModel>()
  const api = {
    Uri: { parse: (v: string) => ({ toString: () => v }) },
    editor: {
      createModel: jest.fn(
        (value: string, language: string, uri: { toString(): string }): FakeModel => {
          const model: FakeModel = {
            value,
            language,
            disposed: false,
            getValue() {
              return this.value
            },
            setValue(v: string) {
              this.value = v
            },
            isDisposed() {
              return this.disposed
            },
            dispose() {
              this.disposed = true
              models.delete(uri.toString())
            },
          }
          models.set(uri.toString(), model)
          return model
        }
      ),
      getModel: (uri: { toString(): string }) => models.get(uri.toString()) ?? null,
    },
  }
  return { api: api as unknown as MonacoProjectApi, models }
}

describe("syncMonacoTsProject — model-backed mirror", () => {
  afterEach(() => resetMonacoModelRegistry())

  it("mirrors script and JSON files as models plus cross-worker lib copies", async () => {
    const { ts, tsLibs, jsLibs } = makeTs()
    const { api, models } = makeMonaco()
    const { deps } = makeDeps()
    syncMonacoTsProject(ts, "/repo", deps, api)
    await flush()
    await flush()

    expect(models.get("file:///repo/src/a.ts")?.language).toBe("typescript")
    expect(models.get("file:///repo/src/b.tsx")?.language).toBe("typescript")
    // Config JSONs are models too — the JSON worker validates them
    // project-wide, not only once opened.
    expect(models.get("file:///repo/package.json")?.language).toBe("json")
    // Non-mirrorable files never reach either channel.
    expect(models.has("file:///repo/doc.md")).toBe(false)
    // The TS worker sees its own files via models — only the JSON file
    // (whose model belongs to the json worker) and the ambient shim ride
    // the TS extra-lib table.
    expect([...tsLibs.keys()].sort()).toEqual(expect.arrayContaining(["file:///repo/package.json"]))
    expect(
      [...tsLibs.keys()].every((u) => u.includes("package.json") || u.includes("__cognia__"))
    ).toBe(true)
    // The JS worker needs lib copies of every non-JS file: its eager sync
    // only pulls javascript-language models.
    expect(jsLibs.has("file:///repo/src/a.ts")).toBe(true)
    expect(jsLibs.has("file:///repo/src/b.tsx")).toBe(true)
    expect(jsLibs.has("file:///repo/package.json")).toBe(true)
    // The sync holds one workspace retain per model.
    expect(getModelRetainCount("file:///repo/src/a.ts")).toBe(1)
  })

  it("a .jsx mirror feeds the TS worker as a lib while its model stays javascript", async () => {
    const { ts, tsLibs, jsLibs } = makeTs()
    const { api, models } = makeMonaco()
    const { deps, files, watchers } = makeDeps()
    syncMonacoTsProject(ts, "/repo", deps, api)
    await flush()
    await flush()

    files.set("src/widget.jsx", "export const W = () => <div/>")
    watchers[0]({ kind: "create", path: "/repo/src/widget.jsx" })
    await flush()
    // `.jsx` models as `javascript` → validates in the JS worker; the TS
    // worker resolves `import "./widget.jsx"` via the extra-lib copy.
    // (.js files map to `typescript` by the editor's own convention —
    // they sync to the TS worker directly.)
    expect(models.get("file:///repo/src/widget.jsx")?.language).toBe("javascript")
    expect(tsLibs.get("file:///repo/src/widget.jsx")?.content).toContain("<div/>")
    expect(jsLibs.has("file:///repo/src/widget.jsx")).toBe(false)
  })

  it("a .js mirror models as typescript and copies to the JS worker", async () => {
    const { ts, tsLibs, jsLibs } = makeTs()
    const { api, models } = makeMonaco()
    const { deps, files, watchers } = makeDeps()
    syncMonacoTsProject(ts, "/repo", deps, api)
    await flush()
    await flush()

    files.set("src/util.js", "export const u = 1")
    watchers[0]({ kind: "create", path: "/repo/src/util.js" })
    await flush()
    // `monacoLanguageFromPath` treats .js as typescript — the model joins
    // the TS program; a `.jsx` importer resolves it via the JS copy.
    expect(models.get("file:///repo/src/util.js")?.language).toBe("typescript")
    expect(jsLibs.get("file:///repo/src/util.js")?.content).toBe("export const u = 1")
    expect(tsLibs.has("file:///repo/src/util.js")).toBe(false)
  })

  it("writes disk updates into the model via setValue", async () => {
    const { ts } = makeTs()
    const { api, models } = makeMonaco()
    const { deps, files, watchers } = makeDeps()
    syncMonacoTsProject(ts, "/repo", deps, api)
    await flush()
    await flush()

    files.set("src/a.ts", "export const a = 2")
    watchers[0]({ kind: "modify", path: "/repo/src/a.ts" })
    await flush()
    expect(models.get("file:///repo/src/a.ts")?.value).toBe("export const a = 2")
  })

  it("a delete releases the workspace hold and the model dies", async () => {
    const { ts } = makeTs()
    const { api, models } = makeMonaco()
    bindMonacoModelRegistry(api as never)
    const { deps, files, watchers } = makeDeps()
    syncMonacoTsProject(ts, "/repo", deps, api)
    await flush()
    await flush()

    files.delete("src/a.ts")
    watchers[0]({ kind: "delete", path: "/repo/src/a.ts" })
    expect(models.has("file:///repo/src/a.ts")).toBe(false)
    expect(getModelRetainCount("file:///repo/src/a.ts")).toBe(0)
  })

  it("an editor-held buffer wins disk events and survives the file's delete", async () => {
    const { ts, jsLibs } = makeTs()
    const { api, models } = makeMonaco()
    bindMonacoModelRegistry(api as never)
    const { deps, files, watchers } = makeDeps()
    syncMonacoTsProject(ts, "/repo", deps, api)
    await flush()
    await flush()

    // The editor opens the file — a second retain on the same URI.
    retainModel("file:///repo/src/a.ts")
    files.set("src/a.ts", "export const a = 99")
    watchers[0]({ kind: "modify", path: "/repo/src/a.ts" })
    await flush()
    // The open buffer's content is authoritative — disk writes don't clobber.
    expect(models.get("file:///repo/src/a.ts")?.value).toBe("export const a = 1")
    // …but the cross-worker lib still tracks the disk floor.
    expect(jsLibs.get("file:///repo/src/a.ts")?.content).toBe("export const a = 99")

    files.delete("src/a.ts")
    watchers[0]({ kind: "delete", path: "/repo/src/a.ts" })
    // Sync drops its hold (2→1); the editor's buffer keeps model + markers.
    expect(models.has("file:///repo/src/a.ts")).toBe(true)
    expect(getModelRetainCount("file:///repo/src/a.ts")).toBe(1)
  })

  it("adopts an already-open model instead of clobbering it", async () => {
    const { ts } = makeTs()
    const { api, models } = makeMonaco()
    const { deps } = makeDeps()
    // The editor modelled the file first, with an unsaved draft.
    const draft = api.editor.createModel(
      "export const a = 'draft'",
      "typescript",
      api.Uri.parse("file:///repo/src/a.ts")
    )
    syncMonacoTsProject(ts, "/repo", deps, api)
    await flush()
    await flush()

    expect(models.get("file:///repo/src/a.ts")).toBe(draft)
    expect(draft.getValue()).toBe("export const a = 'draft'")
    // Other files still get models — but src/a.ts was adopted, not recreated.
    const calls = (api.editor.createModel as jest.Mock).mock.calls
    expect(calls.filter(([, , uri]) => uri.toString() === "file:///repo/src/a.ts")).toHaveLength(1)
  })

  it("files beyond the byte cap stay resolution-only extra libs in both workers", async () => {
    const { ts, tsLibs, jsLibs } = makeTs()
    const { api, models } = makeMonaco()
    const { deps, files, watchers } = makeDeps()
    syncMonacoTsProject(ts, "/repo", deps, api)
    await flush()
    await flush()

    files.set("src/huge.ts", `export const s = "${"x".repeat(600 * 1024)}"`)
    watchers[0]({ kind: "create", path: "/repo/src/huge.ts" })
    await flush()
    expect(models.has("file:///repo/src/huge.ts")).toBe(false)
    // No model → the lib is the file's only presence in EITHER worker.
    expect(tsLibs.has("file:///repo/src/huge.ts")).toBe(true)
    expect(jsLibs.has("file:///repo/src/huge.ts")).toBe(true)
  })

  it("dispose releases every workspace hold", async () => {
    const { ts } = makeTs()
    const { api, models } = makeMonaco()
    bindMonacoModelRegistry(api as never)
    const { deps } = makeDeps()
    const sync = syncMonacoTsProject(ts, "/repo", deps, api)
    await flush()
    await flush()
    expect(models.size).toBeGreaterThan(0)

    sync.dispose()
    expect(getModelRetainCount("file:///repo/src/a.ts")).toBe(0)
    expect(getModelRetainCount("file:///repo/package.json")).toBe(0)
    expect(models.size).toBe(0)
  })

  it("fires one debounced project revalidation after the mirror settles", async () => {
    const { ts, tsLibs, jsLibs } = makeTs()
    const { api } = makeMonaco()
    const { deps, files, watchers } = makeDeps()
    syncMonacoTsProject(ts, "/repo", deps, api)
    await flush()
    await flush()

    // Model churn inside the debounce window collapses into one pass.
    files.set("src/new.ts", "export const n = 0")
    watchers[0]({ kind: "create", path: "/repo/src/new.ts" })
    await flush()

    await new Promise((r) => setTimeout(r, 500))
    // The revalidation trigger is a no-op "stamp" extra lib: bumping its
    // content fires onDidExtraLibsChange → the adapter re-validates every
    // model so imports that resolved after a dependent was diagnosed stop
    // being stale. Both workers get stamped.
    const stamp = "file:///__cognia__/revalidate.d.ts"
    expect(tsLibs.get(stamp)?.content).toContain("revalidation pass")
    expect(jsLibs.get(stamp)?.content).toContain("revalidation pass")
    // …and crucially NOT setDiagnosticsOptions — onDidChange makes the
    // WorkerManager kill the worker, so the next validation would run
    // against an incomplete file table and rewrite the same errors.
    expect(ts.typescriptDefaults.setDiagnosticsOptions).not.toHaveBeenCalled()
    expect(ts.javascriptDefaults.setDiagnosticsOptions).not.toHaveBeenCalled()
  })
})

describe("useMonacoTsProject", () => {
  // A loaded Monaco with the TS and JSON language namespaces but no editor
  // model API — the hook falls back to the lib-only mirror, which is enough
  // to observe whether a sync is running.
  const makeLoadedMonaco = () => {
    const { ts, tsLibs, jsLibs } = makeTs()
    const jsonDefaults = { setDiagnosticsOptions: jest.fn() }
    const monaco = { languages: { typescript: ts, json: { jsonDefaults } } }
    mockLoadConfiguredMonaco.mockResolvedValue(monaco as never)
    return { ts, tsLibs, jsLibs, jsonDefaults }
  }

  const settle = async () => {
    await act(async () => {
      await flush()
      await flush()
      await flush()
    })
  }

  afterEach(() => {
    mockLoadConfiguredMonaco.mockReset()
  })

  it("syncs by default: configures both language services and mirrors the workspace", async () => {
    const { ts, tsLibs, jsonDefaults } = makeLoadedMonaco()
    const { deps, watchers } = makeDeps()
    const { unmount } = renderHook(() => useMonacoTsProject("/repo", deps))
    await settle()

    expect(mockLoadConfiguredMonaco).toHaveBeenCalledTimes(1)
    expect(ts.typescriptDefaults.compilerOptions).toEqual(expect.objectContaining({ jsx: 5 }))
    expect(jsonDefaults.setDiagnosticsOptions).toHaveBeenCalledTimes(1)
    expect(tsLibs.get("file:///repo/src/a.ts")?.content).toBe("export const a = 1")
    expect(watchers).toHaveLength(1)

    unmount()
    expect(tsLibs.size).toBe(0)
    expect(watchers).toHaveLength(0)
  })

  it("does nothing while disabled — Monaco is never loaded and the disk is never walked", async () => {
    makeLoadedMonaco()
    const { deps } = makeDeps()
    renderHook(() => useMonacoTsProject("/repo", deps, { enabled: false }))
    await settle()

    expect(mockLoadConfiguredMonaco).not.toHaveBeenCalled()
    expect(deps.walk).not.toHaveBeenCalled()
    expect(deps.readFile).not.toHaveBeenCalled()
    expect(deps.watch).not.toHaveBeenCalled()
  })

  it("does nothing without a root", async () => {
    makeLoadedMonaco()
    const { deps } = makeDeps()
    renderHook(() => useMonacoTsProject(null, deps))
    await settle()
    expect(mockLoadConfiguredMonaco).not.toHaveBeenCalled()
  })

  it("disposes the running sync when enabled flips to false, and restarts on true", async () => {
    const { tsLibs, jsLibs } = makeLoadedMonaco()
    const { deps, watchers } = makeDeps()
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useMonacoTsProject("/repo", deps, { enabled }),
      { initialProps: { enabled: true } }
    )
    await settle()
    expect(tsLibs.size).toBeGreaterThan(0)
    expect(watchers).toHaveLength(1)

    rerender({ enabled: false })
    // Every lib (files, ambient shim) and the watcher go with the sync.
    expect(tsLibs.size).toBe(0)
    expect(jsLibs.size).toBe(0)
    expect(watchers).toHaveLength(0)
    await settle()
    expect(mockLoadConfiguredMonaco).toHaveBeenCalledTimes(1)

    rerender({ enabled: true })
    await settle()
    expect(mockLoadConfiguredMonaco).toHaveBeenCalledTimes(2)
    expect(tsLibs.get("file:///repo/src/a.ts")?.content).toBe("export const a = 1")
    expect(watchers).toHaveLength(1)
  })

  it("never starts a sync when disabled before Monaco finishes loading", async () => {
    let resolveMonaco: (value: unknown) => void = () => {}
    const { ts, tsLibs } = makeTs()
    mockLoadConfiguredMonaco.mockReturnValue(
      new Promise((resolve) => {
        resolveMonaco = resolve
      }) as never
    )
    const { deps } = makeDeps()
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useMonacoTsProject("/repo", deps, { enabled }),
      { initialProps: { enabled: true } }
    )
    rerender({ enabled: false })
    await act(async () => {
      resolveMonaco({ languages: { typescript: ts } })
    })
    await settle()

    expect(deps.walk).not.toHaveBeenCalled()
    expect(deps.watch).not.toHaveBeenCalled()
    expect(tsLibs.size).toBe(0)
    expect(ts.typescriptDefaults.compilerOptions).toBeNull()
  })
})
