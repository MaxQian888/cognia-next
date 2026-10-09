"use client"

/**
 * Monaco loader configuration. By default `@monaco-editor/react` pulls
 * monaco from a CDN (jsdelivr) which is fine for browser-mode dev,
 * but the Tauri production build runs under a strict CSP and may have
 * no internet access — so we redirect the loader to local assets
 * shipped in `public/monaco/vs/`.
 *
 * Run this once before any `<Editor>` mounts — `CanvasBridgeProvider` calls it
 * at module evaluation, before hydration, because a child `<Editor>`'s mount
 * effect runs before any provider's effect could. Idempotent: subsequent calls
 * are no-ops because `loader.config` only takes effect on first init.
 *
 * Asset bundling: `public/monaco/vs/` ships with a `loader.js`
 * + worker bundles. The recommended workflow is a `prebuild`
 * script that copies `node_modules/monaco-editor/min/vs` into
 * `public/monaco/vs/` so a Tauri build can run offline.
 */

import { loader } from "@monaco-editor/react"
import { isTauri } from "@/lib/platform/detect"
import { CogniaMonacoClipboardService } from "./monaco-clipboard-service"

let configured = false

/** An editor as far as container theming is concerned. */
interface ContainerHolder {
  getContainerDomNode(): HTMLElement
}

/** The slice of the Monaco namespace the service override and container theming need. */
interface MonacoServicesHost {
  editor: {
    create(
      domElement: HTMLElement,
      options?: Record<string, unknown>,
      overrides?: Record<string, unknown>
    ): { dispose(): void }
    onDidCreateEditor?(listener: (editor: ContainerHolder) => void): unknown
    onDidCreateDiffEditor?(listener: (editor: ContainerHolder) => void): unknown
  }
}

/**
 * Monaco's theme variables (`--vscode-menu-background`, …) are declared on
 * `.monaco-editor, .monaco-diff-editor, .monaco-component` only. Its context
 * menu, though, renders into a shadow root whose host is appended to the
 * editor's *container* — the element passed to `editor.create`, the PARENT of
 * `.monaco-editor` — so the menu inherits no variables and paints transparent
 * over the code. Marking each container `.monaco-component` (which on its own
 * only sets a font family the editor overrides) puts the variables in scope.
 */
const THEMED_CONTAINER_CLASS = "monaco-component"

function themeContainer(editor: ContainerHolder): void {
  try {
    editor.getContainerDomNode().classList.add(THEMED_CONTAINER_CLASS)
  } catch {
    // A half-constructed editor without a container has no menu to theme.
  }
}

/**
 * Theme every editor and diff-editor container created on this instance from
 * now on. Runs inside the `loader.init()` resolution, before any caller can
 * create an editor.
 */
export function installMonacoContainerTheming(monaco: MonacoServicesHost): void {
  monaco.editor.onDidCreateEditor?.(themeContainer)
  monaco.editor.onDidCreateDiffEditor?.(themeContainer)
}

const servicedInstances = new WeakSet<object>()

/**
 * Install Cognia's standalone service overrides on a freshly loaded Monaco.
 *
 * Monaco reads overrides exactly once — in the first
 * `StandaloneServices.initialize(overrides)` — and any earlier service
 * access (`editor.createModel`, `defineTheme`, …) initializes with none. The
 * only public entry that passes overrides is `editor.create`, so this builds
 * (and immediately disposes) a detached editor carrying them. Must run
 * before any other code touches the instance; `configureMonacoLoader`
 * guarantees that by running it inside every `loader.init()` resolution.
 * Also installs the container theming below, once per instance.
 */
export function installMonacoServiceOverrides(monaco: MonacoServicesHost): void {
  if (servicedInstances.has(monaco)) return
  servicedInstances.add(monaco)
  if (typeof document === "undefined") return
  try {
    const editor = monaco.editor.create(
      document.createElement("div"),
      {},
      { clipboardService: new CogniaMonacoClipboardService() }
    )
    editor.dispose()
  } catch (err) {
    // A Monaco build that cannot create a detached editor keeps its stock
    // services — the editors still work, only the clipboard override is lost.
    console.warn("[monaco] service overrides not installed", err)
  }
  // After the detached editor: it is never shown, so it needs no theming.
  installMonacoContainerTheming(monaco)
}

type LoaderInit = typeof loader.init

/**
 * Wrap `loader.init` so every caller — `@monaco-editor/react`'s `<Editor>`
 * as well as `loadConfiguredMonaco` — sees the service overrides installed
 * before its own continuation runs. The cancel handle `<Editor>` calls on
 * unmount is carried over to the chained promise.
 */
function wrapLoaderInit(): void {
  // A loader without `init` (a stubbed `@monaco-editor/react`) has nothing
  // to wrap; configuration must not take the page down with it.
  if (typeof loader?.init !== "function") return
  const original: LoaderInit = loader.init.bind(loader)
  const wrapped = (() => {
    const cancelable = original()
    const chained = cancelable.then((monaco) => {
      installMonacoServiceOverrides(monaco as unknown as MonacoServicesHost)
      return monaco
    }) as ReturnType<LoaderInit>
    chained.cancel = () => cancelable.cancel()
    return chained
  }) as LoaderInit
  loader.init = wrapped
}

export function configureMonacoLoader(): void {
  if (configured) return
  configured = true
  if (typeof window === "undefined") return

  wrapLoaderInit()

  // In Tauri builds the page is served from `tauri://localhost` and
  // the strict CSP blocks any cross-origin script. Point the loader
  // at the local copy under `/monaco/vs/`.
  if (isTauri()) {
    loader.config({ paths: { vs: "/monaco/vs" } })
    return
  }

  // Web mode: respect a build-time override (e.g. for CI offline
  // testing) when present, otherwise leave the default CDN.
  const override =
    typeof process !== "undefined" ? process.env.NEXT_PUBLIC_MONACO_VS_PATH : undefined
  if (override) {
    loader.config({ paths: { vs: override } })
  }
}

/**
 * Return the same Monaco instance used by `@monaco-editor/react` after applying
 * Cognia's local-asset configuration. This keeps Monaco's ESM source tree out
 * of the application bundle while still exposing the API needed by bridges.
 */
export async function loadConfiguredMonaco() {
  configureMonacoLoader()
  return loader.init()
}
