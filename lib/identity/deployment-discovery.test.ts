import type { CompanionAuthConfig } from "@/lib/tauri/companion-auth"

import { discoverDeployment, resolveDiscoverySource } from "./deployment-discovery"
import { officialDeployment } from "./official-deployment"

jest.mock("@/lib/tauri", () => ({
  localTransport: { call: jest.fn() },
  transport: { call: jest.fn() },
}))

import { localTransport, transport } from "@/lib/tauri"

const MULTI: CompanionAuthConfig = {
  configVersion: 2,
  deploymentMode: "multi-tenant",
  oidc: {
    issuer: "https://logto.example/oidc",
    webClientId: "web",
    nativeClientId: "native",
    audience: "https://api.example",
    scopes: ["collab:read"],
    socialProviders: [{ provider: "github", directSignIn: "social:github" }],
  },
  collaboration: {
    serviceUrl: "https://collab.example",
    registrationPolicy: "bootstrap-then-invite",
    webOrigin: null,
  },
} as unknown as CompanionAuthConfig

describe("resolveDiscoverySource", () => {
  it("reads the local desktop server independently of the selected remote host", async () => {
    ;(localTransport.call as jest.Mock).mockResolvedValue({ running: true, boundPort: 7890 })
    await expect(
      resolveDiscoverySource({
        profile: "desktop",
        deploymentSource: () => null,
      })
    ).resolves.toEqual({ baseUrl: "https://127.0.0.1:7890", local: true })
    expect(localTransport.call).toHaveBeenCalledWith("companion_server_status", {})
    expect(transport.call).not.toHaveBeenCalled()
  })

  it("reports a failed source lookup without throwing or treating it as no host", async () => {
    const fetchConfig = jest.fn()
    await expect(
      discoverDeployment({
        profile: "desktop",
        deploymentSource: () => null,
        serverStatus: async () => {
          throw new Error("IPC unavailable")
        },
        fetchConfig,
      })
    ).resolves.toEqual({
      status: "unavailable",
      reason: "unreachable",
      baseUrl: null,
      message: "IPC unavailable",
    })
    expect(fetchConfig).not.toHaveBeenCalled()
  })
  it("asks the desktop's own server on its loopback port, or nothing when stopped", async () => {
    expect(
      await resolveDiscoverySource({
        profile: "desktop",
        serverStatus: async () => ({ running: true, boundPort: 7890 }),
      })
    ).toEqual({ baseUrl: "https://127.0.0.1:7890", local: true })
    expect(
      await resolveDiscoverySource({
        profile: "desktop",
        serverStatus: async () => ({ running: false, boundPort: null }),
      })
    ).toEqual({ none: "server-stopped" })
  })

  it("asks the paired host for a companion, carrying its fingerprint", async () => {
    expect(
      await resolveDiscoverySource({
        profile: "mobile-companion",
        companionConfig: () =>
          ({ baseUrl: "https://host.example:7890", serverFingerprint: "ab" }) as never,
      })
    ).toEqual({ baseUrl: "https://host.example:7890", fingerprint: "ab" })
    expect(
      await resolveDiscoverySource({
        profile: "cloud-companion",
        companionConfig: () => null,
        buildTimeUrl: () => "https://cloud.example",
      })
    ).toEqual({ baseUrl: "https://cloud.example" })
  })

  it("has nothing to ask on a standalone web build or a headless host", async () => {
    expect(
      await resolveDiscoverySource({
        profile: "web-standalone",
        buildTimeUrl: () => null,
        sameOrigin: () => null,
      })
    ).toEqual({ none: "no-host" })
    expect(await resolveDiscoverySource({ profile: "headless" })).toEqual({ none: "no-host" })
  })

  /** The desktop and the phone can only reach a cloud deployment this way. */
  it("asks the deployment the profile chose before anything the shell knows", async () => {
    const serverStatus = jest.fn()
    expect(
      await resolveDiscoverySource({
        profile: "desktop",
        serverStatus,
        deploymentSource: () => ({ baseUrl: "https://cloud.example", fingerprint: "cd" }),
      })
    ).toEqual({ baseUrl: "https://cloud.example", fingerprint: "cd" })
    expect(serverStatus).not.toHaveBeenCalled()
    expect(
      await resolveDiscoverySource({
        profile: "mobile-companion",
        companionConfig: () => ({ baseUrl: "https://paired.example" }) as never,
        deploymentSource: () => ({ baseUrl: "https://cloud.example" }),
      })
    ).toEqual({ baseUrl: "https://cloud.example" })
  })

  it("never asks a chosen deployment on a headless host, which is the host", async () => {
    expect(
      await resolveDiscoverySource({
        profile: "headless",
        deploymentSource: () => ({ baseUrl: "https://cloud.example" }),
      })
    ).toEqual({ none: "no-host" })
  })

  it("falls back to the build-time URL on a desktop whose own server is stopped", async () => {
    expect(
      await resolveDiscoverySource({
        profile: "desktop",
        serverStatus: async () => ({ running: false }),
        deploymentSource: () => null,
        buildTimeUrl: () => "https://cloud.example",
      })
    ).toEqual({ baseUrl: "https://cloud.example" })
  })

  /** The production default, which every other test injects around. */
  it("reads its own origin only when the bundle was built for a same-origin host", async () => {
    const previous = process.env.NEXT_PUBLIC_COGNIA_SAME_ORIGIN_HOST
    try {
      delete process.env.NEXT_PUBLIC_COGNIA_SAME_ORIGIN_HOST
      expect(
        await resolveDiscoverySource({
          profile: "web-standalone",
          deploymentSource: () => null,
          buildTimeUrl: () => null,
        })
      ).toEqual({ none: "no-host" })
      process.env.NEXT_PUBLIC_COGNIA_SAME_ORIGIN_HOST = "1"
      const answer = await resolveDiscoverySource({
        profile: "web-standalone",
        deploymentSource: () => null,
        buildTimeUrl: () => null,
      })
      // The node project has no window; jsdom would answer with its origin.
      expect(answer).toEqual(
        typeof window === "undefined" ? { none: "no-host" } : { baseUrl: window.location.origin }
      )
    } finally {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_COGNIA_SAME_ORIGIN_HOST
      else process.env.NEXT_PUBLIC_COGNIA_SAME_ORIGIN_HOST = previous
    }
  })

  it("asks its own origin on a same-origin web build, after the build-time URL", async () => {
    expect(
      await resolveDiscoverySource({
        profile: "web-standalone",
        deploymentSource: () => null,
        buildTimeUrl: () => null,
        sameOrigin: () => "https://cognia.example",
      })
    ).toEqual({ baseUrl: "https://cognia.example" })
    expect(
      await resolveDiscoverySource({
        profile: "web-standalone",
        deploymentSource: () => null,
        buildTimeUrl: () => "https://built.example",
        sameOrigin: () => "https://cognia.example",
      })
    ).toEqual({ baseUrl: "https://built.example" })
  })
})

