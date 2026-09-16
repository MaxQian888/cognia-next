/**
 * `next-intl` ships ESM Jest does not transform, so the runtime translator is
 * replaced here. `environment-outcome-message.test.ts` covers the table; this
 * suite only needs A message, plus the case where there is none.
 */

const translate = jest.fn(async (): Promise<(key: string) => string> => (key) => `t:${key}`)
jest.mock("@/lib/i18n/runtime-translator", () => ({
  getRuntimeTranslator: () => translate(),
}))

import {
  __resetRunEnvironmentForTests,
  applicableApproval,
  agentNeedsRespawn,
  assertRunEnvironmentPlaced,
  forgetRunEnvironmentOutcome,
  onRunEnvironmentOutcome,
  placeAgentRun,
  prepareRunEnvironment,
  readRepositoryCoordinates,
  recordRunEnvironmentOutcome,
  RunEnvironmentRefusedError,
  runEnvironmentOutcome,
  type RunEnvironmentRequest,
  type RunEnvironmentSources,
} from "./run-environment"
import {
  __resetSpawnPlacementsForTests,
  pendingSpawnPlacementIds,
  registerSpawnPlacement,
  spawnPlacementFor,
  withSpawnPlacement,
} from "./spawn-placement-registry"
import type { EnvironmentDeclarationVerdict } from "@/lib/project-environment/read-environment-declaration"
import type { WorkspaceRepositoryConfigV1 } from "@/lib/project-environment/workspace-config"
import type { WorkspaceConfigVerdict } from "@/lib/project-environment/workspace-config-trust"
import type { EnvironmentCatalogView } from "@/types/sandbox/environment-catalog"
import type { SandboxPlacement } from "@/types/sandbox/environment-spec"

const DIGEST = `sha256:${"a".repeat(64)}`
const DECLARATION_DIGEST = "d".repeat(64)

function catalog(over: Partial<EnvironmentCatalogView> = {}): EnvironmentCatalogView {
  return {
    poolEnabled: true,
    multiTenant: false,
    floor: "container",
    defaultEntryId: "default",
    entries: [
      {
        id: "default",
        scope: "baseline",
        label: "Default",
        image: { registry: "ghcr.io", repository: "cognia/runner", digest: DIGEST },
        effectiveFloor: "container",
        sizeClassIds: ["small"],
        source: "manual",
      },
    ],
    rejected: [],
    sizeClasses: [
      {
        id: "small",
        label: "Small",
        cpuMillis: 1000,
        memoryMib: 2048,
        ephemeralStorageMib: 8192,
        volumeMib: 20480,
      },
    ],
    egressPresets: [{ id: "npm", label: "npm", domains: ["registry.npmjs.org"] }],
    bundle: { current: { digest: DIGEST, releaseTag: "v1" }, retained: [] },
    ...over,
  }
}

function request(over: Partial<RunEnvironmentRequest> = {}): RunEnvironmentRequest {
  return {
    agentId: "agent-1",
    projectId: "prj1",
    project: { roots: [{ id: "r1", path: "/repo", isPrimary: true }] },
    executionRoot: "/repo",
    surface: "interactive",
    ...over,
  }
}

function sources(over: Partial<RunEnvironmentSources> = {}): RunEnvironmentSources {
  return {
    selection: async () => ({
      runtime: { source: { kind: "auto" }, updatedAt: 0 },
      policy: undefined,
    }),
    catalog: async () => catalog(),
    declarationFiles: async () => ({ files: [], searched: [] }),
    workspaceConfig: async () => ({ kind: "absent" }),
    restricted: async () => false,
    serverApprovals: async () => [],
    deviceApproval: async () => undefined,
    ...over,
  }
}

beforeEach(() => {
  __resetRunEnvironmentForTests()
  __resetSpawnPlacementsForTests()
})

