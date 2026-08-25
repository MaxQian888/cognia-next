import {
  EMPTY_CONSENT,
  activeCandidates,
  candidateId,
  provisioningFromConsent,
  inferProvisioning,
  mergeProvisioning,
  pendingCandidates,
  withDecision,
  type ProbeEntry,
  type ProvisioningProbe,
} from "./provisioning-inference"

function probe(
  names: Array<string | ProbeEntry>,
  options: { ignored?: string[]; pnpm?: ProvisioningProbe["pnpm"] } = {}
): ProvisioningProbe {
  return {
    entries: names.map((name) =>
      typeof name === "string" ? { name, isDir: !name.includes(".") } : name
    ),
    ignored: options.ignored ?? [],
    pnpm: options.pnpm ?? "unknown",
  }
}

describe("inferProvisioning", () => {
  it("proposes one cache link per ecosystem it finds evidence for", () => {
    const candidates = inferProvisioning(
      probe(["package.json", "pnpm-lock.yaml", "Cargo.toml", "uv.lock", "src"])
    )
    expect(candidates.map((candidate) => candidate.path)).toEqual([
      "node_modules",
      "target",
      ".venv",
    ])
    expect(candidates[0].evidence).toEqual(["pnpm-lock.yaml", "package.json"])
    expect(candidates[0].kind).toBe("cacheLink")
  })

  it("proposes nothing for a repository with no build ecosystem", () => {
    expect(inferProvisioning(probe(["README.md", "docs"]))).toEqual([])
  })

  it("skips a cache directory the repository tracks", () => {
    // Vendored dependencies ship with every checkout, worktrees included.
    // Linking over them would replace real content with a pointer.
    const tracked = inferProvisioning(probe(["package.json", "node_modules"]))
    expect(tracked).toEqual([])

    const ignoredInstead = inferProvisioning(
      probe(["package.json", "node_modules"], { ignored: ["node_modules"] })
    )
    expect(ignoredInstead.map((candidate) => candidate.path)).toEqual(["node_modules"])
  })

  it("stops proposing the node_modules share once pnpm's global virtual store is on", () => {
    const shared = inferProvisioning(
      probe(["pnpm-lock.yaml", "package.json"], { pnpm: "available" })
    )
    expect(shared.map((candidate) => candidate.path)).toEqual(["node_modules"])

    const global = inferProvisioning(probe(["pnpm-lock.yaml", "package.json"], { pnpm: "enabled" }))
    expect(global).toEqual([])
  })

  it("still proposes node_modules for a non-pnpm project on a global-store machine", () => {
    // The setting only changes how pnpm installs. A yarn repository gets no
    // benefit from it, so suppressing its proposal would just be slower.
    const candidates = inferProvisioning(probe(["yarn.lock", "package.json"], { pnpm: "enabled" }))
    expect(candidates.map((candidate) => candidate.path)).toEqual(["node_modules"])
  })

  it("offers to copy ignored env files and ignores committed samples", () => {
    const candidates = inferProvisioning(
      probe(
        [
          { name: ".env", isDir: false },
          { name: ".env.local", isDir: false },
          { name: ".env.example", isDir: false },
          { name: ".environment", isDir: false },
        ],
        { ignored: [".env", ".env.local", ".env.example"] }
      )
    )
    expect(candidates.map((candidate) => candidate.path)).toEqual([".env", ".env.local"])
    expect(candidates[0].riskKey).toBe("copiedSecret")
  })

  it("does not offer to copy a tracked env file", () => {
    const candidates = inferProvisioning(probe([{ name: ".env", isDir: false }]))
    expect(candidates).toEqual([])
  })
})

describe("consent", () => {
  const candidates = inferProvisioning(
    probe(["package.json", "Cargo.toml", { name: ".env", isDir: false }], { ignored: [".env"] })
  )

  it("offers each candidate once, whatever the answer was", () => {
    expect(pendingCandidates(candidates, EMPTY_CONSENT)).toHaveLength(3)
    const declined = withDecision(EMPTY_CONSENT, [candidateId("cacheLink", "target")], false)
    const pending = pendingCandidates(candidates, declined)
    expect(pending.map((candidate) => candidate.path)).toEqual(["node_modules", ".env"])
    expect(declined.accepted).toEqual([])
    expect(declined.reviewed).toEqual(["cacheLink:target"])
  })

  it("lets a declined candidate be accepted later", () => {
    const declined = withDecision(EMPTY_CONSENT, [candidateId("cacheLink", "target")], false)
    const reversed = withDecision(declined, [candidateId("cacheLink", "target")], true)
    expect(reversed.accepted).toEqual(["cacheLink:target"])
  })

  it("lists the accepted candidates as active", () => {
    const consent = withDecision(EMPTY_CONSENT, [candidateId("cacheLink", "target")], true)
    expect(activeCandidates(candidates, consent).map((candidate) => candidate.path)).toEqual([
      "target",
    ])
  })
})

describe("provisioningFromConsent", () => {
  it("builds a provisioning payload from the accepted set only", () => {
    const consent = withDecision(
      EMPTY_CONSENT,
      [candidateId("cacheLink", "node_modules"), candidateId("include", ".env")],
      true
    )
    expect(provisioningFromConsent(consent)).toEqual({
      cacheLinks: [{ source: "node_modules", target: "node_modules" }],
      include: [".env"],
    })
  })

  it("returns undefined rather than empty arrays when nothing is accepted", () => {
    expect(provisioningFromConsent(EMPTY_CONSENT)).toBeUndefined()
    expect(provisioningFromConsent(undefined)).toBeUndefined()
  })

  it("drops ids that would escape the workspace or name no path", () => {
    // The row is persisted and therefore editable. Handing "../.." to the
    // native provisioner because "the UI wrote it" is how a traversal ships.
    const consent = {
      accepted: [
        "cacheLink:../../etc",
        "include:/etc/passwd",
        "include:C:\\Windows\\win.ini",
        "cacheLink:",
        "nonsense",
        "cacheLink:target",
      ],
      reviewed: [],
    }
    expect(provisioningFromConsent(consent)).toEqual({
      cacheLinks: [{ source: "target", target: "target" }],
    })
  })
})

describe("mergeProvisioning", () => {
  it("returns whichever side exists when only one does", () => {
    expect(mergeProvisioning(undefined, { include: [".env"] })).toEqual({ include: [".env"] })
    expect(mergeProvisioning({ include: [".env"] }, undefined)).toEqual({ include: [".env"] })
    expect(mergeProvisioning(undefined, undefined)).toBeUndefined()
  })

  it("unions both sides and keeps the declaration's link when both name a target", () => {
    const merged = mergeProvisioning(
      {
        cacheLinks: [{ source: "caches/node", target: "node_modules" }],
        include: [".env"],
      },
      {
        cacheLinks: [
          { source: "node_modules", target: "node_modules" },
          { source: "target", target: "target" },
        ],
        include: [".env", ".env.local"],
      }
    )
    expect(merged).toEqual({
      cacheLinks: [
        { source: "caches/node", target: "node_modules" },
        { source: "target", target: "target" },
      ],
      include: [".env", ".env.local"],
    })
  })

  it("never takes sparse paths from the local side", () => {
    // Narrowing a checkout deletes files. Only an approved repository
    // declaration may do that; an inference of ours may not.
    const merged = mergeProvisioning({ sparsePaths: ["apps/web"] }, {
      sparsePaths: ["everything"],
      include: [".env"],
    } as never)
    expect(merged).toEqual({ sparsePaths: ["apps/web"], include: [".env"] })
  })
})
