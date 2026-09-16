import {
  isolationMandatory,
  sandboxPlacementFrom,
  spawnSandboxField,
} from "./environment-placement"
import type { EnvironmentSpecResolution } from "@/lib/project-environment/resolve-environment-spec"
import type { ProjectRuntimeSelection } from "@/types/project-environment"
import type { EnvironmentSpec } from "@/types/sandbox/environment-spec"

const DIGEST = `sha256:${"a".repeat(64)}`

function spec(): EnvironmentSpec {
  return {
    version: 1,
    specDigest: "b".repeat(64),
    projectId: "prj1",
    source: { kind: "deployment-default", catalogEntryId: "default" },
    image: { registry: "ghcr.io", repository: "acme/dev", digest: DIGEST },
    bundle: { digest: DIGEST, releaseTag: "v1.2.3", pinned: false },
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
}

function selection(over: Partial<ProjectRuntimeSelection> = {}): ProjectRuntimeSelection {
  return { source: { kind: "auto" }, updatedAt: 0, ...over }
}

describe("isolationMandatory", () => {
  it("is false for a project that only selected an environment", () => {
    expect(isolationMandatory({ runtime: selection(), policy: undefined })).toBe(false)
  })

  // Naming a tier IS the demand. Without this the project would get a
  // silently unsandboxed run the next time the daemon hiccuped.
  it("is true once the project names a minimum tier", () => {
    expect(
      isolationMandatory({ runtime: selection({ isolationMinimum: "gvisor" }), policy: undefined })
    ).toBe(true)
  })

  // `requireSandbox` predates runtime environments (ADR-0144) and still means
  // what it says, so it counts on its own — a project can demand isolation
  // without naming a tier.
  it("is true from the execution policy alone", () => {
    expect(
      isolationMandatory({
        runtime: selection(),
        policy: { requiredRuntimeCapabilities: [], requireSandbox: true },
      })
    ).toBe(true)
  })

  it("is false with no selection and no policy at all", () => {
    expect(isolationMandatory({ runtime: undefined, policy: undefined })).toBe(false)
  })
})

describe("sandboxPlacementFrom", () => {
  it("carries the sealed spec and the project's own strictness", () => {
    const resolution: EnvironmentSpecResolution = { kind: "resolved", spec: spec(), notices: [] }
    const outcome = sandboxPlacementFrom(resolution, {
      runtime: selection({ isolationMinimum: "vm" }),
      policy: undefined,
    })

    expect(outcome).toEqual({
      kind: "placed",
      placement: { kind: "container", spec: resolution.spec, isolationMandatory: true },
      notices: [],
    })
  })

  // The spec always has a minimum tier because every sandbox runs at one.
  // Reading mandatoriness off the spec would make every sandboxed run refuse
  // on a daemon hiccup — the opposite of the Q40 default.
  it("does not infer mandatory isolation from the spec's own tier", () => {
    const outcome = sandboxPlacementFrom(
      { kind: "resolved", spec: spec(), notices: [] },
      { runtime: selection(), policy: undefined }
    )

    expect(outcome.kind).toBe("placed")
    if (outcome.kind !== "placed") throw new Error("unreachable")
    expect(outcome.placement.spec.isolation.minimum).toBe("container")
    expect(outcome.placement.isolationMandatory).toBe(false)
  })

  it("passes a fallback through with its reason", () => {
    expect(
      sandboxPlacementFrom(
        { kind: "fallback", code: "sandbox_fallback_pool_disabled", notices: [] },
        { runtime: selection(), policy: undefined }
      )
    ).toEqual({ kind: "fallback", code: "sandbox_fallback_pool_disabled", notices: [] })
  })

  it("passes a refusal through with its detail", () => {
    expect(
      sandboxPlacementFrom(
        {
          kind: "refused",
          code: "catalog_entry_unavailable",
          detail: { catalogEntryId: "gone" },
          notices: [],
        },
        {
          runtime: selection({ source: { kind: "catalog", catalogEntryId: "gone" } }),
          policy: undefined,
        }
      )
    ).toEqual({
      kind: "refused",
      code: "catalog_entry_unavailable",
      detail: { catalogEntryId: "gone" },
      notices: [],
    })
  })

  // Axis three of the dormancy label (Rule 7): documented on the type, refused
  // with its own code, pinned here. Before this, the toggle validated and then
  // nothing read it — a project could switch it on and get an ordinary
  // unsandboxed run with no sign anything had been asked for.
  it("refuses a project asking for a local container until the host offers one", () => {
    const outcome = sandboxPlacementFrom(
      { kind: "resolved", spec: spec(), notices: [] },
      { runtime: selection({ localContainer: true }), policy: undefined }
    )

    expect(outcome).toEqual({ kind: "refused", code: "local_container_unavailable", notices: [] })
  })

  it("places normally once a host says it runs local containers", () => {
    const outcome = sandboxPlacementFrom(
      { kind: "resolved", spec: spec(), notices: [] },
      {
        runtime: selection({ localContainer: true }),
        policy: undefined,
        hostRunsLocalContainers: true,
      }
    )

    expect(outcome.kind).toBe("placed")
  })

  it("leaves a project that never set the toggle alone on every host", () => {
    for (const hostRunsLocalContainers of [undefined, false, true]) {
      const outcome = sandboxPlacementFrom(
        { kind: "resolved", spec: spec(), notices: [] },
        { runtime: selection(), policy: undefined, hostRunsLocalContainers }
      )
      expect(outcome.kind).toBe("placed")
    }
  })

  it("reports off when the project selected nothing", () => {
    expect(
      sandboxPlacementFrom({ kind: "off" }, { runtime: undefined, policy: undefined })
    ).toEqual({ kind: "off" })
  })

  it("keeps the resolver's notices so a person sees why", () => {
    const outcome = sandboxPlacementFrom(
      {
        kind: "resolved",
        spec: spec(),
        notices: [{ code: "environment_approval_pending" }],
      },
      { runtime: selection(), policy: undefined }
    )

    expect(outcome.kind === "placed" && outcome.notices).toEqual([
      { code: "environment_approval_pending" },
    ])
  })
})

describe("spawnSandboxField", () => {
  // Q39: with nothing selected the spawn payload must be byte-for-byte what it
  // was before this subsystem existed. An explicit `sandbox: undefined` is not
  // that — it names the key.
  it("adds no key at all on the off path", () => {
    const field = spawnSandboxField({ kind: "off" })
    expect(Object.keys(field)).toEqual([])
    expect("sandbox" in field).toBe(false)
  })

  it("adds no key on a fallback or a refusal either", () => {
    expect(
      Object.keys(
        spawnSandboxField({
          kind: "fallback",
          code: "sandbox_fallback_bundle_unavailable",
          notices: [],
        })
      )
    ).toEqual([])
    expect(
      Object.keys(
        spawnSandboxField({ kind: "refused", code: "sandbox_pool_disabled", notices: [] })
      )
    ).toEqual([])
  })

  it("adds the placement when there is one", () => {
    const placement = { kind: "container" as const, spec: spec(), isolationMandatory: false }
    expect(spawnSandboxField({ kind: "placed", placement, notices: [] })).toEqual({
      sandbox: placement,
    })
  })
})
