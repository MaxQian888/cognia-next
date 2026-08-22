/** @jest-environment node */

import { resetAcpRegistryCacheForTests, type AcpRegistryAgent } from "../acp-registry"
import {
  classifyRegistryAgent,
  discoverRegistryAgents,
  partitionDiscoveries,
  registryCatalogEntry,
  registryRuntimeId,
} from "./registry-discovery"
import { isDistributionInstallable } from "../runtime-catalog"

const SHA = "b".repeat(64)

function agent(overrides: Partial<AcpRegistryAgent> = {}): AcpRegistryAgent {
  return {
    id: "example-agent",
    name: "Example Agent",
    version: "1.2.3",
    description: "An agent",
    website: "https://example.test",
    distribution: {
      binary: {
        "darwin-arm64": {
          archive: "https://example.test/agent-1.2.3.tar.gz",
          sha256: SHA,
          cmd: "./bin/agent",
        },
      },
    },
    ...overrides,
  }
}

beforeEach(() => {
  resetAcpRegistryCacheForTests()
})

describe("registryRuntimeId", () => {
  it("namespaces registry ids so they cannot collide with the catalog", () => {
    expect(registryRuntimeId("codex")).toBe("registry:codex")
  })
})

describe("classifyRegistryAgent", () => {
  it("treats a checksummed https binary as Cognia-installable", () => {
    const result = classifyRegistryAgent(agent(), "darwin-arm64")

    expect(result.kind).toBe("managed")
    if (result.kind !== "managed") return
    expect(result.distribution).toMatchObject({
      provider: "binary",
      version: "1.2.3",
      artifacts: [
        {
          platformKey: "darwin-arm64",
          url: "https://example.test/agent-1.2.3.tar.gz",
          integrity: { sha256: SHA },
          entrypoint: "bin/agent",
          archive: "tar.gz",
        },
      ],
    })
    // The provider layer must accept what this produced, or the bridge is a lie.
    expect(isDistributionInstallable(result.distribution)).toBe(true)
  })

  it("reads a zip archive as a zip", () => {
    const result = classifyRegistryAgent(
      agent({
        distribution: {
          binary: {
            "win32-x64": {
              archive: "https://example.test/agent.zip",
              sha256: SHA,
              cmd: "bin/agent.exe",
            },
          },
        },
      }),
      "win32-x64"
    )
    expect(result.kind === "managed" && result.distribution.artifacts[0].archive).toBe("zip")
  })

  it("refuses to call an npx entry installable", () => {
    const result = classifyRegistryAgent(
      agent({ distribution: { npx: { package: "@example/agent" } } }),
      "darwin-arm64"
    )

    // Installing it would resolve a dependency tree at install time, which is
    // exactly what the frozen-lock rule exists to prevent.
    expect(result.kind).toBe("user-managed")
    if (result.kind !== "user-managed") return
    expect(result.reason).toBe("no-approved-lock")
    expect(result.docsUrl).toBe("https://example.test")
  })

  it("refuses to call a uvx entry installable", () => {
    const result = classifyRegistryAgent(
      agent({ distribution: { uvx: { package: "example-agent" } } }),
      "darwin-arm64"
    )
    expect(result.kind === "user-managed" && result.reason).toBe("no-approved-lock")
  })

  it("reports a platform the entry does not publish", () => {
    const result = classifyRegistryAgent(agent(), "linux-riscv64")
    expect(result.kind === "user-managed" && result.reason).toBe("no-distribution-for-platform")
  })

  it("never throws on a hostile entry, so one bad row cannot break the listing", () => {
    const hostile = agent({
      distribution: {
        binary: {
          "darwin-arm64": {
            archive: "https://example.test/a.tar.gz",
            sha256: SHA,
            cmd: "../../etc/passwd",
          },
        },
      },
    })

    const result = classifyRegistryAgent(hostile, "darwin-arm64")

    expect(result.kind).toBe("user-managed")
    expect(result.kind === "user-managed" && result.reason).toBe("invalid-distribution")
  })

  it("refuses a binary with no checksum", () => {
    const result = classifyRegistryAgent(
      agent({
        distribution: {
          binary: {
            "darwin-arm64": { archive: "https://example.test/a.tar.gz", cmd: "bin/a" },
          },
        },
      }),
      "darwin-arm64"
    )
    expect(result.kind).toBe("user-managed")
  })

  it("refuses a non-https archive", () => {
    const result = classifyRegistryAgent(
      agent({
        distribution: {
          binary: {
            "darwin-arm64": { archive: "http://example.test/a.tar.gz", sha256: SHA, cmd: "bin/a" },
          },
        },
      }),
      "darwin-arm64"
    )
    expect(result.kind).toBe("user-managed")
  })

  it("falls back to the repository when there is no website", () => {
    const result = classifyRegistryAgent(
      agent({
        website: undefined,
        repository: "https://github.com/example/agent",
        distribution: { npx: { package: "@example/agent" } },
      }),
      "darwin-arm64"
    )
    expect(result.kind === "user-managed" && result.docsUrl).toBe(
      "https://github.com/example/agent"
    )
  })
})

