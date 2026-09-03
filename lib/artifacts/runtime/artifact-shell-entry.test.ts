/**
 * @jest-environment jsdom
 */

import {
  buildArtifactModuleSource,
  createArtifactRequire,
  installArtifactShellRuntime,
  pickArtifactComponent,
  type ArtifactShellScope,
} from "./artifact-shell-entry"

describe("pickArtifactComponent", () => {
  const fn = () => null

  it("prefers what a module explicitly exported over a stray global", () => {
    const other = () => null
    expect(pickArtifactComponent(other, null, null, { default: fn })).toBe(fn)
  })

  it("falls back through App, Component, Main", () => {
    expect(pickArtifactComponent(null, fn, null, null)).toBe(fn)
    expect(pickArtifactComponent(null, null, fn, null)).toBe(fn)
  })

  it("ignores non-function candidates", () => {
    expect(pickArtifactComponent("App", 42, null, { default: {} })).toBeNull()
  })
})

describe("buildArtifactModuleSource", () => {
  it("hands classic code the three global names verbatim", () => {
    const source = buildArtifactModuleSource("const App = () => null", false)
    expect(source).toContain("const App = () => null")
    expect(source).toContain('typeof App !== "undefined"')
    expect(source).not.toContain("__cogniaArtifactModule")
  })

  it("wraps downleveled ESM so module/exports/require are in scope", () => {
    const source = buildArtifactModuleSource('var _react = require("react")', true)
    expect(source).toContain("function (module, exports, require)")
    expect(source).toContain("__cogniaArtifactModule.exports")
  })
})

describe("createArtifactRequire", () => {
  const React = { createElement: () => null }
  const ReactDOM = { createRoot: () => ({ render: () => undefined }) }
  const require_ = createArtifactRequire({ React, ReactDOM } as never)

  it("serves the react family from the bundled globals", () => {
    expect(require_("react")).toBe(React)
    expect(require_("react-dom/client")).toBe(ReactDOM)
    expect(require_("react/jsx-runtime")).toBe(React)
  })

  it("names the module it cannot supply instead of returning undefined", () => {
    expect(() => require_("lodash")).toThrow(/lodash/)
  })
})

