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
  },
} as CompanionAuthConfig

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
      await resolveDiscoverySource({ profile: "web-standalone", buildTimeUrl: () => null })
    ).toEqual({ none: "no-host" })
    expect(await resolveDiscoverySource({ profile: "headless" })).toEqual({ none: "no-host" })
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
    })
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
