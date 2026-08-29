/**
 * The in-frame bootstrap shared by both scripted artifact previews: the React
 * runtime shell and the opt-in interactive HTML sandbox.
 *
 * Bundled by `scripts/build/build-artifact-runtime.mjs` into
 * `public/artifact-runtime/artifact-shell.js` and loaded by the preview as
 * `<script src="…/artifact-shell.js">`. It is a FILE and not an inline
 * `<script>` because of a measured fact (ADR-0158): in the packaged desktop
 * shell an `about:srcdoc` child — sandboxed, opaque origin, with any meta CSP
 * you like — inherits `src-tauri/tauri.conf.json`'s policy, which carries no
 * `'unsafe-inline'` and no `'unsafe-eval'`. The two things that DO run there are
 * a same-origin URL and a `blob:` script, so those are the only two mechanisms
 * this file uses.
 *
 * Three rules it exists to keep:
 *
 * 1. **One root, ever.** The previous shell called `ReactDOM.createRoot` on
 *    every message, which leaked a root per keystroke in a Canvas split view
 *    and forced the host to re-navigate the whole frame to show an edit.
 * 2. **No eval, anywhere.** Artifact code arrives already transformed (the host
 *    runs Babel in a Worker) and executes as a `blob:` script.
 * 3. **Nothing is written as HTML.** Error text goes through `textContent`, so
 *    an artifact's own failure message cannot inject markup.
 */

/** Strings the host hands the frame; the frame never hard-codes user-facing text. */
export interface ArtifactShellMessages {
  noComponentFound: string
  runtimeInitFailed: string
}

/** One executable unit handed to the frame. */
export interface ArtifactShellScript {
  code: string
  /** `true` for `<script type="module">`; classic script otherwise. */
  module?: boolean
}

/** Messages the host may send into the frame. */
export type ArtifactShellInboundMessage =
  | { type: "artifact-shell-config"; messages: ArtifactShellMessages }
  | { type: "render-component"; code: string; isModule?: boolean }
  | { type: "run-scripts"; scripts: ArtifactShellScript[] }
  | { type: "artifact-preview-parent-context"; themeVariables?: Record<string, string> }

interface ArtifactRoot {
  render(node: unknown): void
}

interface ArtifactReactGlobals {
  React: { createElement(type: unknown, props?: unknown): unknown }
  ReactDOM: { createRoot(container: Element): ArtifactRoot }
  ReactJSXRuntime?: unknown
}

/**
 * The subset of a window the bootstrap touches. Narrow on purpose so the unit
 * test can drive it with a stub instead of a real frame.
 */
export interface ArtifactShellScope {
  document: Document
  parent: { postMessage(message: unknown, targetOrigin: string): void }
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void
  URL: { createObjectURL(blob: Blob): string; revokeObjectURL(url: string): void }
  Blob: typeof Blob
  [key: string]: unknown
}

const DEFAULT_MESSAGES: ArtifactShellMessages = {
  // Replaced by the host's localized strings on the first config message. These
  // literals only surface if the host never sends one.
  noComponentFound: "No component found.",
  runtimeInitFailed: "The artifact runtime failed to initialize.",
}

/** Wrap transformed React artifact code so its component reaches the picker. */
export function buildArtifactModuleSource(code: string, isModule: boolean): string {
  if (isModule) {
    // Babel downleveled ESM to CommonJS, so the code expects module/exports/require.
    return `(function (module, exports, require) {\n${code}\n})(__cogniaArtifactModule, __cogniaArtifactModule.exports, __cogniaArtifactRequire);\n__cogniaArtifactPick(null, null, null, __cogniaArtifactModule.exports);\n`
  }
  // Classic script semantics — top-level `const`/`let` land in the global
  // lexical scope, so `typeof` sees them from this same script.
  return `${code}\n;__cogniaArtifactPick(typeof App !== "undefined" ? App : null, typeof Component !== "undefined" ? Component : null, typeof Main !== "undefined" ? Main : null, null);\n`
}

/**
 * Resolve the component an artifact meant to export. Module exports win over
 * globals: a file that says `export default` said which one it meant.
 */
export function pickArtifactComponent(
  app: unknown,
  component: unknown,
  main: unknown,
  moduleExports: unknown
): unknown {
  const exported = moduleExports as Record<string, unknown> | null | undefined
  const candidates = [
    exported?.default,
    exported?.App,
    exported?.Component,
    exported?.Main,
    app,
    component,
    main,
  ]
  return candidates.find((value) => typeof value === "function") ?? null
}

/** The `require` an artifact's downleveled `import` lands on. */
export function createArtifactRequire(globals: ArtifactReactGlobals) {
  return function artifactRequire(specifier: string): unknown {
    switch (specifier) {
      case "react":
        return globals.React
      case "react-dom":
      case "react-dom/client":
        return globals.ReactDOM
      case "react/jsx-runtime":
      case "react/jsx-dev-runtime":
        return globals.ReactJSXRuntime ?? globals.React
      default:
        throw new Error(`Artifact previews cannot import "${specifier}" — only react is bundled.`)
    }
  }
}

