import React from "react"
import { createModalAPI } from "./modal-api"
import { usePluginModalStore } from "@/stores/plugin-runtime/plugin-modal-store"

const FakeModal: React.FC<{ onClose: () => void }> = ({ onClose }) =>
  React.createElement("button", { onClick: onClose }, "Close")

describe("createModalAPI", () => {
  beforeEach(() => {
    usePluginModalStore.setState({ stack: [] })
  })

  it("opens a modal and pushes it onto the stack", () => {
    const api = createModalAPI("p")
    const handle = api.openModal(FakeModal as never)
    expect(handle.modalId).toMatch(/^modal_/)
    expect(usePluginModalStore.getState().stack).toHaveLength(1)
    expect(usePluginModalStore.getState().stack[0]!.pluginId).toBe("p")
  })

  it("supports stacking multiple modals from one plugin", () => {
    const api = createModalAPI("p")
    api.openModal(FakeModal as never)
    api.openModal(FakeModal as never)
    expect(usePluginModalStore.getState().stack).toHaveLength(2)
  })

  it("close() pops the right entry without disturbing others", () => {
    const api = createModalAPI("p")
    const a = api.openModal(FakeModal as never)
    const b = api.openModal(FakeModal as never)
    a.close()
    expect(usePluginModalStore.getState().stack.map((e) => e.modalId)).toEqual([b.modalId])
  })

  it("close() is idempotent", () => {
    const api = createModalAPI("p")
    const handle = api.openModal(FakeModal as never)
    handle.close()
    expect(() => handle.close()).not.toThrow()
  })

  it("closeAll() drops every modal owned by this plugin only", () => {
    createModalAPI("p").openModal(FakeModal as never)
    createModalAPI("q").openModal(FakeModal as never)
    createModalAPI("p").openModal(FakeModal as never)
    createModalAPI("p").closeAll()
    const remaining = usePluginModalStore.getState().stack
    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.pluginId).toBe("q")
  })

  it("attaches the supplied args to the stack entry", () => {
    const api = createModalAPI("p")
    api.openModal(FakeModal as never, { foo: "bar" })
    expect(usePluginModalStore.getState().stack[0]!.args).toEqual({ foo: "bar" })
  })
})
