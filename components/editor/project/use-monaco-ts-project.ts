"use client"

// Feeds the workspace's script files to monaco-typescript's worker so
// cross-file imports and types resolve project-wide — the approximation
// VS Code gets from tsserver's project file table. Four parts:
//
//   1. compilerOptions — the worker ships with bare defaults (no --jsx,
//      classic module resolution), so JSX files error and extensionless
//      imports fail before any real checking can run.
//   2. models + eager sync — closed files get real Monaco models so the
//      diagnostics adapter validates them; `eagerModelSync` makes every
//      worker (re)spawn pull the full model set at once, because
//      `withSyncedResources` otherwise syncs only the one URI being
//      validated — a file diagnosed alone reports "Cannot find module"
//      for every sibling.
//   3. extra libs — resolution-only floor: files past the model caps,
//      plus a cross-worker copy. The TypeScript and JavaScript workers
//      each sync only models of their own language, so a `.ts` file
//      importing `./util.js` still fails unless a `.js` lib copy lands
//      in the TS worker (and vice versa; `.json` lands in both).
//   4. ambient modules — package.json dependencies get `declare module`
//      shims so bare imports (`react`, `zustand`) resolve instead of
//      erroring; there is no node_modules file table to do better until
//      a real language server exists.
//
// The fs watcher keeps the file table live: a create/write swaps the
// mirrored content, a delete (or a directory delete, matched by prefix)
// drops it. Own saves emit the same events — disk truth is exactly what
// the table should mirror, so no self-write grace applies here.

import { useEffect } from "react"

import { monacoLanguageFromPath } from "@/components/editor/editor-language"
import { loadConfiguredMonaco } from "@/lib/canvas/monaco-loader"
import {
  getModelRetainCount,
  releaseModel,
  retainModel,
} from "@/lib/editor-workbench/monaco-model-registry"
import { pathToFileUri } from "@/lib/files/path-uri"
import {
  readWorkspaceFile,
  walkWorkspace,
  type WorkspaceWalkOptions,
} from "@/lib/files/workspace-fs"
import { watchWorkspace } from "@/lib/files/workspace-watch"

import type { ProjectEditorDeps } from "./use-project-editor"
import type { ProjectQuickOpenDeps } from "./project-quick-open"

/** `.ts/.tsx/.js/.jsx` plus the `m`/`c` variants (`.d.*` fall out of `.ts`). */
const SCRIPT_FILE_RE = /\.(?:[cm]?[tj]s|[tj]sx)$/i

/** `*.json` — config files get real models so the JSON worker can validate them. */
const JSON_FILE_RE = /\.json$/i

/**
 * Beyond this many script files the extra-lib table stops being a
 * reasonable approximation (each lib is held in worker memory). The
 * single-model path still checks open files — the project view just
 * degrades back to it.
 */
const TS_PROJECT_LIB_CAP = 1_000

/**
 * How many workspace files get real Monaco models (and therefore real
 * markers in the Problems view). Models are heavier than extra libs —
 * one per file is the cost of project-wide diagnostics — so the cap
 * protects pathological checkouts; files beyond it fall back to
 * resolution-only extra libs.
 */
const TS_PROJECT_MODEL_CAP = 500

/** Files larger than this stay extra libs — a giant generated file is not worth a model. */
const TS_PROJECT_MODEL_BYTES = 512 * 1024

/** Same entry ceiling the quick-open index uses. */
const WALK_OPTIONS: WorkspaceWalkOptions = { maxEntries: 20_000 }

/** Reads batched so a big initial sync does not fire one transport call per file. */
const READ_BATCH = 16

/** URI for the generated ambient-module shim — synthetic, never a real path. */
const AMBIENT_MODULES_URI = "file:///__cognia__/ambient-modules.d.ts"

/**
 * URI for the "stamp" lib `scheduleRevalidate` bumps — see its comment.
 * Synthetic; the content is a no-op declaration.
 */
const REVALIDATE_LIB_URI = "file:///__cognia__/revalidate.d.ts"

interface ExtraLib {
  dispose(): void
}

