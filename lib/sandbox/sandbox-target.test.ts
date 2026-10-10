import type { SandboxProviderView } from "@/types/sandbox/remote-sandboxes"

import { chooseSandboxTarget } from "./sandbox-target"

function provider(id: string, overrides: Partial<SandboxProviderView> = {}): SandboxProviderView {
  return {
    id,
    driver: id === "local" ? "docker" : "e2b",
    remote: id !== "local",
    isDefault: false,
    reachable: true,
    availableTiers: ["container"],
    ...overrides,
  }
}

describe("chooseSandboxTarget", () => {
  it("places on the only driver of a Host that lists no providers", () => {
    expect(chooseSandboxTarget({ target: undefined, providers: [], minimum: "vm" })).toEqual({
      kind: "local",
      reason: "only-driver",
    })
    expect(
      chooseSandboxTarget({ target: { kind: "local" }, providers: [], minimum: "container" })
    ).toEqual({ kind: "local", reason: "only-driver" })
    expect(
      chooseSandboxTarget({
        target: { kind: "provider", providerId: "cloud" },
        providers: [],
        minimum: "container",
      })
    ).toEqual({
      kind: "unavailable",
      code: "sandbox_provider_unknown",
      detail: { providerId: "cloud" },
    })
  })

  it("auto prefers a local driver that attests the tier, else the default remote", () => {
    const providers = [
      provider("local"),
      provider("cloud", { isDefault: true, availableTiers: ["vm"] }),
    ]
    expect(chooseSandboxTarget({ target: undefined, providers, minimum: "container" })).toEqual({
      kind: "local",
      reason: "attests-tier",
    })
    expect(chooseSandboxTarget({ target: { kind: "auto" }, providers, minimum: "gvisor" })).toEqual(
      { kind: "remote", providerId: "cloud", reason: "default-provider" }
    )
  })

  it("auto is unavailable when nothing reachable attests the tier", () => {
    const providers = [
      provider("local", { reachable: false }),
      provider("cloud", { isDefault: true, reachable: false, availableTiers: [] }),
      provider("other", { availableTiers: ["vm"] }),
    ]
    expect(chooseSandboxTarget({ target: undefined, providers, minimum: "container" })).toEqual({
      kind: "unavailable",
      code: "sandbox_provider_unavailable",
      detail: { tier: "container" },
    })
  })

  it("a named provider is that provider or a refusal, never another", () => {
    const providers = [provider("local"), provider("cloud", { isDefault: true })]
    expect(
      chooseSandboxTarget({
        target: { kind: "provider", providerId: "cloud" },
        providers,
        minimum: "vm",
      })
    ).toEqual({ kind: "remote", providerId: "cloud", reason: "requested" })
    expect(
      chooseSandboxTarget({
        target: { kind: "provider", providerId: "gone" },
        providers,
        minimum: "container",
      })
    ).toMatchObject({ kind: "unavailable", code: "sandbox_provider_unknown" })
  })

  it("local is refused on a remote-only Host", () => {
    expect(
      chooseSandboxTarget({
        target: { kind: "local" },
        providers: [provider("cloud", { isDefault: true })],
        minimum: "container",
      })
    ).toEqual({
      kind: "unavailable",
      code: "sandbox_provider_unknown",
      detail: { providerId: "local" },
    })
  })
})
