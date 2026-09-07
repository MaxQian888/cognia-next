import type { CompanionAuthConfig } from "@/lib/tauri/companion-auth"

import { discoverDeployment, resolveDiscoverySource } from "./deployment-discovery"

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
  it("asks the desktop's own server on its loopback port, or nothing when stopped", async () => {
    expect(
      await resolveDiscoverySource({
        profile: "desktop",
        serverStatus: async () => ({ running: true, boundPort: 7890 }),
      })
    ).toEqual({ baseUrl: "http://127.0.0.1:7890" })
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
      fetchConfig: async () => ({ deploymentMode: "single-user" }) as CompanionAuthConfig,
    })
    expect(result).toEqual({ status: "none", reason: "single-user" })
  })

  it("keeps the host's address on a failed read so the gate can say where it looked", async () => {
    const result = await discoverDeployment({
      profile: "desktop",
      serverStatus: async () => ({ running: true, boundPort: 1 }),
      fetchConfig: async () => {
        throw new Error("fetch failed")
      },
    })
    expect(result).toEqual({
      status: "unavailable",
      reason: "unreachable",
      baseUrl: "http://127.0.0.1:1",
      message: "fetch failed",
    })
  })

  it("passes a stopped desktop server through as none", async () => {
    const fetchConfig = jest.fn()
    expect(
      await discoverDeployment({
        profile: "desktop",
        serverStatus: async () => ({ running: false }),
        fetchConfig,
      })
    ).toEqual({ status: "none", reason: "server-stopped" })
    expect(fetchConfig).not.toHaveBeenCalled()
  })
})