interface TsDefaults {
  setCompilerOptions(options: Record<string, unknown>): void
  getDiagnosticsOptions(): Record<string, unknown>
  setDiagnosticsOptions(options: Record<string, unknown>): void
  addExtraLib(content: string, fileName?: string): ExtraLib
  /**
   * When true the WorkerManager eagerly syncs every model of this
   * language into a freshly spawned worker (`getEagerModelSync` in
   * `workerManager.js`). Absent on older monaco — keep optional.
   */
  setEagerModelSync?(value: boolean): void
}

/** The slice of `monaco.languages.typescript` this module drives. */
export interface MonacoTsNamespace {
  typescriptDefaults: TsDefaults
  javascriptDefaults: TsDefaults
  ScriptTarget: Record<string, number>
  ModuleKind: Record<string, number>
  ModuleResolutionKind: Record<string, number>
  JsxEmit: Record<string, number>
}

export function isTsProjectFile(relPath: string): boolean {
  return SCRIPT_FILE_RE.test(relPath)
}

/**
 * A bare `declare module "react";` resolves the import but types the whole
 * package as `any` — which then breaks real code: `interface Props extends
 * ButtonHTMLAttributes` collapses to just the declared members, so a valid
 * `onClick` prop reports "does not exist". The packages below get a minimal
 * typed surface instead; everything else keeps the `any` shorthand.
 */
const REACT_AMBIENT_BLOCK = `declare module "react" {
  export type ReactNode = any
  export type ReactElement = any
  export type FC<P = {}> = (props: P) => any
  export interface HTMLAttributes<T> { [prop: string]: any }
  export interface ButtonHTMLAttributes<T> extends HTMLAttributes<T> {}
  export interface InputHTMLAttributes<T> extends HTMLAttributes<T> {}
  export interface HTMLProps<T> extends HTMLAttributes<T> {}
  export const StrictMode: any
  export const Suspense: any
  export const Fragment: any
  export const Children: any
  export const version: string
  export function createElement(...args: any[]): any
  export function cloneElement(element: any, props?: any): any
  export function isValidElement(value: any): boolean
  export function createContext<T>(defaultValue: T): any
  export function useContext<T>(context: any): T
  export function useState<S>(initial: S | (() => S)): [S, (v: S | ((p: S) => S)) => void]
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
  export function useLayoutEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
  export function useMemo<T>(factory: () => T, deps?: readonly unknown[]): T
  export function useCallback<T extends (...args: any[]) => any>(fn: T, deps?: readonly unknown[]): T
  export function useRef<T>(initial: T): { current: T }
  export function useReducer<S, A>(reducer: (state: S, action: A) => S, initial: S): [S, (action: A) => void]
  export function useImperativeHandle(ref: any, init: () => any, deps?: readonly unknown[]): void
  export function useId(): string
  export function useTransition(): [boolean, (callback: () => void) => void]
  export function useDeferredValue<T>(value: T): T
  export function useSyncExternalStore<T>(subscribe: (onChange: () => void) => () => void, getSnapshot: () => T): T
  export function startTransition(callback: () => void): void
  export function memo<C>(component: C): C
  export function forwardRef<T, P>(render: (props: P, ref: T) => any): any
  export function lazy<T>(loader: () => Promise<{ default: T }>): T
  export class Component<P = {}, S = {}> {
    constructor(props: P)
    props: P
    state: S
    setState(partial: Partial<S>): void
    render(): any
  }
  export class PureComponent<P = {}, S = {}> extends Component<P, S> {}
  const React: any
  export default React
}
declare module "react/jsx-runtime" {
  export const jsx: any
  export const jsxs: any
  export const Fragment: any
}
declare module "react/jsx-dev-runtime" {
  export const jsxDEV: any
  export const Fragment: any
}
declare module "react-dom" {
  export function createPortal(children: any, container: any): any
  const ReactDOM: any
  export default ReactDOM
}
declare module "react-dom/client" {
  export function createRoot(container: Element | null): { render(node: any): void; unmount(): void }
}
declare namespace JSX {
  type Element = any
  interface IntrinsicElements { [elemName: string]: any }
  interface ElementChildrenAttribute { children: {} }
}`

const ZUSTAND_AMBIENT_BLOCK = `declare module "zustand" {
  export interface UseStore<T> {
    <R>(selector: (state: T) => R): R
    getState(): T
    setState(partial: Partial<T>): void
    subscribe(listener: (state: T) => void): () => void
  }
  export function create<T>(
    initializer: (
      set: (partial: Partial<T> | ((state: T) => Partial<T>)) => void,
      get: () => T,
      api: unknown
    ) => T
  ): UseStore<T>
}`