describe("the off path", () => {
  // Q39, and the single most important property of this module: a project
  // that never selected a runtime environment must cost nothing. Not one Host
  // call, not one filesystem read, not one Dexie read.
  it("returns off without touching any other source", async () => {
    const calls: string[] = []
    const watched = sources({
      selection: async () => {
        calls.push("selection")
        return { runtime: undefined, policy: undefined }
      },
      catalog: async () => {
        calls.push("catalog")
        return catalog()
      },
      declarationFiles: async () => {
        calls.push("declarationFiles")
        return { files: [], searched: [] }
      },
      workspaceConfig: async () => {
        calls.push("workspaceConfig")
        return { kind: "absent" }
      },
      restricted: async () => {
        calls.push("restricted")
        return false
      },
      serverApprovals: async () => {
        calls.push("serverApprovals")
        return []
      },
      deviceApproval: async () => {
        calls.push("deviceApproval")
        return undefined
      },
    })

    expect(await prepareRunEnvironment(request(), watched)).toEqual({ kind: "off" })
    expect(calls).toEqual(["selection"])
  })

  it("asks for the session's own environment", async () => {
    const selection = jest.fn(async () => ({ runtime: undefined, policy: undefined }))
    await prepareRunEnvironment(request({ environmentId: "env-2" }), sources({ selection }))
    expect(selection).toHaveBeenCalledWith("prj1", "env-2")
  })

  // A project whose only environment definition is disabled has not selected
  // anything: running its selection would apply a configuration the user
  // switched off.
  it("treats a project with no enabled selection as off", async () => {
    expect(
      await prepareRunEnvironment(
        request(),
        sources({ selection: async () => ({ runtime: undefined, policy: undefined }) })
      )
    ).toEqual({ kind: "off" })
  })
})

describe("a catalog that cannot be read", () => {
  const unreachable = { code: "host_unreachable", message: "no route" }

  // Q40. Infrastructure, not policy: the run takes the existing path with a
  // reason a person can see rather than failing.
  it("falls back when nothing makes isolation mandatory", async () => {
    expect(
      await prepareRunEnvironment(
        request(),
        sources({
          catalog: async () => {
            throw unreachable
          },
        })
      )
    ).toEqual({ kind: "fallback", code: "sandbox_fallback_catalog_unreadable", notices: [] })
  })

  it("refuses instead when the project named a tier", async () => {
    expect(
      await prepareRunEnvironment(
        request(),
        sources({
          selection: async () => ({
            runtime: { source: { kind: "auto" }, isolationMinimum: "gvisor", updatedAt: 0 },
            policy: undefined,
          }),
          catalog: async () => {
            throw unreachable
          },
        })
      )
    ).toEqual({ kind: "refused", code: "environment_catalog_unreadable", notices: [] })
  })

  // `sandbox_pool_disabled` is not a failure to read the catalog — it is the
  // catalog saying the deployment never opened the pool. Routing it through
  // `poolEnabled: false` means the resolver decides fall-back-or-refuse by the
  // same rule it uses for a Host that answered.
  it("routes the pool-off refusal through the resolver rather than its own rule", async () => {
    expect(
      await prepareRunEnvironment(
        request(),
        sources({
          catalog: async () => {
            throw { code: "sandbox_pool_disabled", message: "off" }
          },
        })
      )
    ).toEqual({ kind: "fallback", code: "sandbox_fallback_pool_disabled", notices: [] })
  })

  it("refuses the pool-off case when the execution policy requires a sandbox", async () => {
    const outcome = await prepareRunEnvironment(
      request(),
      sources({
        selection: async () => ({
          runtime: { source: { kind: "auto" }, updatedAt: 0 },
          policy: { requiredRuntimeCapabilities: [], requireSandbox: true },
        }),
        catalog: async () => {
          throw { code: "sandbox_pool_disabled", message: "off" }
        },
      })
    )
    expect(outcome).toEqual({ kind: "refused", code: "sandbox_pool_disabled", notices: [] })
  })
})

describe("resolution", () => {
  it("places a project that selected auto on the deployment default", async () => {
    const outcome = await prepareRunEnvironment(request(), sources())

    expect(outcome.kind).toBe("placed")
    if (outcome.kind !== "placed") throw new Error("unreachable")
    expect(outcome.placement.spec.image.digest).toBe(DIGEST)
    expect(outcome.placement.spec.source).toEqual({
      kind: "deployment-default",
      catalogEntryId: "default",
    })
    expect(outcome.placement.isolationMandatory).toBe(false)
  })

  // The execution root is where the declaration is read from, and a run with
  // none has no repository to declare anything: nothing should be read.
  it("skips the declaration entirely for a run with no execution root", async () => {
    let read = 0
    const outcome = await prepareRunEnvironment(
      request({ executionRoot: null }),
      sources({
        declarationFiles: async () => {
          read += 1
          return { files: [], searched: [] }
        },
      })
    )

    expect(read).toBe(0)
    expect(outcome.kind).toBe("placed")
  })

  // Only an APPROVED workspace.json may name setup that runs inside the
  // sandbox. Carrying an unapproved digest would seal a spec authorizing
  // commands nobody approved.
  it("seals the workspace-config digest only once that file is approved", async () => {
    // Only `kind` and `digest` are read on this path; the parsed config is
    // the workspace-config suite's subject.
    const config = { version: 1 } as unknown as WorkspaceRepositoryConfigV1
    const placed = async (kind: "approved" | "unapproved") => {
      const verdict: WorkspaceConfigVerdict = { kind, digest: "c".repeat(64), config }
      const outcome = await prepareRunEnvironment(
        request(),
        sources({ workspaceConfig: async () => verdict })
      )
      if (outcome.kind !== "placed") throw new Error(`expected placed, got ${outcome.kind}`)
      return outcome.placement.spec.workspaceConfigDigest
    }

    expect(await placed("approved")).toBe("c".repeat(64))
    expect(await placed("unapproved")).toBeUndefined()
  })
})

