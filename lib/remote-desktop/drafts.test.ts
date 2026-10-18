import {
  consoleEndpointOf,
  consoleLinkProblem,
  EMPTY_FORM_EXTRAS,
  endpointChanged,
  endpointOf,
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
    access: "bridge",
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
  ...EMPTY_FORM_EXTRAS,
  name: " New ",
  providerId: "cognia-remote-desktop-vnc.vnc",
  access: "bridge",
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
          access: "bridge",
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
    expect(endpointChanged(target.bindings[0], null)).toBe(false)
    expect(endpointChanged(target.bindings[0], { host: "nas.local", port: 5901 })).toBe(true)
    expect(endpointChanged(undefined, { host: "nas.local", port: 5900 })).toBe(true)
    expect(primaryBindingOf(target)?.id).toBe("a")
    const disabledFirst = {
      ...target,
      bindings: [binding("a", { enabled: false }), target.bindings[1]!],
    }
    expect(primaryBindingOf(disabledFirst)?.id).toBe("b")
  })

  it("drafts a web console from its link and an app from its ID, with no host or port", () => {
    const consoleForm: RemoteDesktopForm = {
      ...form,
      access: "web-console",
      providerId: "cognia-remote-desktop-web-console.guacamole",
      consoleUrl: " https://gw.lan:8443/guacamole/#/client/abc ",
      consoleProfile: "guacamole",
    }
    expect(targetDraftOf(consoleForm).bindings[0]).toEqual({
      providerId: "cognia-remote-desktop-web-console.guacamole",
      access: "web-console",
      adapter: "none",
      enabled: true,
      viewOnly: false,
      confirm: true,
      console: { url: "https://gw.lan:8443/guacamole/#/client/abc", profile: "guacamole" },
    })
    expect(endpointOf(consoleForm)).toEqual({ host: "gw.lan", port: 8443 })
    const appForm: RemoteDesktopForm = {
      ...form,
      access: "external-app",
      peerId: "123 456 789",
      server: " rd.lan ",
      key: "",
    }
    expect(targetDraftOf(appForm).bindings[0]).toMatchObject({
      access: "external-app",
      adapter: "none",
      confirm: false,
      launch: { launcher: "rustdesk", peerId: "123456789", server: "rd.lan" },
    })
    expect(targetDraftOf(appForm).bindings[0]).not.toHaveProperty("host")
    expect(endpointOf(appForm)).toBeNull()
  })

  it("passes other access kinds back in their own shape", () => {
    const mixed: RemoteDesktopTarget = {
      ...target,
      bindings: [
        binding("vnc"),
        binding("gw", {
          access: "web-console",
          adapter: "none",
          console: { url: "https://gw.lan/#/client/x", profile: "guacamole" },
        }),
        binding("rd", {
          access: "external-app",
          adapter: "none",
          endpoint: null,
          launch: { launcher: "rustdesk", peerId: "123456789", key: "k=" },
        }),
      ],
    }
    const draft = targetDraftOf({ ...formOf(mixed, mixed.bindings[0]!) }, mixed, "vnc")
    expect(draft.bindings[1]).toMatchObject({
      access: "web-console",
      console: { url: "https://gw.lan/#/client/x", profile: "guacamole" },
    })
    expect(draft.bindings[1]).not.toHaveProperty("host")
    expect(draft.bindings[2]).toMatchObject({
      access: "external-app",
      launch: { launcher: "rustdesk", peerId: "123456789", key: "k=" },
    })
    expect(formOf(mixed, mixed.bindings[2]!)).toMatchObject({ access: "external-app", host: "" })
  })

  it("reads console links the way the Host pins and checks them", () => {
    expect(consoleEndpointOf("http://[fd00::5]/x")).toEqual({ host: "fd00::5", port: 80 })
    expect(consoleEndpointOf("https://gw.lan")).toEqual({ host: "gw.lan", port: 443 })
    expect(consoleEndpointOf("ftp://gw.lan")).toBeNull()
    expect(consoleLinkProblem("https://gw.lan/#/client/abc", "guacamole")).toBeNull()
    expect(consoleLinkProblem("https://gw.lan/guacamole/", "guacamole")).toBe(
      "remote_desktop_console_url_invalid"
    )
    expect(consoleLinkProblem("https://mesh.lan/?gotonode=n", "meshcentral")).toBeNull()
    expect(consoleLinkProblem("https://mesh.lan/", "meshcentral")).toBe(
      "remote_desktop_console_url_invalid"
    )
    expect(consoleLinkProblem("https://u:p@gw.lan/", "generic")).toBe(
      "remote_desktop_console_url_has_credentials"
    )
  })
})
