import {
  endpointChanged,
  formOf,
  primaryBindingOf,
  savedBindingOf,
  targetDraftOf,
  type RemoteDesktopForm,
} from "./drafts"
import type { RemoteDesktopBinding, RemoteDesktopTarget } from "./types"

function binding(id: string, overrides: Partial<RemoteDesktopBinding> = {}): RemoteDesktopBinding {
  return {
    id,
    providerId: "cognia-remote-desktop-vnc.vnc",
    adapter: "vnc",
    priority: 0,
    enabled: true,
    endpoint: {
      host: "nas.local",
      port: 5900,
      pinnedIp: "192.168.1.20",
      class: "private",
      confirmedAt: 1,
    },
    viewOnly: false,
    config: { quality: 6 },
    hasControlCredential: true,
    hasViewCredential: false,
    ...overrides,
  }
}

const target: RemoteDesktopTarget = {
  id: "t",
  name: "Studio",
  bindings: [
    binding("a"),
    binding("b", {
      priority: 1,
      endpoint: {
        host: "10.0.0.2",
        port: 5901,
        pinnedIp: "10.0.0.2",
        class: "private",
        confirmedAt: 1,
      },
    }),
  ],
  createdAt: 1,
  updatedAt: 1,
}

const form: RemoteDesktopForm = {
  name: " New ",
  providerId: "cognia-remote-desktop-vnc.vnc",
  adapter: "vnc",
  host: " pi.local ",
  port: 5900,
  viewOnly: true,
  enabled: true,
  confirm: true,
}

describe("remote desktop drafts", () => {
  it("creates a one-binding target from the form", () => {
    expect(targetDraftOf(form)).toEqual({
      name: "New",
      bindings: [
        {
          providerId: "cognia-remote-desktop-vnc.vnc",
          adapter: "vnc",
          enabled: true,
          host: "pi.local",
          port: 5900,
          viewOnly: true,
          confirm: true,
        },
      ],
    })
    // A server without authentication can never be view-only.
    expect(targetDraftOf({ ...form, adapter: "none" }).bindings[0]?.viewOnly).toBe(false)
  })

  it("edits one binding in place and passes the others back unchanged", () => {
    const draft = targetDraftOf(
      { ...formOf(target, target.bindings[1]!), name: "Renamed" },
      target,
      "b"
    )
    expect(draft.id).toBe("t")
    expect(draft.name).toBe("Renamed")
    expect(draft.bindings.map((entry) => entry.id)).toEqual(["a", "b"])
    expect(draft.bindings[0]).toMatchObject({
      id: "a",
      host: "nas.local",
      confirm: false,
      config: { quality: 6 },
    })
    expect(draft.bindings[1]).toMatchObject({ id: "b", host: "10.0.0.2", port: 5901, priority: 1 })
  })

  it("appends a new binding to an existing target", () => {
    const draft = targetDraftOf(form, target)
    expect(draft.bindings.map((entry) => entry.id)).toEqual(["a", "b", undefined])
  })

  it("finds the binding a save produced", () => {
    const saved = { ...target, bindings: [...target.bindings, binding("c")] }
    expect(savedBindingOf(saved, target, undefined)?.id).toBe("c")
    expect(savedBindingOf(saved, target, "b")?.id).toBe("b")
    expect(savedBindingOf(target, undefined, undefined)?.id).toBe("a")
  })

  it("notices a changed address and picks the primary binding", () => {
    expect(endpointChanged(target.bindings[0], { host: " nas.local ", port: 5900 })).toBe(false)
    expect(endpointChanged(target.bindings[0], { host: "nas.local", port: 5901 })).toBe(true)
    expect(endpointChanged(undefined, { host: "nas.local", port: 5900 })).toBe(true)
    expect(primaryBindingOf(target)?.id).toBe("a")
    const disabledFirst = {
      ...target,
      bindings: [binding("a", { enabled: false }), target.bindings[1]!],
    }
    expect(primaryBindingOf(disabledFirst)?.id).toBe("b")
  })
})