describe("registryCatalogEntry", () => {
  it("certifies nothing about a third-party entry", () => {
    const discovery = classifyRegistryAgent(agent(), "darwin-arm64")
    if (discovery.kind !== "managed") throw new Error("fixture should be managed")

    const entry = registryCatalogEntry(discovery, ["darwin"])

    // No range and no certified list means the version policy resolves to
    // `supported-uncertified`, which needs one explicit consent — the honest
    // answer for something Cognia has never vetted.
    expect(entry.supportedRange).toBeUndefined()
    expect(entry.certifiedVersions).toBeUndefined()
    expect(entry).toMatchObject({
      runtimeId: "registry:example-agent",
      ownership: "managed",
      protocol: "acp",
      presetIds: [],
      sandbox: { required: true, windowsExceptionEligible: false },
    })
    expect(entry.versionProbe?.timeoutMs).toBeGreaterThan(0)
  })
})

describe("discoverRegistryAgents", () => {
  function respondWith(catalog: unknown): typeof fetch {
    return (async () =>
      new Response(JSON.stringify(catalog), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch
  }

  it("classifies every entry for the given platform", async () => {
    const result = await discoverRegistryAgents({
      platformKey: "darwin-arm64",
      fetcher: respondWith({
        version: "1.0.0",
        agents: [agent(), agent({ id: "npx-only", distribution: { npx: { package: "@a/b" } } })],
      }),
    })

    expect(result.registryVersion).toBe("1.0.0")
    expect(result.sourceUrl).toContain("agentclientprotocol.com")
    expect(result.entries.map((entry) => entry.kind)).toEqual(["managed", "user-managed"])
  })

  it("propagates a fetch failure rather than showing an empty listing", async () => {
    const failing = (async () => {
      throw new Error("network down")
    }) as unknown as typeof fetch

    // An empty listing and an unreachable registry look identical to a user.
    await expect(
      discoverRegistryAgents({ platformKey: "darwin-arm64", fetcher: failing })
    ).rejects.toThrow()
  })
})

describe("partitionDiscoveries", () => {
  it("separates what Cognia can install from what it can only point at", () => {
    const entries = [
      classifyRegistryAgent(agent(), "darwin-arm64"),
      classifyRegistryAgent(
        agent({ id: "npx-only", distribution: { npx: { package: "@a/b" } } }),
        "darwin-arm64"
      ),
      classifyRegistryAgent(agent({ id: "other-platform" }), "linux-riscv64"),
    ]

    const { managed, userManaged } = partitionDiscoveries(entries)

    expect(managed).toHaveLength(1)
    expect(userManaged).toHaveLength(2)
    expect(managed[0].runtimeId).toBe("registry:example-agent")
  })

  it("handles an empty listing", () => {
    expect(partitionDiscoveries([])).toEqual({ managed: [], userManaged: [] })
  })
})

describe("dormancy", () => {
  it("stays out of the boot graph", async () => {
    // Startup rehydration imports the lifecycle service, and importing this
    // module for real pulls the registry client, proxy-fetch and the settings
    // store in with it. The service reaches it through a dynamic import for
    // that reason; a static one would make every launch pay for a listing that
    // nothing even opens yet.
    const { readFileSync } = await import("node:fs")
    const source = readFileSync(require.resolve("./service.ts").replace(/\.js$/, ""), "utf8")
    // `import type` is erased and costs nothing; a value import is the one
    // that would drag the module in.
    const valueImport = /^import (?!type )[^\n]*from "\.\/registry-discovery"/m
    expect(source).not.toMatch(valueImport)
    expect(source).toMatch(/await import\("\.\/registry-discovery"\)/)
  })
})