describe("applicableApproval", () => {
  const declared: EnvironmentDeclarationVerdict = {
    kind: "declared",
    digest: DECLARATION_DIGEST,
    notices: [],
    declaration: {
      file: "devcontainer",
      path: ".devcontainer.json",
      image: { registry: "ghcr.io", repository: "acme/dev", digest: DIGEST },
      containerEnv: {},
      lifecycleCommands: {},
      forwardPorts: [],
      egressDomains: [],
    },
  }

  function record(over: Record<string, unknown> = {}) {
    return {
      id: "apr1",
      projectId: "prj1",
      normalizedRemote: "https://github.com/acme/app.git",
      path: ".devcontainer.json",
      declarationDigest: DECLARATION_DIGEST,
      resolvedImage: { registry: "ghcr.io", repository: "acme/dev", digest: DIGEST },
      runtimeFieldsDigest: "r".repeat(64),
      approverUserId: "usr_alice",
      via: "workspaceMaintainer" as const,
      approvedAt: 1,
      ...over,
    }
  }

  it("prefers the Host ledger, which is the authority admission checks", async () => {
    const approval = await applicableApproval(
      request(),
      declared,
      catalog(),
      sources({ serverApprovals: async () => [record()] })
    )

    expect(approval?.ref).toBe("apr1")
  })

  it("ignores a revoked record and one for another digest", async () => {
    for (const over of [{ revokedAt: 5 }, { declarationDigest: "e".repeat(64) }]) {
      expect(
        await applicableApproval(
          request(),
          declared,
          catalog(),
          sources({ serverApprovals: async () => [record(over)] })
        )
      ).toBeUndefined()
    }
  })

  it("accepts the device approval on a single-tenant host", async () => {
    const approval = await applicableApproval(
      request(),
      declared,
      catalog({ multiTenant: false }),
      sources({
        deviceApproval: async () => ({
          declarationDigest: DECLARATION_DIGEST,
          file: "devcontainer",
          path: ".devcontainer.json",
          resolvedImage: { registry: "ghcr.io", repository: "acme/dev", digest: DIGEST },
          approvedAt: 1,
        }),
      })
    )

    // The ref format is `deviceApprovalRef`'s, which hashes a key that is
    // too long for the Host's byte limit — not a second spelling of it here.
    expect(approval?.ref).toBe("device:/repo")
  })

  // A row for a declaration that has since changed is handed on, not
  // dropped: the resolver compares it and says "changed since you approved
  // it", which is what the person needs to hear.
  it("passes a stale device approval to the resolver to judge", async () => {
    const approval = await applicableApproval(
      request(),
      declared,
      catalog({ multiTenant: false }),
      sources({
        deviceApproval: async () => ({
          declarationDigest: "e".repeat(64),
          file: "devcontainer",
          path: ".devcontainer.json",
          resolvedImage: { registry: "ghcr.io", repository: "acme/dev", digest: DIGEST },
          approvedAt: 1,
        }),
      })
    )

    expect(approval?.declarationDigest).toBe("e".repeat(64))
  })

  // On a Host several tenants share, one tenant's device saying "I approve
  // this image" would be a grant nobody with authority over the workspace
  // ever made.
  it("refuses a device approval on a multi-tenant host", async () => {
    expect(
      await applicableApproval(
        request(),
        declared,
        catalog({ multiTenant: true }),
        sources({
          deviceApproval: async () => ({
            declarationDigest: DECLARATION_DIGEST,
            file: "devcontainer",
            path: ".devcontainer.json",
            resolvedImage: { registry: "ghcr.io", repository: "acme/dev", digest: DIGEST },
            approvedAt: 1,
          }),
        })
      )
    ).toBeUndefined()
  })

  it("has nothing to approve when the repository declares nothing", async () => {
    expect(
      await applicableApproval(request(), { kind: "absent" }, catalog(), sources())
    ).toBeUndefined()
  })

  // A ledger read that fails must not fail the run: an approval that cannot be
  // read is an approval that does not apply, which the resolver already has a
  // verdict for.
  it("treats an unreadable ledger as no approval rather than an error", async () => {
    await expect(
      applicableApproval(
        request(),
        declared,
        catalog(),
        sources({
          serverApprovals: async () => {
            throw new Error("host down")
          },
        })
      )
    ).resolves.toBeUndefined()
  })
})

