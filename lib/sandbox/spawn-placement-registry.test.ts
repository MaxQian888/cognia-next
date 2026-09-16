import {
  __resetSpawnPlacementsForTests,
  clearSpawnPlacement,
  pendingSpawnPlacementIds,
  registerSpawnPlacement,
  spawnedPlacementDigest,
  spawnPlacementFor,
  withSpawnPlacement,
} from "./spawn-placement-registry"
import type { EnvironmentSpec, SandboxPlacement } from "@/types/sandbox/environment-spec"

const DIGEST = `sha256:${"a".repeat(64)}`

function placement(projectId = "prj1", specDigest = "b".repeat(64)): SandboxPlacement {
  const spec: EnvironmentSpec = {
    version: 1,
    specDigest,
    projectId,
    source: { kind: "deployment-default", catalogEntryId: "default" },
    image: { registry: "ghcr.io", repository: "acme/dev", digest: DIGEST },
    bundle: { digest: DIGEST, releaseTag: "v1", pinned: false },
    isolation: { minimum: "container" },
    sizeClassId: "small",
    lifecycle: "persistent",
    user: {},
    containerEnv: {},
    lifecycleCommands: {},
    forwardPorts: [],
    egress: { tier: "allowlist", presetIds: [], approvedDomains: [] },
    browserSidecar: false,
  }
  return { kind: "container", spec, isolationMandatory: false }
}

const sandboxOf = (args: Record<string, unknown>) =>
  (args.config as { sandbox?: SandboxPlacement }).sandbox

beforeEach(() => {
  __resetSpawnPlacementsForTests()
})

describe("the current placement", () => {
  it("is what a later spawn of the agent reads", () => {
    const current = placement()
    registerSpawnPlacement("agent-1", current)
    expect(pendingSpawnPlacementIds()).toEqual(["agent-1"])
    expect(spawnPlacementFor("agent-1")).toBe(current)
  })

  it("is forgotten once a resolution no longer places the agent", () => {
    registerSpawnPlacement("agent-1", placement())
    clearSpawnPlacement("agent-1")
    expect(spawnPlacementFor("agent-1")).toBeUndefined()
    expect(pendingSpawnPlacementIds()).toEqual([])
  })

  it("follows the newest resolution", () => {
    registerSpawnPlacement("agent-1", placement("old"))
    const newer = placement("new")
    registerSpawnPlacement("agent-1", newer)
    expect(spawnPlacementFor("agent-1")).toBe(newer)
  })
})

describe("withSpawnPlacement", () => {
  // Q39. Not "an equal object": the SAME object, so nothing downstream can
  // serialize a reordered or extended payload on a deployment that never
  // enabled runtime environments.
  it("returns the caller's own arguments when nothing was ever placed", () => {
    const args = { config: { id: "agent-1", command: "codex" } }
    expect(withSpawnPlacement(args)).toBe(args)
    // …and records nothing on that path.
    expect(spawnedPlacementDigest("agent-1")).toBeUndefined()
  })

  it("returns the caller's own arguments for an agent with no placement", () => {
    registerSpawnPlacement("other", placement())
    const args = { config: { id: "agent-1", command: "codex" } }
    expect(withSpawnPlacement(args)).toBe(args)
  })

  it("attaches the placement under config without disturbing the rest", () => {
    const current = placement()
    registerSpawnPlacement("agent-1", current)
    const args = { config: { id: "agent-1", command: "codex", args: ["acp"] } }

    expect(withSpawnPlacement(args)).toEqual({
      config: { id: "agent-1", command: "codex", args: ["acp"], sandbox: current },
    })
    // The caller's object is left alone; the attached copy is a new one.
    expect(args.config).not.toHaveProperty("sandbox")
  })

  // The manager respawns an agent after a crash or a retried connect without
  // resolving again. A placement consumed by the first spawn would let every
  // one of those start on the host, silently.
  it("places every respawn of the agent, not only the first", () => {
    const current = placement()
    registerSpawnPlacement("agent-1", current)
    expect(sandboxOf(withSpawnPlacement({ config: { id: "agent-1" } }))).toBe(current)
    expect(sandboxOf(withSpawnPlacement({ config: { id: "agent-1" } }))).toBe(current)
  })

  // Pi starts one process per session, `<agentId>:<sessionId>`, so no spawn
  // carries the bare id the run was placed under. Without this every Pi
  // session of a placed run would start unsandboxed while the panel said
  // otherwise.
  it("places every session process of a placed agent", () => {
    const current = placement()
    registerSpawnPlacement("pi-agent", current)

    expect(sandboxOf(withSpawnPlacement({ config: { id: "pi-agent:session-1" } }))).toBe(current)
    expect(sandboxOf(withSpawnPlacement({ config: { id: "pi-agent:session-2" } }))).toBe(current)
  })

  it("resolves a session to its own agent when agent ids nest", () => {
    const outer = placement("outer")
    const inner = placement("inner")
    registerSpawnPlacement("acp:agent", outer)
    registerSpawnPlacement("acp:agent:pi", inner)

    expect(sandboxOf(withSpawnPlacement({ config: { id: "acp:agent:pi:session-1" } }))).toBe(inner)
  })

  it("prefers an exact agent over a shorter one whose sessions it resembles", () => {
    const outer = placement("outer")
    const exact = placement("exact")
    registerSpawnPlacement("acp", outer)
    registerSpawnPlacement("acp:agent", exact)

    expect(sandboxOf(withSpawnPlacement({ config: { id: "acp:agent" } }))).toBe(exact)
  })

  it("does not treat a mere shared prefix as a session of that agent", () => {
    registerSpawnPlacement("pi", placement())
    const args = { config: { id: "pilot:session-1" } }
    expect(withSpawnPlacement(args)).toBe(args)
  })

  // Guessing an id from a malformed payload would attach a placement to the
  // wrong run. A spawn without a config is the Host's to refuse.
  it("leaves arguments it cannot identify untouched", () => {
    registerSpawnPlacement("agent-1", placement())
    for (const args of [
      {} as Record<string, unknown>,
      { config: null } as Record<string, unknown>,
      { config: "agent-1" } as Record<string, unknown>,
      { config: { id: 7 } } as Record<string, unknown>,
      { config: { id: "" } } as Record<string, unknown>,
    ]) {
      expect(withSpawnPlacement(args)).toBe(args)
    }
    expect(spawnPlacementFor("agent-1")).toBeDefined()
  })
})

describe("spawnedPlacementDigest", () => {
  // What a running process was started with decides whether a changed
  // project environment needs the agent restarted.
  it("records the spec each process was spawned with, and a host spawn as null", () => {
    registerSpawnPlacement("agent-1", placement("prj1", "c".repeat(64)))
    withSpawnPlacement({ config: { id: "agent-1" } })
    expect(spawnedPlacementDigest("agent-1")).toBe("c".repeat(64))

    clearSpawnPlacement("agent-1")
    withSpawnPlacement({ config: { id: "agent-1" } })
    expect(spawnedPlacementDigest("agent-1")).toBeNull()
  })

  // Once the feature has been used, a spawn that carries nothing is still a
  // fact worth recording — otherwise a process restarted on the host would
  // keep reading as sandboxed.
  it("keeps recording after the last placement is cleared", () => {
    registerSpawnPlacement("agent-1", placement())
    withSpawnPlacement({ config: { id: "agent-1" } })
    clearSpawnPlacement("agent-1")

    const args = { config: { id: "agent-2" } }
    expect(withSpawnPlacement(args)).toBe(args)
    expect(spawnedPlacementDigest("agent-2")).toBeNull()
  })
})
