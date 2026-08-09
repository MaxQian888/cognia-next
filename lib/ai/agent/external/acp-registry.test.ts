import {
  fetchAcpRegistry,
  createConfirmedRegistryAgentConfig,
  mergeAcpDiscovery,
  resolveAcpRegistryDistribution,
  resetAcpRegistryCacheForTests,
  validateAcpRegistry,
} from "./acp-registry"

const catalog = {
  version: "1.0.0",
  agents: [
    {
      id: "codex-acp",
      name: "Codex",
      version: "1.1.9",
      description: "Codex adapter",
      distribution: {
        npx: { package: "@agentclientprotocol/codex-acp@1.1.9", args: ["--stdio"] },
      },
    },
  ],
}

describe("ACP Registry v1", () => {
  beforeEach(() => resetAcpRegistryCacheForTests())

  it("validates the catalog and rejects malformed executable fields", () => {
    expect(validateAcpRegistry(catalog)).toEqual(catalog)
    expect(() =>
      validateAcpRegistry({
        version: "1.0.0",
        agents: [{ ...catalog.agents[0], id: "../escape" }],
      })
    ).toThrow("id")
  })

  it("uses ETag revalidation and a 15-minute in-process cache", async () => {
    let now = 1_000
    const fetcher = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toEqual(expect.objectContaining({ Accept: "application/json" }))
      return new Response(JSON.stringify(catalog), {
        status: 200,
        headers: { ETag: '"catalog-1"' },
      })
    })

    await expect(fetchAcpRegistry({ fetcher, now: () => now })).resolves.toEqual(catalog)
    now += 14 * 60_000
    await expect(fetchAcpRegistry({ fetcher, now: () => now })).resolves.toEqual(catalog)
    expect(fetcher).toHaveBeenCalledTimes(1)

    now += 2 * 60_000
    fetcher.mockImplementationOnce(async (_input, init) => {
      expect(init?.headers).toEqual(expect.objectContaining({ "If-None-Match": '"catalog-1"' }))
      return new Response(null, { status: 304 })
    })
    await expect(fetchAcpRegistry({ fetcher, now: () => now })).resolves.toEqual(catalog)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it("falls back offline and never overwrites user-authored entries", async () => {
    const fallback = { version: "1.0.0", agents: [] }
    await expect(
      fetchAcpRegistry({
        fetcher: async () => {
          throw new Error("offline")
        },
        fallback,
      })
    ).resolves.toEqual(fallback)

    const merged = mergeAcpDiscovery({
      registry: catalog,
      builtins: [{ id: "codex-acp", name: "Built in" }],
      users: [{ id: "registry:codex-acp", name: "Mine" }],
    })
    expect(merged.find((entry) => entry.qualifiedId === "registry:codex-acp")?.name).toBe("Mine")
    expect(merged.some((entry) => entry.qualifiedId === "builtin:codex-acp")).toBe(true)
  })

  it("resolves exact npx/uvx versions through argument arrays", () => {
    expect(resolveAcpRegistryDistribution(catalog.agents[0], "darwin-aarch64")).toEqual({
      kind: "npx",
      command: "npx",
      args: ["-y", "@agentclientprotocol/codex-acp@1.1.9", "--stdio"],
      env: {},
    })
    expect(
      resolveAcpRegistryDistribution(
        {
          ...catalog.agents[0],
          id: "python-agent",
          version: "2.0.0",
          distribution: { uvx: { package: "python-agent", args: ["serve"] } },
        },
        "linux-x86_64"
      )
    ).toMatchObject({ command: "uvx", args: ["python-agent==2.0.0", "serve"] })
  })

  it("requires binary checksums and rejects traversal in commands", () => {
    const binary = {
      ...catalog.agents[0],
      distribution: {
        binary: {
          "darwin-aarch64": {
            archive: "https://example.com/agent.tgz",
            sha256: "a".repeat(64),
            cmd: "./bin/agent",
            args: ["serve"],
          },
        },
      },
    }
    expect(resolveAcpRegistryDistribution(binary, "darwin-aarch64")).toMatchObject({
      kind: "binary",
      checksum: "a".repeat(64),
      executable: "bin/agent",
    })
    expect(() =>
      resolveAcpRegistryDistribution(
        {
          ...binary,
          distribution: {
            binary: {
              "darwin-aarch64": {
                archive: "https://example.com/agent.tgz",
                sha256: "a".repeat(64),
                cmd: "../escape",
              },
            },
          },
        },
        "darwin-aarch64"
      )
    ).toThrow("traversal")
  })

  it("requires explicit confirmation and records immutable registry provenance", async () => {
    const now = new Date("2026-08-03T00:00:00.000Z")
    const confirm = jest.fn(async () => true)
    const config = await createConfirmedRegistryAgentConfig({
      agent: catalog.agents[0],
      platform: "darwin-aarch64",
      configId: "agent-1",
      confirm,
      now: () => now,
    })

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        registryId: "codex-acp",
        command: "npx",
        args: ["-y", "@agentclientprotocol/codex-acp@1.1.9", "--stdio"],
      })
    )
    expect(config).toMatchObject({
      protocol: "acp",
      transport: "stdio",
      enabled: true,
      registryProvenance: {
        registryId: "codex-acp",
        version: "1.1.9",
        sourceUrl: expect.stringContaining("registry/v1"),
        installedAt: now,
      },
    })

    await expect(
      createConfirmedRegistryAgentConfig({
        agent: catalog.agents[0],
        platform: "darwin-aarch64",
        configId: "agent-2",
        confirm: async () => false,
      })
    ).rejects.toThrow("not approved")
  })

  it("confirms binary installation before requiring a verified installer receipt", async () => {
    const binary = {
      ...catalog.agents[0],
      distribution: {
        binary: {
          "darwin-aarch64": {
            archive: "https://example.com/agent.tgz",
            sha256: "b".repeat(64),
            cmd: "bin/agent",
          },
        },
      },
    }
    const declined = jest.fn(async () => false)
    await expect(
      createConfirmedRegistryAgentConfig({
        agent: binary,
        platform: "darwin-aarch64",
        configId: "binary-1",
        confirm: declined,
      })
    ).rejects.toThrow("not approved")
    expect(declined).toHaveBeenCalledWith(
      expect.objectContaining({ command: "bin/agent", checksum: "b".repeat(64) })
    )

    await expect(
      createConfirmedRegistryAgentConfig({
        agent: binary,
        platform: "darwin-aarch64",
        configId: "binary-2",
        confirm: async () => true,
      })
    ).rejects.toThrow("verified native installer")
  })
})
