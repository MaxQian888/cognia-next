/**
 * @jest-environment jsdom
 */
import {
  mergeEndpointsIntoConfig,
  refreshCompanionEndpoints,
  type CompanionEndpoints,
} from "./endpoint-refresh"
import type { CompanionConfig } from "@/lib/tauri/companion-storage"

// The module reaches for the live transport only on the default path; every
// test injects `callImpl`. Mocked so the jsdom suite doesn't pull the whole
// `@/lib/tauri` barrel (and its Tauri/Capacitor probes) into the graph.
jest.mock("@/lib/tauri", () => ({
  transport: { call: jest.fn() },
}))

function config(patch: Partial<CompanionConfig> = {}): CompanionConfig {
  return {
    baseUrl: "https://192.168.1.42:27890",
    deviceJwt: "jwt",
    deviceId: "dev-1",
    serverVersion: "0.2.0",
    ...patch,
  }
}

function endpoints(patch: Partial<CompanionEndpoints> = {}): CompanionEndpoints {
  return {
    lanBaseUrl: "https://192.168.1.42:27890",
    tunnelBaseUrl: "https://calm-rock.trycloudflare.com",
    fingerprint: "abc123",
    serverId: "server-1",
    ...patch,
  }
}

describe("mergeEndpointsIntoConfig", () => {
  it("caches both channel addresses on a config that had neither", () => {
    const next = mergeEndpointsIntoConfig(config({ serverFingerprint: "abc123" }), endpoints())
    expect(next).not.toBeNull()
    expect(next!.lanBaseUrl).toBe("https://192.168.1.42:27890")
    expect(next!.tunnelBaseUrl).toBe("https://calm-rock.trycloudflare.com")
  })

  it("backfills the TLS pin when the pairing carried none (tunnel-paired device)", () => {
    // A tunnel pairing yields an empty `fingerprint` in the QR payload because
    // Cloudflare terminates TLS. Without this backfill `resolveLanBaseUrl`
    // refuses every LAN hit and the device can never leave the tunnel.
    const next = mergeEndpointsIntoConfig(
      config({ baseUrl: "https://calm-rock.trycloudflare.com", serverFingerprint: undefined }),
      endpoints()
    )
    expect(next!.serverFingerprint).toBe("abc123")
  })

  it("never overwrites an existing pin", () => {
    const next = mergeEndpointsIntoConfig(
      config({ serverFingerprint: "pinned-at-pair-time" }),
      endpoints({ fingerprint: "rotated" })
    )
    // Only the channel URLs changed; the pin is immovable by design.
    expect(next!.serverFingerprint).toBe("pinned-at-pair-time")
  })

  it("does not invent a pin when the server reports an empty fingerprint", () => {
    // TLS not yet initialised on the desktop. The tunnel URL still lands, but
    // an empty fingerprint must never be persisted as a pin — `lan-resolver`
    // treats any stored pin as authoritative, and "" would match nothing.
    const next = mergeEndpointsIntoConfig(
      config({ serverFingerprint: undefined, lanBaseUrl: "https://192.168.1.42:27890" }),
      endpoints({ fingerprint: "" })
    )
    expect(next).not.toBeNull()
    expect(next!.tunnelBaseUrl).toBe("https://calm-rock.trycloudflare.com")
    expect(next!.serverFingerprint).toBeUndefined()
  })

  it("clears a channel the desktop no longer exposes", () => {
    // A quick tunnel's hostname is regenerated on every cloudflared restart, so
    // retaining a dead one only adds a guaranteed-failing probe to each sweep.
    const next = mergeEndpointsIntoConfig(
      config({
        serverFingerprint: "abc123",
        lanBaseUrl: "https://192.168.1.42:27890",
        tunnelBaseUrl: "https://stale.trycloudflare.com",
      }),
      endpoints({ tunnelBaseUrl: null })
    )
    expect(next).not.toBeNull()
    expect("tunnelBaseUrl" in next!).toBe(false)
  })

  it("normalises trailing slashes so a no-op refresh stays a no-op", () => {
    const base = config({
      serverFingerprint: "abc123",
      lanBaseUrl: "https://192.168.1.42:27890",
      tunnelBaseUrl: "https://calm-rock.trycloudflare.com",
    })
    expect(
      mergeEndpointsIntoConfig(
        base,
        endpoints({ tunnelBaseUrl: "https://calm-rock.trycloudflare.com/" })
      )
    ).toBeNull()
  })

  it("returns null when nothing changed", () => {
    const base = config({
      serverFingerprint: "abc123",
      lanBaseUrl: "https://192.168.1.42:27890",
      tunnelBaseUrl: "https://calm-rock.trycloudflare.com",
    })
    expect(mergeEndpointsIntoConfig(base, endpoints())).toBeNull()
  })
})

