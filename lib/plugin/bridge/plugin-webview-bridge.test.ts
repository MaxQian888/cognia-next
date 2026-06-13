import { registerWebviewsForPlugin, unregisterWebviewsForPlugin } from "./plugin-webview-bridge"
import {
  getWebviewSnapshot,
  __resetWebviewsForTesting,
} from "@/lib/plugin/registries/webview-registry"
import type { PluginManifest } from "@/types/plugin/plugin"

function manifest(webviews: PluginManifest["webviews"], allowedDomains?: string[]): PluginManifest {
  return {
    id: "p",
    name: "P",
    version: "1.0.0",
    capabilities: ["webview"],
    webviews,
    networkAccess: allowedDomains ? { allowedDomains } : undefined,
  } as PluginManifest
}

describe("plugin-webview-bridge", () => {
  afterEach(() => __resetWebviewsForTesting())

  it("registers an inline-html webview wrapped with CSP", async () => {
    const result = await registerWebviewsForPlugin(
      manifest([{ id: "dash", containerId: "explorer", html: "<h1>Hi</h1>" }], ["api.example.com"]),
      "/root"
    )
    expect(result.registered).toBe(1)
    const [w] = getWebviewSnapshot()
    expect(w).toMatchObject({ viewId: "dash", containerId: "p:explorer", surface: "panel" })
    expect(w.srcDoc).toContain("<h1>Hi</h1>")
    expect(w.srcDoc).toContain("Content-Security-Policy")
    expect(w.srcDoc).toContain("connect-src https://api.example.com")
  })

  it("resolves html from an entry/export string", async () => {
    const importer = jest.fn(async () => ({ body: "<p>From module</p>" }))
    await registerWebviewsForPlugin(
      manifest([{ id: "m", containerId: "c", entry: "wv.js", export: "body" }]),
      "/root",
      { importer }
    )
    expect(importer).toHaveBeenCalledWith("/root/wv.js")
    expect(getWebviewSnapshot()[0].srcDoc).toContain("From module")
  })

  it("resolves html from an entry/export factory function", async () => {
    const importer = jest.fn(async () => ({ render: () => "<p>factory</p>" }))
    await registerWebviewsForPlugin(
      manifest([{ id: "m", containerId: "c", entry: "wv.js", export: "render" }]),
      "/root",
      { importer }
    )
    expect(getWebviewSnapshot()[0].srcDoc).toContain("factory")
  })

  it("errors when neither html nor entry/export is provided", async () => {
    const result = await registerWebviewsForPlugin(
      manifest([{ id: "bad", containerId: "c" }]),
      "/root"
    )
    expect(result.registered).toBe(0)
    expect(result.errors[0].message).toMatch(/inline `html` or `entry`/)
  })

  it("errors when the export does not yield a string", async () => {
    const importer = jest.fn(async () => ({ body: 42 }))
    const result = await registerWebviewsForPlugin(
      manifest([{ id: "x", containerId: "c", entry: "wv.js", export: "body" }]),
      "/root",
      { importer }
    )
    expect(result.registered).toBe(0)
    expect(result.errors[0].message).toMatch(/HTML string/)
  })

  it("uses connect-src * when no networkAccess is declared", async () => {
    await registerWebviewsForPlugin(manifest([{ id: "d", containerId: "c", html: "x" }]), "/root")
    expect(getWebviewSnapshot()[0].srcDoc).toContain("connect-src *")
  })

  it("no-ops without webviews", async () => {
    const result = await registerWebviewsForPlugin(manifest(undefined), "/root")
    expect(result).toEqual({ registered: 0, errors: [] })
  })

  it("unregisterWebviewsForPlugin drops them", async () => {
    await registerWebviewsForPlugin(manifest([{ id: "d", containerId: "c", html: "x" }]), "/root")
    unregisterWebviewsForPlugin("p")
    expect(getWebviewSnapshot()).toHaveLength(0)
  })
})