const TYPED_MODULE_SHIMS: Record<string, string> = {
  zustand: ZUSTAND_AMBIENT_BLOCK,
}

const isReactFamily = (name: string) =>
  name === "react" ||
  name === "react-dom" ||
  name.startsWith("react-dom/") ||
  name.startsWith("react/")

/** `declare module` lines — one per package.json dependency, typed where it matters. */
export function ambientModuleShim(packageNames: readonly string[]): string {
  const names = new Set(packageNames)
  const hasReact = [...names].some(isReactFamily)
  const parts: string[] = hasReact ? [REACT_AMBIENT_BLOCK] : []
  for (const name of names) {
    if (hasReact && isReactFamily(name)) continue
    parts.push(TYPED_MODULE_SHIMS[name] ?? `declare module ${JSON.stringify(name)};`)
  }
  return parts.join("\n")
}

export function packageNamesFromManifest(manifestJson: string): string[] {
  const parsed = JSON.parse(manifestJson) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  return [...Object.keys(parsed.dependencies ?? {}), ...Object.keys(parsed.devDependencies ?? {})]
}

/**
 * Compiler options for both script defaults. Idempotent — the defaults are
 * global to the Monaco instance, so re-entering (a second workbench, a
 * remount) writes the same object again rather than stacking.
 */
export function configureTsLanguageService(ts: MonacoTsNamespace): void {
  const compilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    // Bundler matches modern app code (extensionless, no package.json
    // "type" ceremony); NodeJs is the fallback on older monaco-typescript.
    moduleResolution: ts.ModuleResolutionKind.Bundler ?? ts.ModuleResolutionKind.NodeJs,
    jsx: ts.JsxEmit.ReactJSX,
    allowJs: true,
    // Extra libs carry `.ts`/`.tsx` filenames, not `.d.ts` — without this
    // the worker drops them from the file table entirely.
    allowNonTsExtensions: true,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    resolveJsonModule: true,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    lib: ["esnext", "dom", "dom.iterable"],
  }
  ts.typescriptDefaults.setCompilerOptions(compilerOptions)
  ts.javascriptDefaults.setCompilerOptions({ ...compilerOptions, checkJs: false })
  // Without eager sync a fresh worker only receives the single model it
  // is asked to validate (`withSyncedResources([uri])`), so that file
  // resolves against a one-file program and reports "Cannot find module"
  // for every sibling. Eager sync pulls the whole language's model set
  // at spawn — including each respawn after `setCompilerOptions` kills
  // the worker. The setter fires no change event, so this is safe to
  // repeat on every mount.
  ts.typescriptDefaults.setEagerModelSync?.(true)
  ts.javascriptDefaults.setEagerModelSync?.(true)
}

export interface MonacoTsProjectDeps {
  readFile: ProjectEditorDeps["readFile"]
  watch: ProjectEditorDeps["watch"]
  walk?: ProjectQuickOpenDeps["walk"]
}

// ── JSON language service ─────────────────────────────────────────────────
// monaco-json validates every JSON model on its own worker; what it lacks
// out of the box is schema associations. Inline schemas (rather than
// schemastore URLs) because the Tauri build must work fully offline — the
// `schemaRequest` fetch path has no network guarantee.

interface MonacoJsonDefaults {
  setDiagnosticsOptions(options: Record<string, unknown>): void
}

interface MonacoJsonNamespace {
  jsonDefaults: MonacoJsonDefaults
}