describe("placeAgentRun", () => {
  it("parks the placement for the spawn and records the outcome", async () => {
    const outcome = await placeAgentRun(request(), sources())

    expect(outcome.kind).toBe("placed")
    expect(pendingSpawnPlacementIds()).toEqual(["agent-1"])
    expect(runEnvironmentOutcome("agent-1")).toBe(outcome)
  })

  // A stale placement from an earlier resolution would authorize a run whose
  // own resolution refused — the approval it rested on may have been revoked
  // in between.
  it("clears a stale placement when this resolution does not place", async () => {
    registerSpawnPlacement("agent-1", {
      kind: "container",
      spec: {} as never,
      isolationMandatory: false,
    } as SandboxPlacement)

    const outcome = await placeAgentRun(
      request(),
      sources({
        selection: async () => ({
          runtime: { source: { kind: "catalog", catalogEntryId: "gone" }, updatedAt: 0 },
          policy: undefined,
        }),
      })
    )

    expect(outcome.kind).toBe("refused")
    expect(spawnPlacementFor("agent-1")).toBeUndefined()
    expect(runEnvironmentOutcome("agent-1")).toBe(outcome)
  })

  it("records off as an outcome too, so a surface can say nothing was asked for", async () => {
    await placeAgentRun(
      request(),
      sources({ selection: async () => ({ runtime: undefined, policy: undefined }) })
    )
    expect(runEnvironmentOutcome("agent-1")).toEqual({ kind: "off" })
    expect(pendingSpawnPlacementIds()).toEqual([])
  })
})

describe("the outcome record", () => {
  it("notifies subscribers and stops after unsubscribe", () => {
    const seen: string[] = []
    const stop = onRunEnvironmentOutcome((agentId) => seen.push(agentId))
    recordRunEnvironmentOutcome("a1", { kind: "off" })
    stop()
    recordRunEnvironmentOutcome("a2", { kind: "off" })
    expect(seen).toEqual(["a1"])
  })

  it("forgets an agent's outcome and its pending placement together", () => {
    registerSpawnPlacement("a1", {
      kind: "container",
      spec: {} as never,
      isolationMandatory: false,
    } as SandboxPlacement)
    recordRunEnvironmentOutcome("a1", { kind: "off" })

    forgetRunEnvironmentOutcome("a1")

    expect(runEnvironmentOutcome("a1")).toBeUndefined()
    expect(pendingSpawnPlacementIds()).toEqual([])
  })
})

describe("assertRunEnvironmentPlaced", () => {
  // `off` and `fallback` are both "run on the existing path", and `placed`
  // has its placement parked. Only a refusal stops the connect.
  it("lets every outcome but a refusal through", async () => {
    for (const outcome of [
      undefined,
      { kind: "off" as const },
      {
        kind: "fallback" as const,
        code: "sandbox_fallback_pool_disabled" as const,
        notices: [],
      },
    ]) {
      __resetRunEnvironmentForTests()
      if (outcome) recordRunEnvironmentOutcome("agent-1", outcome)
      await expect(assertRunEnvironmentPlaced("agent-1")).resolves.toBeUndefined()
    }
  })

  it("throws a typed, localized refusal carrying the code and its detail", async () => {
    recordRunEnvironmentOutcome("agent-1", {
      kind: "refused",
      code: "catalog_entry_unavailable",
      detail: { catalogEntryId: "gone" },
      notices: [],
    })

    await expect(assertRunEnvironmentPlaced("agent-1")).rejects.toMatchObject({
      name: "RunEnvironmentRefusedError",
      code: "catalog_entry_unavailable",
      detail: { catalogEntryId: "gone" },
    })
  })

  // A bundle that cannot be loaded must not turn a refusal into a TypeError:
  // the manager would retry that and report a connection problem instead of a
  // decision about this project.
  it("still refuses, naming the code, when the message cannot be worded", async () => {
    translate.mockRejectedValueOnce(new Error("no bundle"))
    recordRunEnvironmentOutcome("agent-1", {
      kind: "refused",
      code: "gpu_not_supported",
      notices: [],
    })

    const error = await assertRunEnvironmentPlaced("agent-1").catch((e: unknown) => e)
    expect(error).toBeInstanceOf(RunEnvironmentRefusedError)
    expect((error as Error).message).toBe("gpu_not_supported")
  })
})