describe("installArtifactShellRuntime", () => {
  interface Harness {
    scope: ArtifactShellScope
    posted: unknown[]
    dispatch: (data: unknown) => void
    rendered: unknown[]
    blobs: string[]
    dispose: () => void
    pick: (app: unknown, component: unknown, main: unknown, moduleExports: unknown) => void
  }

  function harness(options: { withReact?: boolean } = {}): Harness {
    document.body.innerHTML = '<div id="root"></div>'
    // jsdom keeps one document across tests; the bootstrap appends to <head>.
    document.head.querySelectorAll("script").forEach((tag) => tag.remove())
    const posted: unknown[] = []
    const rendered: unknown[] = []
    const blobs: string[] = []
    const inbox: { listener?: (event: MessageEvent) => void } = {}
    const scope = {
      document,
      parent: { postMessage: (message: unknown) => void posted.push(message) },
      addEventListener: (_type: "message", handler: (event: MessageEvent) => void) => {
        inbox.listener = handler
      },
      URL: {
        createObjectURL: (blob: Blob) => {
          blobs.push(String((blob as unknown as { __source?: string }).__source ?? ""))
          return `blob:test-${blobs.length}`
        },
        revokeObjectURL: () => undefined,
      },
      Blob: class FakeBlob {
        __source: string
        constructor(parts: string[]) {
          this.__source = parts.join("")
        }
      } as unknown as typeof Blob,
    } as unknown as ArtifactShellScope
    if (options.withReact !== false) {
      ;(scope as Record<string, unknown>).React = { createElement: (type: unknown) => ({ type }) }
      ;(scope as Record<string, unknown>).ReactDOM = {
        createRoot: () => ({ render: (node: unknown) => void rendered.push(node) }),
      }
    }
    const dispose = installArtifactShellRuntime(scope)
    return {
      scope,
      pick: scope.__cogniaArtifactPick as Harness["pick"],
      posted,
      rendered,
      blobs,
      dispose,
      dispatch: (data: unknown) => inbox.listener?.({ data } as MessageEvent),
    }
  }

  it("announces itself so the host knows the frame is alive", () => {
    const h = harness()
    expect(h.posted).toContainEqual({ type: "artifact-shell-ready" })
    h.dispose()
  })

  it("executes artifact code as a blob: script, never inline and never via eval", () => {
    // Measured: a srcdoc child inherits the shell CSP, which allows `blob:` and
    // nothing else executable. An inline script or `new Function` runs nowhere.
    const h = harness()
    h.dispatch({ type: "render-component", code: "function App(){return null}" })
    expect(h.blobs).toHaveLength(1)
    expect(h.blobs[0]).toContain("function App(){return null}")
    expect(document.head.querySelector("script")?.getAttribute("src")).toBe("blob:test-1")
    h.dispose()
  })

  it("creates the root once across repeated renders", () => {
    // A root per message was both a leak and the reason an edit needed a full
    // iframe re-navigation to show up.
    const h = harness()
    let roots = 0
    ;(h.scope as Record<string, unknown>).ReactDOM = {
      createRoot: () => {
        roots += 1
        return { render: (node: unknown) => void h.rendered.push(node) }
      },
    }
    h.pick(() => null, null, null, null)
    h.pick(() => null, null, null, null)
    expect(roots).toBe(1)
    expect(h.rendered).toHaveLength(2)
    h.dispose()
  })

  it("reports ready exactly once, on the first successful render", () => {
    const h = harness()
    h.pick(() => null, null, null, null)
    h.pick(() => null, null, null, null)
    expect(
      h.posted.filter((m) => (m as { type: string }).type === "artifact-preview-ready")
    ).toHaveLength(1)
    h.dispose()
  })

  it("says the runtime failed when React never loaded", () => {
    const h = harness({ withReact: false })
    h.dispatch({
      type: "artifact-shell-config",
      messages: { runtimeInitFailed: "boom", noComponentFound: "none" },
    })
    h.dispatch({ type: "render-component", code: "function App(){}" })
    expect(h.posted).toContainEqual({ type: "artifact-preview-error", message: "boom" })
    h.dispose()
  })

  it("uses the host's wording for a document that exports nothing", () => {
    const h = harness()
    h.dispatch({
      type: "artifact-shell-config",
      messages: { runtimeInitFailed: "boom", noComponentFound: "nothing here" },
    })
    h.pick(null, null, null, null)
    expect(document.querySelector("[data-artifact-shell]")?.textContent).toBe("nothing here")
    h.dispose()
  })

  it("renders error text through textContent so an artifact cannot inject markup", () => {
    const h = harness({ withReact: false })
    h.dispatch({
      type: "artifact-shell-config",
      messages: { runtimeInitFailed: "<img src=x onerror=alert(1)>", noComponentFound: "n" },
    })
    h.dispatch({ type: "render-component", code: "" })
    const box = document.querySelector('[data-artifact-shell="error"]')
    expect(box?.querySelector("img")).toBeNull()
    expect(box?.textContent).toBe("<img src=x onerror=alert(1)>")
    h.dispose()
  })

  it("runs interactive scripts in order, marking only modules as modules", () => {
    const h = harness()
    h.dispatch({
      type: "run-scripts",
      scripts: [{ code: "one" }, { code: "two", module: true }, { code: "three" }],
    })
    expect(h.blobs).toEqual(["one", "two", "three"])
    const tags = Array.from(document.head.querySelectorAll("script"))
    expect(tags.map((t) => t.getAttribute("src"))).toEqual([
      "blob:test-1",
      "blob:test-2",
      "blob:test-3",
    ])
    // async=false is what keeps dynamically inserted scripts in insertion order.
    expect(tags[0].async).toBe(false)
    expect(tags[1].type).toBe("module")
    h.dispose()
  })

  it("reports ready for an interactive document that has nothing to run", () => {
    const h = harness()
    h.dispatch({ type: "run-scripts", scripts: [] })
    expect(h.posted).toContainEqual({ type: "artifact-preview-ready" })
    h.dispose()
  })

  it("ignores messages it does not own", () => {
    const h = harness()
    const before = h.posted.length
    h.dispatch({ type: "something-else" })
    h.dispatch(null)
    expect(h.posted).toHaveLength(before)
    h.dispose()
  })
})