/** The compilerOptions surface VS Code ships in its bundled tsconfig schema (abridged). */
const TSCONFIG_SCHEMA = {
  type: "object",
  properties: {
    compilerOptions: {
      type: "object",
      properties: {
        target: {
          // tsc parses these case-insensitively — accept both the canonical
          // casing schemastore uses ("ES2022") and the lowercase shorthand.
          enum: [
            "es3",
            "es5",
            "es2015",
            "es2016",
            "es2017",
            "es2018",
            "es2019",
            "es2020",
            "es2021",
            "es2022",
            "es2023",
            "es2024",
            "esnext",
            "ES3",
            "ES5",
            "ES2015",
            "ES2016",
            "ES2017",
            "ES2018",
            "ES2019",
            "ES2020",
            "ES2021",
            "ES2022",
            "ES2023",
            "ES2024",
            "ESNext",
          ],
        },
        module: {
          enum: [
            "commonjs",
            "amd",
            "umd",
            "system",
            "es6",
            "es2015",
            "es2020",
            "es2022",
            "esnext",
            "node16",
            "node18",
            "nodenext",
            "preserve",
            "CommonJS",
            "AMD",
            "UMD",
            "System",
            "ES6",
            "ES2015",
            "ES2020",
            "ES2022",
            "ESNext",
            "Node16",
            "Node18",
            "NodeNext",
            "Preserve",
          ],
        },
        moduleResolution: {
          enum: [
            "classic",
            "node",
            "node10",
            "node16",
            "nodenext",
            "bundler",
            "Classic",
            "Node",
            "Node10",
            "Node16",
            "NodeNext",
            "Bundler",
          ],
        },
        lib: { type: "array", items: { type: "string" } },
        jsx: {
          enum: [
            "preserve",
            "react",
            "react-jsx",
            "react-jsxdev",
            "react-native",
            "Preserve",
            "React",
            "ReactJSX",
            "ReactJSXDev",
            "ReactNative",
          ],
        },
        strict: { type: "boolean" },
        noEmit: { type: "boolean" },
        skipLibCheck: { type: "boolean" },
        esModuleInterop: { type: "boolean" },
        allowSyntheticDefaultImports: { type: "boolean" },
        resolveJsonModule: { type: "boolean" },
        allowJs: { type: "boolean" },
        checkJs: { type: "boolean" },
        declaration: { type: "boolean" },
        outDir: { type: "string" },
        rootDir: { type: "string" },
        baseUrl: { type: "string" },
        paths: {
          type: "object",
          additionalProperties: { type: "array", items: { type: "string" } },
        },
        types: { type: "array", items: { type: "string" } },
      },
    },
    include: { type: "array", items: { type: "string" } },
    exclude: { type: "array", items: { type: "string" } },
    files: { type: "array", items: { type: "string" } },
    extends: { type: ["string", "array"], items: { type: "string" } },
    references: {
      type: "array",
      items: { type: "object", properties: { path: { type: "string" } } },
    },
  },
}

const PACKAGE_JSON_DEPS = { type: "object", additionalProperties: { type: "string" } }

const PACKAGE_JSON_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    version: { type: "string" },
    private: { type: "boolean" },
    description: { type: "string" },
    type: { enum: ["module", "commonjs"] },
    main: { type: "string" },
    module: { type: "string" },
    exports: true,
    scripts: { type: "object", additionalProperties: { type: "string" } },
    dependencies: PACKAGE_JSON_DEPS,
    devDependencies: PACKAGE_JSON_DEPS,
    peerDependencies: PACKAGE_JSON_DEPS,
    optionalDependencies: PACKAGE_JSON_DEPS,
    workspaces: {
      oneOf: [
        { type: "array", items: { type: "string" } },
        {
          type: "object",
          properties: { packages: { type: "array", items: { type: "string" } } },
        },
      ],
    },
    engines: PACKAGE_JSON_DEPS,
  },
}

/**
 * Wire the JSON worker's validation to the config files every project has.
 * Idempotent — `setDiagnosticsOptions` replaces, doesn't stack.
 */
export function configureJsonLanguageService(json: MonacoJsonNamespace): void {
  json.jsonDefaults.setDiagnosticsOptions({
    validate: true,
    // tsconfig.json is JSONC — comments and trailing commas are legal there,
    // and flagging them would be noise VS Code itself never raises.
    comments: "ignore",
    trailingCommas: "ignore",
    schemas: [
      {
        uri: "https://json.schemastore.org/tsconfig",
        fileMatch: ["tsconfig.json", "tsconfig.*.json", "*.tsconfig.json"],
        schema: TSCONFIG_SCHEMA,
      },
      {
        uri: "https://json.schemastore.org/package",
        fileMatch: ["package.json"],
        schema: PACKAGE_JSON_SCHEMA,
      },
    ],
  })
}

/** The `file://`-style URI object monaco hands models (only `.toString()` matters). */
interface MonacoModelUri {
  toString(): string
}

/** The slice of an `ITextModel` the project mirror needs. */
interface ProjectModel {
  getValue(): string
  setValue(value: string): void
  isDisposed(): boolean
}

