/**
 * Tests for the plugin modal stack + declarative modal registry.
 *
 * The store was previously covered only indirectly (through `modal-api` and
 * `<PluginModalRoot />`); the presentation-options merge it now performs is a
 * decision of its own, so it gets direct coverage here.
 */

import type React from "react"
import {
  clearModalsForPlugin,
  getDeclaredModal,
  listDeclaredModals,
  openDeclaredModal,
  registerDeclaredModal,
  selectAllModals,
  selectTopModal,
  subscribeDeclaredModals,
  unregisterDeclaredModalsForPlugin,
  usePluginModalStore,
  __resetDeclaredModalsForTesting,
} from "./plugin-modal-store"
import type { PluginModalComponent } from "@/types/plugin/plugin-modal"

const Modal: PluginModalComponent = () => null
const Other: PluginModalComponent = () => null

beforeEach(() => {
  usePluginModalStore.setState({ stack: [] })
  __resetDeclaredModalsForTesting()
})

describe("usePluginModalStore — imperative stack", () => {
  it("open() returns a prefixed id and records the entry", () => {
    const modalId = usePluginModalStore
      .getState()
      .open({ pluginId: "p", component: Modal, args: { a: 1 } })
    expect(modalId).toMatch(/^modal_/)
    const [entry] = usePluginModalStore.getState().stack
    expect(entry).toMatchObject({ modalId, pluginId: "p", component: Modal, args: { a: 1 } })
    expect(entry!.options).toBeUndefined()
    expect(typeof entry!.openedAt).toBe("number")
  })

  it("carries presentation options onto the entry verbatim", () => {
    usePluginModalStore
      .getState()
      .open({ pluginId: "p", component: Modal, options: { size: "lg", variant: "sheet-right" } })
    expect(usePluginModalStore.getState().stack[0]!.options).toEqual({
      size: "lg",
      variant: "sheet-right",
    })
  })

  it("close() removes one entry and is a no-op for an unknown id", () => {
    const first = usePluginModalStore.getState().open({ pluginId: "p", component: Modal })
    const second = usePluginModalStore.getState().open({ pluginId: "p", component: Other })
    usePluginModalStore.getState().close(first)
    expect(usePluginModalStore.getState().stack.map((e) => e.modalId)).toEqual([second])
    usePluginModalStore.getState().close("modal_nope")
    expect(usePluginModalStore.getState().stack).toHaveLength(1)
  })

  it("closeAll() empties the stack and short-circuits when already empty", () => {
    usePluginModalStore.getState().open({ pluginId: "p", component: Modal })
    const before = usePluginModalStore.getState().stack
    usePluginModalStore.getState().closeAll()
    expect(usePluginModalStore.getState().stack).toHaveLength(0)
    const emptied = usePluginModalStore.getState().stack
    usePluginModalStore.getState().closeAll()
    // Same array identity — the guard avoided a pointless set().
    expect(usePluginModalStore.getState().stack).toBe(emptied)
    expect(before).not.toBe(emptied)
  })

  it("clearModalsForPlugin drops only that plugin's modals", () => {
    usePluginModalStore.getState().open({ pluginId: "p", component: Modal })
    usePluginModalStore.getState().open({ pluginId: "q", component: Other })
    clearModalsForPlugin("p")
    expect(usePluginModalStore.getState().stack.map((e) => e.pluginId)).toEqual(["q"])
  })

  it("selectors expose the top entry and the whole stack", () => {
    expect(selectTopModal(usePluginModalStore.getState())).toBeUndefined()
    usePluginModalStore.getState().open({ pluginId: "p", component: Modal })
    const top = usePluginModalStore.getState().open({ pluginId: "p", component: Other })
    expect(selectTopModal(usePluginModalStore.getState())!.modalId).toBe(top)
    expect(selectAllModals(usePluginModalStore.getState())).toHaveLength(2)
  })
})

describe("declarative modal registry", () => {
  function declare(options?: { size?: "sm" | "md" | "lg" | "full" }) {
    registerDeclaredModal({
      pluginId: "demo",
      id: "wizard",
      label: "Wizard",
      options,
      load: async () => Modal,
    })
  }

  it("registers, reads back and replaces by <pluginId>:<id>", () => {
    declare()
    expect(getDeclaredModal("demo", "wizard")?.label).toBe("Wizard")
    registerDeclaredModal({
      pluginId: "demo",
      id: "wizard",
      label: "Wizard v2",
      load: async () => Modal,
    })
    expect(listDeclaredModals()).toHaveLength(1)
    expect(getDeclaredModal("demo", "wizard")?.label).toBe("Wizard v2")
  })

  it("notifies subscribers on register/unregister and survives a throwing listener", () => {
    const good = jest.fn()
    const unsubscribeBad = subscribeDeclaredModals(() => {
      throw new Error("listener boom")
    })
    const unsubscribeGood = subscribeDeclaredModals(good)
    expect(() => declare()).not.toThrow()
    expect(good).toHaveBeenCalledTimes(1)
    unsubscribeBad()
    unsubscribeGood()
    registerDeclaredModal({ pluginId: "demo", id: "b", label: "B", load: async () => Modal })
    expect(good).toHaveBeenCalledTimes(1)
  })

  it("unregisterDeclaredModalsForPlugin reports how many it dropped", () => {
    declare()
    registerDeclaredModal({ pluginId: "other", id: "x", label: "X", load: async () => Modal })
    expect(unregisterDeclaredModalsForPlugin("demo")).toBe(1)
    expect(unregisterDeclaredModalsForPlugin("demo")).toBe(0)
    expect(listDeclaredModals()).toHaveLength(1)
  })

  it("openDeclaredModal is null for an unknown id or a failed component load", async () => {
    expect(await openDeclaredModal("demo", "wizard")).toBeNull()
    registerDeclaredModal({
      pluginId: "demo",
      id: "broken",
      label: "Broken",
      load: async () => null,
    })
    expect(await openDeclaredModal("demo", "broken")).toBeNull()
  })

  it("leaves options unset when neither the manifest nor the call site declared any", async () => {
    declare()
    await openDeclaredModal("demo", "wizard")
    expect(usePluginModalStore.getState().stack[0]!.options).toBeUndefined()
  })

  it("uses the manifest-declared options when the call site passes none", async () => {
    declare({ size: "lg" })
    await openDeclaredModal("demo", "wizard")
    expect(usePluginModalStore.getState().stack[0]!.options).toEqual({
      size: "lg",
      variant: "center",
    })
  })

  it("lets the call site override the manifest field by field", async () => {
    registerDeclaredModal({
      pluginId: "demo",
      id: "wizard",
      label: "Wizard",
      options: { size: "sm", variant: "sheet-right" },
      load: async () => Modal,
    })
    await openDeclaredModal("demo", "wizard", undefined, { size: "full" })
    expect(usePluginModalStore.getState().stack[0]!.options).toEqual({
      size: "full",
      // The declared variant survives an override that only touched `size`.
      variant: "sheet-right",
    })
  })

  it("resolves the component lazily — not at registration time", async () => {
    const load = jest.fn(async () => Modal as React.ComponentType<never> as PluginModalComponent)
    registerDeclaredModal({ pluginId: "demo", id: "lazy", label: "Lazy", load })
    expect(load).not.toHaveBeenCalled()
    await openDeclaredModal("demo", "lazy")
    expect(load).toHaveBeenCalledTimes(1)
  })
})