describe("readRepositoryCoordinates", () => {
  const gitRemotes = jest.fn()
  const gitLog = jest.fn()
  beforeAll(() => {
    jest.doMock("@/lib/git/commands", () => ({
      gitRemotes: (...args: unknown[]) => gitRemotes(...args),
      gitLog: (...args: unknown[]) => gitLog(...args),
    }))
  })
  beforeEach(() => {
    gitRemotes.mockReset()
    gitLog.mockReset()
  })

  it("prefers origin and reads HEAD's full hash", async () => {
    gitRemotes.mockResolvedValue([
      { name: "upstream", fetchUrl: "https://example.com/u.git", pushUrl: "" },
      { name: "origin", fetchUrl: "git@github.com:acme/app.git", pushUrl: "" },
    ])
    gitLog.mockResolvedValue([{ hash: "c".repeat(40) }])

    await expect(readRepositoryCoordinates("/repo")).resolves.toEqual({
      remote: "git@github.com:acme/app.git",
      commitSha: "c".repeat(40),
    })
    expect(gitLog).toHaveBeenCalledWith("/repo", 1, 0)
  })

  // Without both, a declaration cannot be traced to a commit, and the
  // resolver says "unversioned" rather than running it.
  it("has no coordinates without a remote or a commit", async () => {
    gitRemotes.mockResolvedValue([])
    gitLog.mockResolvedValue([{ hash: "c".repeat(40) }])
    await expect(readRepositoryCoordinates("/repo")).resolves.toBeUndefined()

    gitRemotes.mockResolvedValue([{ name: "origin", fetchUrl: "x", pushUrl: "" }])
    gitLog.mockRejectedValue(new Error("not a repository"))
    await expect(readRepositoryCoordinates("/repo")).resolves.toBeUndefined()

    await expect(readRepositoryCoordinates("  ")).resolves.toBeUndefined()
  })
})

describe("agentNeedsRespawn", () => {
  function placed(digest: string) {
    return {
      kind: "placed" as const,
      placement: {
        kind: "container" as const,
        spec: { specDigest: digest } as never,
        isolationMandatory: false,
      },
      notices: [],
    }
  }

  it("does not restart a process started where the run belongs", () => {
    registerSpawnPlacement("agent-1", placed("d1").placement)
    withSpawnPlacement({ config: { id: "agent-1" } })
    expect(agentNeedsRespawn("agent-1", placed("d1"))).toBe(false)
  })

  // The project changed image while the agent kept running.
  it("restarts a process started in a different environment", () => {
    registerSpawnPlacement("agent-1", placed("d1").placement)
    withSpawnPlacement({ config: { id: "agent-1" } })
    expect(agentNeedsRespawn("agent-1", placed("d2"))).toBe(true)
  })

  // The project turned the environment on while its agent ran on the host.
  it("restarts a host process once the run is placed", () => {
    expect(agentNeedsRespawn("agent-1", placed("d1"))).toBe(true)
  })

  // And back: a sandboxed agent whose project opted out.
  it("restarts a sandboxed process once the run is not placed", () => {
    registerSpawnPlacement("agent-1", placed("d1").placement)
    withSpawnPlacement({ config: { id: "agent-1" } })
    expect(agentNeedsRespawn("agent-1", { kind: "off" })).toBe(true)
  })

  it("leaves a host process alone for a run that stays on the host", () => {
    expect(agentNeedsRespawn("agent-1", { kind: "off" })).toBe(false)
    expect(
      agentNeedsRespawn("agent-1", {
        kind: "fallback",
        code: "sandbox_fallback_pool_disabled",
        notices: [],
      })
    ).toBe(false)
  })
})