/** The slice of `monaco.editor` used to build workspace models. */
interface MonacoProjectEditor {
  createModel(value: string, language: string, uri: MonacoModelUri): ProjectModel
  getModel(uri: MonacoModelUri): ProjectModel | null
}

/** The slice of the monaco namespace `syncMonacoTsProject` drives. */
export interface MonacoProjectApi {
  Uri: { parse(value: string): MonacoModelUri }
  editor: MonacoProjectEditor
}

/**
 * Keeps monaco-typescript's view of the workspace mirroring disk. Two
 * mirrors per file, chosen by size and count:
 *
 *   - a real **model** — the TS/JSON workers diagnose every model, so
 *     this is what makes the Problems view project-wide instead of
 *     "files you happened to open". The sync holds one retain per model
 *     in the registry; an editor opening the file adds its own hold, so
 *     closing the tab drops back to the workspace hold and the model —
 *     with its markers — survives.
 *   - an **extra lib** — resolution-only floor for script files that
 *     miss the model caps, and the whole mirror when no monaco editor
 *     API is available.
 *
 * A file an editor currently holds (retain count > 1) is never written
 * from disk events — its buffer is the authority; the open-file flow
 * already reconciles drafts vs disk. Returns a dispose that releases
 * every hold it took — models/libs added before this sync are left alone.
 */