describe("theme variables over the parent-context channel", () => {
  it("applies custom properties the host pushes in", () => {
    // The frame is opaque-origin, so `contentDocument` is null to the host —
    // postMessage is the only way a palette can reach it.
    document.body.innerHTML = '<div id="root"></div>'
    document.head.querySelectorAll("script").forEach((tag) => tag.remove())
    const inbox: { listener?: (event: MessageEvent) => void } = {}
    const scope = {
      document,
      parent: { postMessage: () => undefined },
      addEventListener: (_t: "message", h: (event: MessageEvent) => void) => {
        inbox.listener = h
      },
      URL: { createObjectURL: () => "blob:x", revokeObjectURL: () => undefined },
      Blob,
    } as unknown as ArtifactShellScope
    const dispose = installArtifactShellRuntime(scope)
    inbox.listener?.({
      data: {
        type: "artifact-preview-parent-context",
        themeVariables: { "--background": "#123456", evil: "x" },
      },
    } as MessageEvent)
    expect(document.documentElement.style.getPropertyValue("--background")).toBe("#123456")
    expect(document.documentElement.style.getPropertyValue("evil")).toBe("")
    dispose()
  })
})

describe("capture-snapshot", () => {
  const scopeWith = (posted: unknown[], inbox: { listener?: (e: MessageEvent) => void }) =>
    ({
      document,
      parent: { postMessage: (message: unknown) => posted.push(message) },
      addEventListener: (_t: "message", h: (event: MessageEvent) => void) => {
        inbox.listener = h
      },
      URL: { createObjectURL: () => "blob:x", revokeObjectURL: () => undefined },
      Blob,
    }) as unknown as ArtifactShellScope

  it("answers with a static snapshot of what the frame drew", () => {
    // Rasterising cannot happen in here: a sandboxed `allow-scripts` document
    // is opaque-origin and cannot read its own child iframe, which is exactly
    // what html2canvas needs. So the frame hands out markup and the parent
    // renders it.
    document.body.innerHTML = '<div id="root"><h1 style="color:#334">Drawn</h1></div>'
    document.head.querySelectorAll("script").forEach((tag) => tag.remove())
    const posted: unknown[] = []
    const inbox: { listener?: (e: MessageEvent) => void } = {}
    const dispose = installArtifactShellRuntime(scopeWith(posted, inbox))

    inbox.listener?.({ data: { type: "capture-snapshot", requestId: "req-1" } } as MessageEvent)

    const reply = posted.find(
      (m) => (m as { type?: string }).type === "artifact-capture-result"
    ) as { requestId: string; html: string; width: number; height: number }
    expect(reply.requestId).toBe("req-1")
    expect(reply.html).toContain("<!DOCTYPE html>")
    expect(reply.html).toContain("Drawn")
    expect(reply.html).toContain('style="color:#334"')
    expect(reply.width).toBeGreaterThan(0)
    expect(reply.height).toBeGreaterThan(0)
    dispose()
  })

  it("addresses a failure to the request instead of the preview", () => {
    // A generic `artifact-preview-error` would leave the caller waiting for a
    // timeout rather than telling it why the capture failed.
    document.body.innerHTML = '<div id="root"></div>'
    const posted: unknown[] = []
    const inbox: { listener?: (e: MessageEvent) => void } = {}
    const scope = scopeWith(posted, inbox)
    const dispose = installArtifactShellRuntime(scope)
    const original = Object.getOwnPropertyDescriptor(Document.prototype, "documentElement")
    Object.defineProperty(document, "documentElement", {
      configurable: true,
      get() {
        throw new Error("serialisation blew up")
      },
    })
    try {
      inbox.listener?.({ data: { type: "capture-snapshot", requestId: "req-2" } } as MessageEvent)
    } finally {
      delete (document as unknown as Record<string, unknown>).documentElement
      if (original) Object.defineProperty(Document.prototype, "documentElement", original)
    }
    expect(posted).toContainEqual({
      type: "artifact-capture-error",
      requestId: "req-2",
      message: "serialisation blew up",
    })
    dispose()
  })
})