describe("discoverDeployment", () => {
  it("reports a multi-tenant deployment with its social methods and service", async () => {
    const fetchConfig = jest.fn(async () => MULTI)
    const result = await discoverDeployment({
      profile: "cloud-companion",
      companionConfig: () =>
        ({ baseUrl: "https://host.example", serverFingerprint: "ff" }) as never,
      fetchConfig,
    })
    expect(fetchConfig).toHaveBeenCalledWith("https://host.example", "ff")
    expect(result).toMatchObject({
      status: "ready",
      baseUrl: "https://host.example",
      fingerprint: "ff",
      social: [{ provider: "github", directSignIn: "social:github" }],
      collaborationServiceUrl: "https://collab.example",
      registrationPolicy: "bootstrap-then-invite",
      webOrigin: null,
    })
  })

  it("carries the web origin a version-3 server announces", async () => {
    const result = await discoverDeployment({
      profile: "cloud-companion",
      companionConfig: () => ({ baseUrl: "https://host.example" }) as never,
      fetchConfig: async () =>
        ({
          ...MULTI,
          collaboration: { ...MULTI.collaboration, webOrigin: "https://app.example.com/" },
        }) as CompanionAuthConfig,
    })
    expect(result).toMatchObject({ status: "ready", webOrigin: "https://app.example.com" })
  })

  /** Most installs are single-user. That is not a fault, and not a prompt. */
  it("calls a single-user deployment none, not unavailable", async () => {
    const result = await discoverDeployment({
      profile: "desktop",
      serverStatus: async () => ({ running: true, boundPort: 1 }),
      localConfig: async () => ({ deploymentMode: "single-user" }) as CompanionAuthConfig,
      official: () => null,
    })
    expect(result).toEqual({ status: "none", reason: "single-user" })
  })

  describe("the official account", () => {
    const official = officialDeployment({})!

    it("is offered where no self-hosted deployment answers", async () => {
      expect(
        await discoverDeployment({
          profile: "desktop",
          serverStatus: async () => ({ running: true, boundPort: 1 }),
          localConfig: async () => ({ deploymentMode: "single-user" }) as CompanionAuthConfig,
          official: () => official,
        })
      ).toEqual({ status: "official", deployment: official, reason: "single-user" })
      expect(
        await discoverDeployment({
          profile: "web-standalone",
          deploymentSource: () => null,
          buildTimeUrl: () => null,
          sameOrigin: () => null,
          official: () => official,
        })
      ).toEqual({ status: "official", deployment: official, reason: "no-host" })
    })

    it("is the build's own by default", async () => {
      expect(
        await discoverDeployment({
          profile: "desktop",
          serverStatus: async () => ({ running: false }),
          buildTimeUrl: () => null,
        })
      ).toMatchObject({
        status: "official",
        reason: "server-stopped",
        deployment: { issuer: official.issuer },
      })
    })

    it("never replaces a self-hosted deployment, nor one that failed", async () => {
      expect(
        await discoverDeployment({
          profile: "desktop",
          serverStatus: async () => ({ running: true, boundPort: 1 }),
          localConfig: async () => MULTI,
          official: () => official,
        })
      ).toMatchObject({ status: "ready" })
      expect(
        await discoverDeployment({
          profile: "desktop",
          serverStatus: async () => ({ running: true, boundPort: 1 }),
          localConfig: async () => {
            throw new Error("connect ECONNREFUSED")
          },
          official: () => official,
        })
      ).toMatchObject({ status: "unavailable" })
    })

    it("is not offered to a probe of one gateway, nor on a headless host", async () => {
      expect(
        await discoverDeployment({
          profile: "desktop",
          deploymentSource: () => ({ baseUrl: "https://gw.example" }) as never,
          fetchConfig: async () => ({ deploymentMode: "single-user" }) as CompanionAuthConfig,
          official: () => official,
          officialFallback: false,
        })
      ).toEqual({ status: "none", reason: "single-user" })
      const fetchConfig = jest.fn()
      expect(
        await discoverDeployment({ profile: "headless", fetchConfig, official: () => official })
      ).toEqual({ status: "none", reason: "no-host" })
      expect(fetchConfig).not.toHaveBeenCalled()
    })
  })

  it("keeps the host's address on a failed read so the gate can say where it looked", async () => {
    const result = await discoverDeployment({
      profile: "desktop",
      serverStatus: async () => ({ running: true, boundPort: 1 }),
      localConfig: async () => {
        throw new Error("fetch failed")
      },
    })
    expect(result).toEqual({
      status: "unavailable",
      reason: "unreachable",
      baseUrl: "https://127.0.0.1:1",
      message: "fetch failed",
    })
  })

  describe("a paired Host this build can only reach over the relay", () => {
    const pinningRefused = async (): Promise<CompanionAuthConfig> => {
      throw Object.assign(
        new Error(
          "native_spki_pinning_unavailable: the native HTTP transport cannot attest SPKI enforcement"
        ),
        { code: "native_spki_pinning_unavailable" }
      )
    }
    const pairing = (relay: boolean) =>
      ({
        baseUrl: "https://192.168.1.4:27890",
        serverFingerprint: "ab",
        deviceId: "device-a",
        serverVersion: "test",
        ...(relay
          ? {
              rendezvousId: "room-a",
              signalingRoomDescriptor: { roomId: "room-a" },
              signalingPrivateKeyJwk: { kty: "EC" },
            }
          : {}),
      }) as never

    it("lets the paired phone through instead of blocking it on an unaskable config", async () => {
      const result = await discoverDeployment({
        profile: "mobile-companion",
        deploymentSource: () => null,
        companionConfig: () => pairing(true),
        fetchConfig: pinningRefused,
        official: () => null,
      })
      expect(result).toEqual({ status: "none", reason: "host-link-only" })
    })

    it("offers the official account to a phone that reaches its Host over the relay only", async () => {
      const official = officialDeployment({})!
      const result = await discoverDeployment({
        profile: "mobile-companion",
        deploymentSource: () => null,
        companionConfig: () => pairing(true),
        fetchConfig: pinningRefused,
        official: () => official,
      })
      expect(result).toEqual({ status: "official", deployment: official, reason: "host-link-only" })
    })

    it("still reports a pairing with no relay room as unavailable: it has no route at all", async () => {
      const result = await discoverDeployment({
        profile: "mobile-companion",
        deploymentSource: () => null,
        companionConfig: () => pairing(false),
        fetchConfig: pinningRefused,
      })
      expect(result).toMatchObject({
        status: "unavailable",
        baseUrl: "https://192.168.1.4:27890",
        message: expect.stringContaining("native_spki_pinning_unavailable"),
      })
    })

    it("does not excuse a deployment the profile chose, which is not the paired Host", async () => {
      const result = await discoverDeployment({
        profile: "mobile-companion",
        deploymentSource: () => ({ baseUrl: "https://192.168.1.4:27890", fingerprint: "ab" }),
        companionConfig: () => pairing(true),
        fetchConfig: pinningRefused,
      })
      expect(result).toMatchObject({ status: "unavailable" })
    })

    it("does not excuse any other failure to read the paired Host", async () => {
      const result = await discoverDeployment({
        profile: "mobile-companion",
        deploymentSource: () => null,
        companionConfig: () => pairing(true),
        fetchConfig: async () => {
          throw new Error("fetch failed")
        },
      })
      expect(result).toMatchObject({ status: "unavailable", message: "fetch failed" })
    })

    it("still reads the config when the direct route works", async () => {
      const result = await discoverDeployment({
        profile: "mobile-companion",
        deploymentSource: () => null,
        companionConfig: () => pairing(true),
        fetchConfig: async () => MULTI,
      })
      expect(result).toMatchObject({ status: "ready", baseUrl: "https://192.168.1.4:27890" })
    })
  })

  // Its listener is HTTPS with a self-signed certificate the webview refuses,
  // so the desktop never fetches its own server: it used to ask at http://,
  // fail every time, and never reach the official account.
  describe("the desktop's own server", () => {
    const LOCAL_SINGLE_USER = {
      configVersion: 4,
      deploymentMode: "single-user",
      hostId: "host-1",
      oidc: null,
      signaling: { url: "wss://signaling.example/signaling", iceServers: [] },
    }

    it("is read in-process, never over HTTP", async () => {
      ;(localTransport.call as jest.Mock).mockImplementation(async (command: string) =>
        command === "companion_server_status"
          ? { running: true, boundPort: 27890 }
          : LOCAL_SINGLE_USER
      )
      const fetchConfig = jest.fn()
      const official = officialDeployment({})!
      await expect(
        discoverDeployment({
          profile: "desktop",
          deploymentSource: () => null,
          fetchConfig,
          official: () => official,
        })
      ).resolves.toEqual({ status: "official", deployment: official, reason: "single-user" })
      expect(localTransport.call).toHaveBeenCalledWith("companion_local_auth_config", {})
      expect(fetchConfig).not.toHaveBeenCalled()
    })

    it("refuses a malformed in-process answer like a fetched one", async () => {
      ;(localTransport.call as jest.Mock).mockImplementation(async (command: string) =>
        command === "companion_server_status" ? { running: true, boundPort: 27890 } : {}
      )
      await expect(
        discoverDeployment({ profile: "desktop", deploymentSource: () => null })
      ).resolves.toMatchObject({
        status: "unavailable",
        reason: "malformed",
        baseUrl: "https://127.0.0.1:27890",
      })
    })

    it("still asks a deployment the profile chose over HTTP", async () => {
      const localConfig = jest.fn()
      const fetchConfig = jest.fn().mockResolvedValue(MULTI)
      await expect(
        discoverDeployment({
          profile: "desktop",
          deploymentSource: () => ({ baseUrl: "https://cloud.example", fingerprint: "cd" }),
          fetchConfig,
          localConfig,
        })
      ).resolves.toMatchObject({ status: "ready", baseUrl: "https://cloud.example" })
      expect(fetchConfig).toHaveBeenCalledWith("https://cloud.example", "cd")
      expect(localConfig).not.toHaveBeenCalled()
    })
  })

  it("passes a stopped desktop server through as none", async () => {
    const fetchConfig = jest.fn()
    expect(
      await discoverDeployment({
        profile: "desktop",
        serverStatus: async () => ({ running: false }),
        fetchConfig,
        official: () => null,
      })
    ).toEqual({ status: "none", reason: "server-stopped" })
    expect(fetchConfig).not.toHaveBeenCalled()
  })
})