/**
 * Install the bootstrap into `scope`. Returns a disposer so the unit test can
 * tear it down; the frame itself never calls it.
 */
export function installArtifactShellRuntime(scope: ArtifactShellScope): () => void {
  const globals = scope as unknown as ArtifactReactGlobals
  const doc = scope.document
  let messages = DEFAULT_MESSAGES
  let root: ArtifactRoot | null = null
  let announcedReady = false
  const objectUrls: string[] = []

  const post = (message: unknown) => {
    try {
      scope.parent.postMessage(message, "*")
    } catch {
      // A frame whose host has gone away is not an artifact error.
    }
  }

  const container = () => doc.getElementById("root")

  const showText = (text: string, tone: "error" | "muted") => {
    const host = container() ?? doc.body
    if (!host) return
    const box = doc.createElement("div")
    box.setAttribute("data-artifact-shell", tone)
    box.style.cssText =
      tone === "error"
        ? "color:#b91c1c;background:#fee2e2;border-radius:8px;padding:16px;font:13px/1.5 system-ui,sans-serif"
        : "color:#6b7280;padding:16px;font:13px/1.5 system-ui,sans-serif"
    // textContent, never innerHTML: the text can be an artifact's own error.
    box.textContent = text
    if (host === container()) host.replaceChildren(box)
    else host.appendChild(box)
  }

  const fail = (message: string) => {
    showText(message, "error")
    post({ type: "artifact-preview-error", message })
  }

  const announceReady = () => {
    if (announcedReady) return
    announcedReady = true
    post({ type: "artifact-preview-ready" })
  }

  /**
   * Execute one source string as a `blob:` script. `async = false` is what keeps
   * dynamically-inserted scripts in insertion order — without it an artifact's
   * second `<script>` can run before its first.
   */
  const runBlobScript = (source: string, asModule: boolean, onDone?: () => void) => {
    let url: string
    try {
      url = scope.URL.createObjectURL(new scope.Blob([source], { type: "text/javascript" }))
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
      return
    }
    objectUrls.push(url)
    const script = doc.createElement("script")
    if (asModule) script.type = "module"
    else script.async = false
    script.src = url
    script.addEventListener("error", () => {
      // A blocked blob: script is the CSP saying no — the only way this fails
      // once the shell itself has loaded.
      fail(messages.runtimeInitFailed)
    })
    if (onDone) script.addEventListener("load", onDone)
    doc.head.appendChild(script)
  }

  const renderComponent = (candidate: unknown) => {
    if (typeof candidate !== "function") {
      showText(messages.noComponentFound, "muted")
      return
    }
    if (!root) {
      const host = container()
      if (!host || typeof globals.ReactDOM?.createRoot !== "function") {
        fail(messages.runtimeInitFailed)
        return
      }
      root = globals.ReactDOM.createRoot(host)
    }
    root.render(globals.React.createElement(candidate))
    announceReady()
  }

  scope.__cogniaArtifactPick = (
    app: unknown,
    component: unknown,
    main: unknown,
    moduleExports: unknown
  ) => {
    try {
      renderComponent(pickArtifactComponent(app, component, main, moduleExports))
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
    }
  }
  scope.__cogniaArtifactRequire = createArtifactRequire(globals)

  const onMessage = (event: MessageEvent) => {
    const data = event.data as ArtifactShellInboundMessage | undefined
    if (!data || typeof data !== "object") return
    try {
      if (data.type === "artifact-shell-config") {
        messages = { ...DEFAULT_MESSAGES, ...data.messages }
        return
      }
      if (data.type === "artifact-preview-parent-context") {
        // An opaque-origin frame cannot be reached through `contentDocument`,
        // so the palette arrives over the same channel everything else does.
        for (const [name, value] of Object.entries(data.themeVariables ?? {})) {
          if (name.startsWith("--")) doc.documentElement.style.setProperty(name, value)
        }
        return
      }
      if (data.type === "render-component") {
        if (!globals.React || typeof globals.ReactDOM?.createRoot !== "function") {
          fail(messages.runtimeInitFailed)
          return
        }
        scope.__cogniaArtifactModule = { exports: {} }
        runBlobScript(
          buildArtifactModuleSource(String(data.code ?? ""), data.isModule === true),
          false
        )
        return
      }
      if (data.type === "run-scripts") {
        const scripts = Array.isArray(data.scripts) ? data.scripts : []
        if (scripts.length === 0) {
          announceReady()
          return
        }
        scripts.forEach((script, index) => {
          const last = index === scripts.length - 1
          runBlobScript(
            String(script.code ?? ""),
            script.module === true,
            last ? announceReady : undefined
          )
        })
      }
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
    }
  }

  scope.addEventListener("message", onMessage)
  post({ type: "artifact-shell-ready" })

  return () => {
    for (const url of objectUrls.splice(0)) {
      try {
        scope.URL.revokeObjectURL(url)
      } catch {
        // Already revoked, or a scope that never had one.
      }
    }
    delete scope.__cogniaArtifactPick
    delete scope.__cogniaArtifactRequire
    delete scope.__cogniaArtifactModule
  }
}