export function syncMonacoTsProject(
  ts: MonacoTsNamespace,
  rootPath: string,
  deps: MonacoTsProjectDeps,
  monaco?: MonacoProjectApi
): { dispose(): void } {
  const walk = deps.walk ?? walkWorkspace
  const readFile = deps.readFile ?? readWorkspaceFile
  const watch = deps.watch ?? watchWorkspace

  let disposed = false
  // relPath → extra-lib handles + last synced disk content. A file can
  // hold libs in BOTH script workers (cross-worker resolution copies),
  // so each entry is a list.
  const libs = new Map<string, { handles: ExtraLib[]; content: string }>()
  // relPath → model + last disk content the sync itself wrote (editor-held
  // models keep their own truth; `content` just records what we last saw).
  const models = new Map<string, { model: ProjectModel; content: string }>()
  const ambientLibs: ExtraLib[] = []
  const stampLibs: ExtraLib[] = []

  const absFor = (relPath: string) => `${rootPath.replace(/\/+$/, "")}/${relPath}`
  const uriFor = (relPath: string) => pathToFileUri(absFor(relPath))
  const mirrorable = (relPath: string) => isTsProjectFile(relPath) || JSON_FILE_RE.test(relPath)

  /**
   * monaco-typescript re-diagnoses only the model that changed — a file
   * diagnosed before its import target existed keeps the stale "Cannot
   * find module" until its next edit. The adapter revalidates EVERY model
   * on `defaults.onDidExtraLibsChange`, so the trigger is a dedicated
   * no-op "stamp" lib whose content gets bumped. Do NOT use
   * `setDiagnosticsOptions`/`setCompilerOptions` for this: they fire
   * `onDidChange`, which the WorkerManager answers with `_stopWorker()`
   * — the respawned worker then revalidates against an incomplete file
   * table and rewrites the very errors we meant to clear. Debounced so
   * bursts (initial sync, branch switch) collapse into one pass.
   */
  let revalidateTimer: ReturnType<typeof setTimeout> | null = null
  let revalidateStamp = 0
  const scheduleRevalidate = () => {
    if (disposed) return
    if (revalidateTimer) clearTimeout(revalidateTimer)
    revalidateTimer = setTimeout(() => {
      revalidateTimer = null
      if (disposed) return
      revalidateStamp += 1
      const content = `// project revalidation pass ${revalidateStamp}\nexport {}`
      stampLibs[0] = ts.typescriptDefaults.addExtraLib(content, REVALIDATE_LIB_URI)
      stampLibs[1] = ts.javascriptDefaults.addExtraLib(content, REVALIDATE_LIB_URI)
    }, 400)
  }

  /**
   * Which script workers need an extra-lib copy of this file. The worker
   * owning the file's model already sees it (eager sync), so only the
   * OTHER script worker needs the lib — decided by the model's real
   * language, not the extension: `monacoLanguageFromPath` maps `.js` to
   * `typescript` (matching the editor) while `.jsx` is `javascript`.
   * `.json` models belong to neither script worker so they feed both.
   * Without a model (caps, no monaco API) every file needs both — the
   * lib is its only presence.
   */
  const libTargets = (relPath: string, mirrored: boolean): TsDefaults[] => {
    const all = [ts.typescriptDefaults, ts.javascriptDefaults]
    if (!mirrored || JSON_FILE_RE.test(relPath)) return all
    return monacoLanguageFromPath(relPath) === "javascript"
      ? [ts.typescriptDefaults]
      : [ts.javascriptDefaults]
  }

  const setLib = (relPath: string, content: string, mirrored: boolean) => {
    const prev = libs.get(relPath)
    if (prev?.content === content) return
    for (const handle of prev?.handles ?? []) handle.dispose()
    const uri = uriFor(relPath)
    libs.set(relPath, {
      handles: libTargets(relPath, mirrored).map((d) => d.addExtraLib(content, uri)),
      content,
    })
  }

  const dropLib = (relPath: string) => {
    const prev = libs.get(relPath)
    if (!prev) return
    for (const handle of prev.handles) handle.dispose()
    libs.delete(relPath)
  }

  /**
   * Release the sync's workspace hold. The registry disposes the model
   * only when no editor holds it — a buffer open on a deleted file keeps
   * its model (and markers) until closed, matching VS Code.
   */
  const dropModel = (relPath: string) => {
    if (!models.delete(relPath)) return
    releaseModel(uriFor(relPath))
    scheduleRevalidate()
  }

  const dropFile = (relPath: string) => {
    dropModel(relPath)
    dropLib(relPath)
  }

  const setFile = (relPath: string, content: string) => {
    let held = models.get(relPath)
    if (held && content.length > TS_PROJECT_MODEL_BYTES) {
      // Outgrew the cap — the model goes, lib-only floor remains.
      dropModel(relPath)
      held = undefined
    }
    if (held) {
      if (getModelRetainCount(uriFor(relPath)) <= 1 && held.content !== content) {
        held.model.setValue(content)
        held.content = content
        scheduleRevalidate()
      }
      // else: an editor owns this buffer — its draft is the authority.
    } else if (
      monaco &&
      mirrorable(relPath) &&
      models.size < TS_PROJECT_MODEL_CAP &&
      content.length <= TS_PROJECT_MODEL_BYTES
    ) {
      const uri = uriFor(relPath)
      const parsed = monaco.Uri.parse(uri)
      retainModel(uri)
      const existing = monaco.editor.getModel(parsed)
      models.set(relPath, {
        model:
          existing ?? monaco.editor.createModel(content, monacoLanguageFromPath(relPath), parsed),
        // An already-open model holds the editor's truth, not ours.
        content: existing ? existing.getValue() : content,
      })
      scheduleRevalidate()
      held = models.get(relPath)
    }
    if (isTsProjectFile(relPath) || JSON_FILE_RE.test(relPath)) {
      setLib(relPath, content, Boolean(held))
    }
  }

  /** Directory deletes arrive as the dir's own event — prefix-match children. */
  const dropUnder = (absPath: string) => {
    const prefix = `${absPath.replace(/\/+$/, "")}/`
    for (const rel of [...models.keys(), ...libs.keys()]) {
      const abs = absFor(rel)
      if (abs === absPath || abs.startsWith(prefix)) dropFile(rel)
    }
  }

  const syncOne = async (relPath: string) => {
    try {
      const content = await readFile(rootPath, relPath)
      if (!disposed) setFile(relPath, content)
    } catch {
      // Raced with a delete — the delete event's own handler drops the mirror.
    }
  }

  const refreshAmbient = async () => {
    let names: string[] = []
    try {
      names = packageNamesFromManifest(await readFile(rootPath, "package.json"))
    } catch {
      // No manifest or an invalid one — an empty shim is still correct.
    }
    const content = ambientModuleShim(names)
    if (disposed) return
    while (ambientLibs.length) ambientLibs.pop()?.dispose()
    // Bare-module shims resolve in both workers — a `.jsx` file importing
    // `react` needs them in the JS worker just as `.tsx` does in TS.
    if (content) {
      ambientLibs.push(
        ts.typescriptDefaults.addExtraLib(content, AMBIENT_MODULES_URI),
        ts.javascriptDefaults.addExtraLib(content, AMBIENT_MODULES_URI)
      )
    }
  }

  const syncAll = async () => {
    let result
    try {
      result = await walk(rootPath, WALK_OPTIONS)
    } catch {
      return
    }
    if (disposed) return
    const seen = new Set<string>()
    const files = result.entries
      .filter((e) => !e.isDir && mirrorable(e.relPath))
      .slice(0, TS_PROJECT_LIB_CAP)
    for (let i = 0; i < files.length; i += READ_BATCH) {
      await Promise.all(
        files.slice(i, i + READ_BATCH).map(async (entry) => {
          seen.add(entry.relPath)
          await syncOne(entry.relPath)
        })
      )
      if (disposed) return
    }
    for (const rel of [...models.keys(), ...libs.keys()]) {
      if (!seen.has(rel)) dropFile(rel)
    }
    // The initial mirror is complete — dependents diagnosed before their
    // imports existed get one converged pass.
    scheduleRevalidate()
  }

  void syncAll()
  void refreshAmbient()

  const disposeWatch = watch(rootPath, (change) => {
    const rel = change.path.startsWith(`${rootPath}/`)
      ? change.path.slice(rootPath.length + 1)
      : null
    if (change.kind === "delete") {
      dropUnder(change.path)
      if (rel === "package.json") void refreshAmbient()
      return
    }
    if (rel === null) return
    if (rel === "package.json") void refreshAmbient()
    if (mirrorable(rel)) void syncOne(rel)
  })

  return {
    dispose() {
      disposed = true
      if (revalidateTimer) clearTimeout(revalidateTimer)
      disposeWatch()
      for (const rel of [...models.keys()]) dropModel(rel)
      for (const { handles } of libs.values()) {
        for (const handle of handles) handle.dispose()
      }
      libs.clear()
      while (ambientLibs.length) ambientLibs.pop()?.dispose()
      while (stampLibs.length) stampLibs.pop()?.dispose()
    },
  }
}

