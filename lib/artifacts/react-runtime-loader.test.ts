/**
 * @jest-environment jsdom
 */

import {
  ARTIFACT_JSX_TRANSFORM_PATH,
  ARTIFACT_RUNTIME_MANIFEST_PATH,
  ArtifactRuntimeUnavailableError,
  loadArtifactReactRuntime,
  resetArtifactReactRuntimeForTests,
  transformArtifactJsx,
} from "./react-runtime-loader"

const MANIFEST = {
  schema: 1,
  reactVersion: "19.2.8",
  babelVersion: "8.0.4",
  files: {
    "react-runtime.js": { bytes: 1, sha256: "a" },
    "jsx-transform.js": { bytes: 1, sha256: "b" },
    "artifact-shell.js": { bytes: 1, sha256: "c" },
  },
}

const originalWorker = globalThis.Worker

function mockFetch(body: unknown, ok = true) {
  const fetchMock = jest.fn(async () => ({ ok, status: ok ? 200 : 404, json: async () => body }))
  globalThis.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

beforeEach(() => {
  resetArtifactReactRuntimeForTests()
  jest.spyOn(console, "error").mockImplementation(() => undefined)
})

afterEach(() => {
  jest.restoreAllMocks()
  globalThis.Worker = originalWorker
})

describe("loadArtifactReactRuntime", () => {
  it("resolves absolute same-origin URLs for both bundles", async () => {
    mockFetch(MANIFEST)
    const runtime = await loadArtifactReactRuntime()
    expect(runtime.origin).toBe(window.location.origin)
    expect(runtime.reactRuntimeUrl).toBe(
      `${window.location.origin}/artifact-runtime/react-runtime.js`
    )
    expect(runtime.shellUrl).toBe(`${window.location.origin}/artifact-runtime/artifact-shell.js`)
    expect(runtime.reactVersion).toBe("19.2.8")
  })

  it("fetches the manifest once however many previews open", async () => {
    const fetchMock = mockFetch(MANIFEST)
    await Promise.all([loadArtifactReactRuntime(), loadArtifactReactRuntime()])
    await loadArtifactReactRuntime()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(ARTIFACT_RUNTIME_MANIFEST_PATH),
      expect.anything()
    )
  })

  it("fails loudly when the runtime is not being served", async () => {
    mockFetch(null, false)
    await expect(loadArtifactReactRuntime()).rejects.toBeInstanceOf(ArtifactRuntimeUnavailableError)
  })

  it("rejects a manifest that is missing a bundle instead of handing out a dead URL", async () => {
    mockFetch({ ...MANIFEST, files: { "react-runtime.js": { bytes: 1, sha256: "a" } } })
    await expect(loadArtifactReactRuntime()).rejects.toBeInstanceOf(ArtifactRuntimeUnavailableError)
  })

  it("does not cache the failure, so a mid-session rebuild is picked up", async () => {
    mockFetch(null, false)
    await expect(loadArtifactReactRuntime()).rejects.toThrow()
    mockFetch(MANIFEST)
    await expect(loadArtifactReactRuntime()).resolves.toMatchObject({ reactVersion: "19.2.8" })
  })
})

describe("transformArtifactJsx", () => {
  it("round-trips through a Worker so Babel never enters the preview frame", async () => {
    // 2.4 MB of @babel/standalone per frame — and 'unsafe-eval' to run it —
    // is exactly what putting the transform in the parent avoids.
    const posted: unknown[] = []
    class FakeWorker {
      listeners: Record<string, Array<(event: MessageEvent) => void>> = {}
      addEventListener(type: string, handler: (event: MessageEvent) => void) {
        ;(this.listeners[type] ??= []).push(handler)
      }
      postMessage(message: { id: number; code: string }) {
        posted.push(message)
        for (const handler of this.listeners.message ?? []) {
          handler({
            data: {
              type: "cognia-artifact-jsx-result",
              id: message.id,
              code: `transformed:${message.code}`,
              isModule: true,
            },
          } as MessageEvent)
        }
      }
      terminate() {}
    }
    globalThis.Worker = FakeWorker as unknown as typeof Worker

    await expect(transformArtifactJsx("<div/>")).resolves.toEqual({
      code: "transformed:<div/>",
      isModule: true,
    })
    expect(posted).toHaveLength(1)
  })

  it("surfaces a transform error rather than rendering nothing", async () => {
    class FailingWorker {
      listeners: Record<string, Array<(event: MessageEvent) => void>> = {}
      addEventListener(type: string, handler: (event: MessageEvent) => void) {
        ;(this.listeners[type] ??= []).push(handler)
      }
      postMessage(message: { id: number }) {
        for (const handler of this.listeners.message ?? []) {
          handler({
            data: { type: "cognia-artifact-jsx-result", id: message.id, error: "Unexpected token" },
          } as MessageEvent)
        }
      }
      terminate() {}
    }
    globalThis.Worker = FailingWorker as unknown as typeof Worker
    await expect(transformArtifactJsx("const = ")).rejects.toThrow("Unexpected token")
  })

  it("falls back to the main thread when a Worker cannot be constructed", async () => {
    globalThis.Worker = class {
      constructor() {
        throw new Error("workers disabled")
      }
    } as unknown as typeof Worker
    ;(globalThis as { CogniaArtifactJsx?: unknown }).CogniaArtifactJsx = {
      transform: (code: string) => ({ code: `inline:${code}`, isModule: false }),
    }
    await expect(transformArtifactJsx("<p/>")).resolves.toEqual({
      code: "inline:<p/>",
      isModule: false,
    })
  })

  it("reports the bundle path it could not load", async () => {
    globalThis.Worker = undefined as unknown as typeof Worker
    const appended: HTMLScriptElement[] = []
    jest.spyOn(document.head, "appendChild").mockImplementation(((node: HTMLScriptElement) => {
      appended.push(node)
      queueMicrotask(() => node.dispatchEvent(new Event("error")))
      return node
    }) as never)
    await expect(transformArtifactJsx("<p/>")).rejects.toBeInstanceOf(
      ArtifactRuntimeUnavailableError
    )
    expect(appended[0].src).toContain(ARTIFACT_JSX_TRANSFORM_PATH)
  })
})
