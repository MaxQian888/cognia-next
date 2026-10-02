jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => true) }))
jest.mock("@/lib/codeserver/client", () => ({
  codeServerClient: {
    buildProxy: jest.fn(async (request) => ({ ...request, sha256: "new-proxy" })),
    activateProxy: jest.fn(async () => true),
    activateProxyTemporary: jest.fn(async () => true),
  },
}))
let receipt: { verifiedVia: string } | null = { verifiedVia: "signature" }
jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn(async () => receipt),
}))
let devMode = false
jest.mock("./dev-mode", () => ({ isDevModeActive: () => devMode }))

import { invoke } from "@tauri-apps/api/core"
import { codeServerClient } from "@/lib/codeserver/client"
import {
  clearAllPluginPointDiagnostics,
  getPluginPointDiagnostics,
} from "@/lib/plugin/contracts/diagnostics-store"
import type { Plugin } from "@/types/plugin"

import {
  activateTemporaryManagedIdeProxy,
  collectProxyAssets,
  prepareManagedIdeProxy,
  stageManagedIdeProxy,
} from "./proxy-manager"

const proIdePlugin = (source = "marketplace") =>
  ({
    source,
    manifest: {
      id: "acme",
      version: "1.0.0",
      ide: { schemaVersion: 1, targets: ["pro-ide"] },
    },
    path: "/plugins/acme",
  }) as unknown as Plugin

beforeEach(() => {
  jest.clearAllMocks()
  receipt = { verifiedVia: "signature" }
  devMode = false
  clearAllPluginPointDiagnostics()
})

it("collects only confined static contribution assets", () => {
  expect(
    collectProxyAssets("/plugins/acme", {
      grammars: [{ path: "syntaxes/acme.tmLanguage.json" }],
      commands: [
        { icon: { light: "media/light.svg", dark: "media/dark.svg" } },
        { icon: "$(refresh)" },
      ],
      themes: [{ path: "../escape.json" }],
      notebookRenderer: [{ entrypoint: "notebooks/renderer.js" }],
    })
  ).toEqual([
    { packagePath: "media/dark.svg", sourcePath: "/plugins/acme/media/dark.svg" },
    { packagePath: "media/light.svg", sourcePath: "/plugins/acme/media/light.svg" },
    {
      packagePath: "notebooks/renderer.js",
      sourcePath: "/plugins/acme/notebooks/renderer.js",
    },
    {
      packagePath: "syntaxes/acme.tmLanguage.json",
      sourcePath: "/plugins/acme/syntaxes/acme.tmLanguage.json",
    },
  ])
})

it("builds a proxy only from normalized IR", async () => {
  const plugin = {
    manifest: {
      id: "acme",
      version: "1.0.0",
      ide: {
        schemaVersion: 1,
        targets: ["pro-ide"],
        providers: [{ id: "hover", kind: "hover", handler: "provideHover" }],
      },
    },
    path: "/plugins/acme",
  } as unknown as Plugin
  await prepareManagedIdeProxy(plugin)
  expect(codeServerClient.buildProxy).toHaveBeenCalledWith(
    expect.objectContaining({
      pluginId: "acme",
      pluginVersion: "1.0.0",
      catalogHash: expect.stringMatching(/^sha256:/),
      providers: [
        expect.objectContaining({
          id: "cognia.acme.hover",
          permission: "editor:read",
        }),
      ],
    })
  )
  expect(codeServerClient.activateProxy).toHaveBeenCalledWith(
    expect.objectContaining({ pluginId: "acme", sha256: "new-proxy" })
  )
})

it("can stage a proxy without changing a live extension host", async () => {
  const plugin = {
    manifest: {
      id: "acme",
      version: "2.0.0",
      ide: {
        schemaVersion: 1,
        targets: ["pro-ide"],
        contributions: { commands: [{ command: "cognia.acme.run", title: "Run" }] },
      },
    },
    path: "/staging/acme",
  } as unknown as Plugin

  await expect(stageManagedIdeProxy(plugin)).resolves.toEqual(
    expect.objectContaining({ pluginId: "acme", sha256: "new-proxy" })
  )
  expect(codeServerClient.buildProxy).toHaveBeenCalledTimes(1)
  expect(codeServerClient.activateProxy).not.toHaveBeenCalled()
})

it("signs no proxy for an install the host holds no receipt for, and says why", async () => {
  receipt = null
  await expect(stageManagedIdeProxy(proIdePlugin())).resolves.toBeNull()
  expect(invoke).toHaveBeenCalledWith("plugin_read_verification", { pluginId: "acme" })
  expect(codeServerClient.buildProxy).not.toHaveBeenCalled()
  expect(getPluginPointDiagnostics("acme")).toEqual([
    expect.objectContaining({ code: "plugin.ide.proxy-receipt-required", severity: "warning" }),
  ])
})

it("trusts a builtin plugin without asking for a receipt", async () => {
  receipt = null
  await expect(stageManagedIdeProxy(proIdePlugin("builtin"))).resolves.not.toBeNull()
  expect(invoke).not.toHaveBeenCalled()
})

it("activates a Dev Mode rebuild as temporary, and only during Dev Mode", async () => {
  await expect(activateTemporaryManagedIdeProxy(proIdePlugin())).rejects.toThrow(
    "MANAGED_IDE_DEV_MODE_OFF"
  )
  devMode = true
  await activateTemporaryManagedIdeProxy(proIdePlugin())
  expect(codeServerClient.activateProxyTemporary).toHaveBeenCalledWith(
    expect.objectContaining({ pluginId: "acme", sha256: "new-proxy" })
  )
  expect(codeServerClient.activateProxy).not.toHaveBeenCalled()
})