interface UseMonacoTsProjectOptions {
  /**
   * Run the sync at all. Defaults to `true`. Hosts that render no Monaco
   * editor (the mobile layout edits through CodeMirror) pass `false`: the
   * sync would otherwise load Monaco, walk up to `TS_PROJECT_LIB_CAP` files
   * and build up to `TS_PROJECT_MODEL_CAP` models nobody reads. Flipping to
   * `false` disposes a running sync; flipping back starts a fresh one.
   */
  enabled?: boolean
}

/**
 * Mounts the workspace→worker sync for the active project root. Cheap on
 * the mock (a handful of files); on a real repo the gitignore-aware walk
 * keeps node_modules out and the cap bounds memory. A null `rootPath` or
 * `options.enabled === false` keeps it unmounted.
 */
export function useMonacoTsProject(
  rootPath: string | null,
  deps: MonacoTsProjectDeps,
  options: UseMonacoTsProjectOptions = {}
): void {
  const { readFile, watch, walk } = deps
  const enabled = options.enabled ?? true
  useEffect(() => {
    if (!rootPath || !enabled) return
    let sync: { dispose(): void } | null = null
    let cancelled = false
    void loadConfiguredMonaco().then((monaco) => {
      if (cancelled || !monaco) return
      const languages = (
        monaco as {
          languages?: { typescript?: MonacoTsNamespace; json?: MonacoJsonNamespace }
        }
      ).languages
      const ts = languages?.typescript
      if (ts?.typescriptDefaults) {
        configureTsLanguageService(ts)
        // The editor API surface is optional on the loaded namespace —
        // guard structurally so a monaco build without `editor.createModel`
        // falls back to the lib-only mirror rather than crashing.
        const api = monaco as {
          Uri?: MonacoProjectApi["Uri"]
          editor?: Partial<MonacoProjectApi["editor"]>
        }
        sync = syncMonacoTsProject(
          ts,
          rootPath,
          { readFile, watch, walk },
          api?.editor?.createModel && api?.Uri?.parse ? (api as MonacoProjectApi) : undefined
        )
      }
      if (languages?.json?.jsonDefaults) {
        configureJsonLanguageService(languages.json)
      }
    })
    return () => {
      cancelled = true
      sync?.dispose()
    }
  }, [rootPath, enabled, readFile, watch, walk])
}
