jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => true) }))
jest.mock("@/lib/codeserver/client", () => ({
  codeServerClient: {
    buildProxy: jest.fn(async (request) => ({ ...request, sha256: "new-proxy" })),
    activateProxy: jest.fn(async () => true),
  },
}))

import { codeServerClient } from "@/lib/codeserver/client"
import type { Plugin } from "@/types/plugin"

import { collectProxyAssets, prepareManagedIdeProxy, stageManagedIdeProxy } from "./proxy-manager"

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