describe("refreshCompanionEndpoints", () => {
  it("returns null when there is no pairing to refresh", async () => {
    const call = jest.fn()
    const out = await refreshCompanionEndpoints({
      callImpl: call,
      loadConfigImpl: () => null,
      saveConfigImpl: jest.fn(),
    })
    expect(out).toBeNull()
    expect(call).not.toHaveBeenCalled()
  })

  it("persists the refreshed inventory", async () => {
    const save = jest.fn().mockResolvedValue(undefined)
    const stored = config({ serverFingerprint: "abc123" })
    const out = await refreshCompanionEndpoints({
      callImpl: async () => endpoints() as never,
      loadConfigImpl: () => stored,
      saveConfigImpl: save,
    })
    expect(save).toHaveBeenCalledTimes(1)
    expect(out!.tunnelBaseUrl).toBe("https://calm-rock.trycloudflare.com")
  })

  it("skips the write when the inventory is unchanged", async () => {
    const save = jest.fn()
    const stored = config({
      serverFingerprint: "abc123",
      lanBaseUrl: "https://192.168.1.42:27890",
      tunnelBaseUrl: "https://calm-rock.trycloudflare.com",
    })
    const out = await refreshCompanionEndpoints({
      callImpl: async () => endpoints() as never,
      loadConfigImpl: () => stored,
      saveConfigImpl: save,
    })
    expect(save).not.toHaveBeenCalled()
    expect(out).toBe(stored)
  })

  it("keeps the existing config when the RPC fails (offline / older desktop)", async () => {
    const stored = config()
    const out = await refreshCompanionEndpoints({
      callImpl: async () => {
        throw new Error("unknown_command")
      },
      loadConfigImpl: () => stored,
      saveConfigImpl: jest.fn(),
    })
    expect(out).toBe(stored)
  })

  it("ignores a malformed response body", async () => {
    const save = jest.fn()
    const stored = config()
    const out = await refreshCompanionEndpoints({
      callImpl: async () => ({ lanBaseUrl: 42 }) as never,
      loadConfigImpl: () => stored,
      saveConfigImpl: save,
    })
    expect(save).not.toHaveBeenCalled()
    expect(out).toBe(stored)
  })

  it("re-reads the config after the await so a concurrent LAN repoint is not undone", async () => {
    // The LAN re-resolver runs on the same triggers as this refresh and writes
    // `baseUrl`. Merging onto the pre-await snapshot would roll that back.
    const before = config({ baseUrl: "https://old.example:27890", serverFingerprint: "abc123" })
    const after = config({ baseUrl: "https://192.168.1.9:27890", serverFingerprint: "abc123" })
    let reads = 0
    const save = jest.fn().mockResolvedValue(undefined)
    const out = await refreshCompanionEndpoints({
      callImpl: async () => endpoints() as never,
      loadConfigImpl: () => (reads++ === 0 ? before : after),
      saveConfigImpl: save,
    })
    expect(out!.baseUrl).toBe("https://192.168.1.9:27890")
    expect(save.mock.calls[0][0].baseUrl).toBe("https://192.168.1.9:27890")
  })

  it("still reports the merged config when persisting throws", async () => {
    const out = await refreshCompanionEndpoints({
      callImpl: async () => endpoints() as never,
      loadConfigImpl: () => config({ serverFingerprint: "abc123" }),
      saveConfigImpl: async () => {
        throw new Error("keychain locked")
      },
    })
    expect(out!.tunnelBaseUrl).toBe("https://calm-rock.trycloudflare.com")
  })

  it.each([
    ["null", null],
    ["an array", []],
    ["a scalar", "nope"],
    ["a body with no fingerprint", { lanBaseUrl: "https://x", serverId: "s" }],
    ["a body with no serverId", { lanBaseUrl: "https://x", fingerprint: "fp" }],
  ])("rejects %s as a malformed response", async (_label, body) => {
    const save = jest.fn()
    const stored = config()
    const out = await refreshCompanionEndpoints({
      callImpl: async () => body as never,
      loadConfigImpl: () => stored,
      saveConfigImpl: save,
    })
    expect(save).not.toHaveBeenCalled()
    expect(out).toBe(stored)
  })

  it("treats a non-string channel address as absent rather than crashing", async () => {
    const save = jest.fn().mockResolvedValue(undefined)
    const stored = config({
      serverFingerprint: "abc123",
      lanBaseUrl: "https://192.168.1.42:27890",
      tunnelBaseUrl: "https://calm-rock.trycloudflare.com",
    })
    const out = await refreshCompanionEndpoints({
      callImpl: async () =>
        ({ lanBaseUrl: 42, tunnelBaseUrl: false, fingerprint: "abc123", serverId: "s" }) as never,
      loadConfigImpl: () => stored,
      saveConfigImpl: save,
    })
    expect("lanBaseUrl" in out!).toBe(false)
    expect("tunnelBaseUrl" in out!).toBe(false)
  })

  it("drops a channel the desktop reports as an empty string", async () => {
    const out = await refreshCompanionEndpoints({
      callImpl: async () => endpoints({ tunnelBaseUrl: "   " }) as never,
      loadConfigImpl: () =>
        config({ serverFingerprint: "abc123", tunnelBaseUrl: "https://stale.example" }),
      saveConfigImpl: jest.fn().mockResolvedValue(undefined),
    })
    expect("tunnelBaseUrl" in out!).toBe(false)
  })

  it("keeps the pre-await snapshot when the config vanished mid-refresh", async () => {
    // Unpairing between the call and its response: fall back to the snapshot
    // rather than dereferencing null.
    let reads = 0
    const out = await refreshCompanionEndpoints({
      callImpl: async () => endpoints() as never,
      loadConfigImpl: () => (reads++ === 0 ? config({ serverFingerprint: "abc123" }) : null),
      saveConfigImpl: jest.fn().mockResolvedValue(undefined),
    })
    expect(out!.tunnelBaseUrl).toBe("https://calm-rock.trycloudflare.com")
  })

  it("reads and writes the real companion config when no storage seams are injected", async () => {
    const { saveCompanionConfig, loadCompanionConfig, __resetCompanionConfigCacheForTests } =
      jest.requireActual<typeof import("@/lib/tauri/transport-companion")>(
        "@/lib/tauri/transport-companion"
      )
    __resetCompanionConfigCacheForTests()
    localStorage.clear()
    await saveCompanionConfig(config({ serverFingerprint: "abc123" }))

    await refreshCompanionEndpoints({ callImpl: async () => endpoints() as never })

    expect(loadCompanionConfig()!.tunnelBaseUrl).toBe("https://calm-rock.trycloudflare.com")
    __resetCompanionConfigCacheForTests()
    localStorage.clear()
  })

  it("falls back to the live transport when no call seam is injected", async () => {
    const { transport } = jest.requireMock("@/lib/tauri") as {
      transport: { call: jest.Mock }
    }
    transport.call.mockResolvedValue(endpoints())
    const save = jest.fn().mockResolvedValue(undefined)
    await refreshCompanionEndpoints({
      loadConfigImpl: () => config({ serverFingerprint: "abc123" }),
      saveConfigImpl: save,
    })
    expect(transport.call).toHaveBeenCalledWith("companion_endpoints", {})
    expect(save).toHaveBeenCalledTimes(1)
  })
})
