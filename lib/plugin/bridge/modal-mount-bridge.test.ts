import { registerModalMountsForPlugin, unregisterModalMountsForPlugin } from "./modal-mount-bridge"
import {
  getDeclaredModal,
  listDeclaredModals,
  openDeclaredModal,
  usePluginModalStore,
  __resetDeclaredModalsForTesting,
} from "@/stores/plugin-runtime/plugin-modal-store"
import { createModalAPI } from "@/lib/plugin/api/modal-api"
import type { PluginManifest } from "@/types/plugin/plugin"
import type { PluginModalComponent } from "@/types/plugin/plugin-modal"

const Modal: PluginModalComponent = () => null

function manifest(modalMounts: PluginManifest["modalMounts"]): PluginManifest {
  return { id: "demo", modalMounts } as PluginManifest
}

beforeEach(() => {
  __resetDeclaredModalsForTesting()
  usePluginModalStore.getState().closeAll()
})

describe("modal-mount-bridge", () => {
  it("registers declared modals from the manifest", async () => {
    await registerModalMountsForPlugin(
      manifest([{ id: "wizard", label: "Wizard", entry: "dist/m.js", export: "Modal" }]),
      "/p/demo",
      { importer: async () => ({ Modal }) }
    )
    expect(listDeclaredModals()).toHaveLength(1)
    expect(getDeclaredModal("demo", "wizard")?.label).toBe("Wizard")
  })

  it("skips malformed entries (missing id/entry/export)", async () => {
    await registerModalMountsForPlugin(
      manifest([{ id: "", label: "x", entry: "", export: "" } as never]),
      "/p/demo",
      { importer: async () => ({ Modal }) }
    )
    expect(listDeclaredModals()).toHaveLength(0)
  })

  it("openDeclaredModal lazily resolves the component and pushes it on the stack", async () => {
    const importer = jest.fn(async () => ({ Modal }))
    await registerModalMountsForPlugin(
      manifest([{ id: "wizard", label: "Wizard", entry: "dist/m.js", export: "Modal" }]),
      "/p/demo",
      { importer }
    )
    expect(importer).not.toHaveBeenCalled() // lazy — not imported at register time
    const id = await openDeclaredModal("demo", "wizard", { step: 1 })
    expect(importer).toHaveBeenCalledTimes(1)
    expect(id).toMatch(/^modal_/)
    expect(usePluginModalStore.getState().stack).toHaveLength(1)
    expect(usePluginModalStore.getState().stack[0].args).toEqual({ step: 1 })
  })

  it("openDeclaredModal returns null for an unknown id", async () => {
    expect(await openDeclaredModal("demo", "nope")).toBeNull()
  })

  it("openDeclaredModal returns null when the export is not a component", async () => {
    await registerModalMountsForPlugin(
      manifest([{ id: "wizard", label: "Wizard", entry: "dist/m.js", export: "NotThere" }]),
      "/p/demo",
      { importer: async () => ({ Modal }) }
    )
    expect(await openDeclaredModal("demo", "wizard")).toBeNull()
  })

  it("unregister drops every declared modal for the plugin", async () => {
    await registerModalMountsForPlugin(
      manifest([{ id: "wizard", label: "Wizard", entry: "dist/m.js", export: "Modal" }]),
      "/p/demo",
      { importer: async () => ({ Modal }) }
    )
    unregisterModalMountsForPlugin("demo")
    expect(listDeclaredModals()).toHaveLength(0)
  })

  it("ctx.modal.openById opens a declared modal and returns a closable handle", async () => {
    await registerModalMountsForPlugin(
      manifest([{ id: "wizard", label: "Wizard", entry: "dist/m.js", export: "Modal" }]),
      "/p/demo",
      { importer: async () => ({ Modal }) }
    )
    const api = createModalAPI("demo")
    const handle = await api.openById("wizard")
    expect(handle).not.toBeNull()
    expect(usePluginModalStore.getState().stack).toHaveLength(1)
    handle!.close()
    expect(usePluginModalStore.getState().stack).toHaveLength(0)

    expect(await api.openById("missing")).toBeNull()
  })
})
