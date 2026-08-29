/**
 * @jest-environment jsdom
 */

const applyPolicyMock = jest.fn()
jest.mock("@/lib/plugin/core/policy-runtime", () => ({
  applyPluginPolicyToRuntime: (...args: unknown[]) => applyPolicyMock(...args),
}))

import {
  activatePluginAccountStorage,
  clearPluginAccountStorage,
  normalizePersistedPluginStatus,
  pluginAccountStorageKey,
  usePluginStore,
} from "./plugin-store"
import * as barrel from "./"
import type { PluginStatus } from "@/types/plugin/plugin"

it("barrel re-exports usePluginStore", () => {
  expect(barrel.usePluginStore).toBe(usePluginStore)
})

describe("normalizePersistedPluginStatus", () => {
  // Only `installed` / `disabled` are recoverable by the
  // rehydrate → rediscover → activate path. Persisting any transient or error
  // status verbatim leaves a built-in plugin permanently stuck after restart
  // ("cannot be loaded from status: error"). User-disabled intent is preserved;
  // everything else collapses to `installed`.
  it("preserves the explicit user-disabled resting state", () => {
    expect(normalizePersistedPluginStatus("disabled")).toBe("disabled")
  })

  it("keeps an already-installed plugin installed", () => {
    expect(normalizePersistedPluginStatus("installed")).toBe("installed")
  })

  it("collapses the error status to installed so the plugin can recover", () => {
    expect(normalizePersistedPluginStatus("error")).toBe("installed")
  })

  it.each<PluginStatus>([
    "discovered",
    "loading",
    "loaded",
    "enabling",
    "enabled",
    "disabling",
    "suspended",
    "unloading",
    "updating",
  ])("collapses the transient %s status to installed", (status) => {
    expect(normalizePersistedPluginStatus(status)).toBe("installed")
  })
})

describe("persist migration (v1 -> v2)", () => {
  // Regression: a built-in plugin persisted in `status: "error"` by an older
  // build could never recover — every restart re-threw
  // "cannot be loaded from status: error". The v2 migration heals it back to a
  // loadable resting state on rehydrate.
  it("heals a non-recoverable persisted status on rehydrate", async () => {
    window.localStorage.setItem(
      "cognia-plugins",
      JSON.stringify({
        version: 1,
        state: {
          plugins: {
            "cognia-clipboard-tools": {
              manifest: { id: "cognia-clipboard-tools", name: "Clipboard Tools" },
              status: "error",
              source: "builtin",
              path: "builtin://cognia-clipboard-tools",
              config: {},
            },
            "user-disabled-plugin": {
              manifest: { id: "user-disabled-plugin", name: "Disabled" },
              status: "disabled",
              source: "local",
              path: "/tmp/disabled",
              config: {},
            },
          },
        },
      })
    )

    await usePluginStore.persist.rehydrate()

    const plugins = usePluginStore.getState().plugins
    expect(plugins["cognia-clipboard-tools"].status).toBe("installed")
    // User-disabled intent must be preserved through the migration.
    expect(plugins["user-disabled-plugin"].status).toBe("disabled")

    window.localStorage.clear()
  })
})

describe("LocalProfile persistence", () => {
  afterEach(() => {
    clearPluginAccountStorage()
    window.localStorage.clear()
  })

  it("does not carry remembered permissions between accounts", () => {
    window.localStorage.setItem(
      pluginAccountStorageKey("acct_a"),
      JSON.stringify({ version: 2, state: { rememberedPermissions: { demo: { shell: "allow" } } } })
    )
    window.localStorage.setItem(
      pluginAccountStorageKey("acct_b"),
      JSON.stringify({ version: 2, state: { rememberedPermissions: {} } })
    )

    activatePluginAccountStorage("acct_a")
    expect(usePluginStore.getState().rememberedPermissions.demo).toBeDefined()
    activatePluginAccountStorage("acct_b")
    expect(usePluginStore.getState().rememberedPermissions.demo).toBeUndefined()
  })

  it("revokes global grants and disables third-party plugins during legacy adoption", () => {
    window.localStorage.setItem(
      "cognia-plugins",
      JSON.stringify({
        version: 2,
        state: {
          rememberedPermissions: { demo: { "shell:execute": "allow" } },
          plugins: {
            builtin: { manifest: { id: "builtin" }, source: "builtin", status: "enabled" },
            demo: { manifest: { id: "demo" }, source: "local", status: "enabled" },
          },
        },
      })
    )

    activatePluginAccountStorage("acct_a")

    expect(usePluginStore.getState().rememberedPermissions).toEqual({})
    expect(usePluginStore.getState().plugins.builtin.status).toBe("installed")
    expect(usePluginStore.getState().plugins.demo.status).toBe("disabled")
    expect(window.localStorage.getItem("cognia-plugins")).toBeNull()
  })
})

describe("usePluginStore", () => {
  it("exposes getAllModes() returning an empty list (stub)", () => {
    const fn = usePluginStore.getState().getAllModes
    expect(typeof fn).toBe("function")
    expect(fn()).toEqual([])
  })

  it("returns the same empty array shape on repeated calls", () => {
    const first = usePluginStore.getState().getAllModes()
    const second = usePluginStore.getState().getAllModes()
    expect(first).toEqual([])
    expect(second).toEqual([])
  })

  it("initialize() hydrates the persisted policy into the runtime", async () => {
    applyPolicyMock.mockClear()
    window.localStorage.setItem(
      "cognia.plugins.policy",
      JSON.stringify({ governance: "block", signatureRequired: true, autoUpdate: true })
    )

    await usePluginStore.getState().initialize("/tmp/plugins")

    expect(applyPolicyMock).toHaveBeenCalledWith({
      governance: "block",
      signatureRequired: true,
      autoUpdate: true,
    })

    window.localStorage.clear()
  })

  it("initialize() defaults policy flags when localStorage has no blob", async () => {
    applyPolicyMock.mockClear()
    window.localStorage.clear()

    await usePluginStore.getState().initialize("/tmp/plugins")

    // ADR 0016 P0-3: signatureRequired is default-on; autoUpdate stays off.
    expect(applyPolicyMock).toHaveBeenCalledWith({
      governance: "warn",
      signatureRequired: true,
      autoUpdate: false,
    })
  })
})
