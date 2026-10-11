import type { RemoteHost } from "@/stores/remote-host/remote-host-store"

import { alwaysOnTarget } from "./always-on-target"

const host = (id: string, overrides: Partial<RemoteHost> = {}) =>
  ({ id, label: id, ...overrides }) as RemoteHost

describe("alwaysOnTarget", () => {
  it("is the first always-on host that answered its last check", () => {
    expect(
      alwaysOnTarget([
        host("driven"),
        host("asleep", { alwaysOn: true, lastProbe: { at: 1, ok: false, error: "timeout" } }),
        host("mini", { alwaysOn: true, lastProbe: { at: 1, ok: true } }),
        host("vps", { alwaysOn: true, lastProbe: { at: 1, ok: true } }),
      ])?.id
    ).toBe("mini")
  })

  it("is nobody when no always-on host is known to be up", () => {
    expect(alwaysOnTarget([host("a", { alwaysOn: true })])).toBeNull()
    expect(alwaysOnTarget([host("b", { lastProbe: { at: 1, ok: true } })])).toBeNull()
    expect(alwaysOnTarget([])).toBeNull()
  })
})
