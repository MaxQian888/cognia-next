/**
 * @jest-environment jsdom
 */

import { act, renderHook, waitFor } from "@testing-library/react"

import { TemplateCatalog } from "@/lib/templates/catalog"
import { createTemplateDefinition } from "@/lib/templates/contracts"
import type { TemplateInstanceRecord } from "@/lib/templates/repository"
import type { TemplateRuntime } from "@/lib/templates/runtime"

import { useSquadTemplateInstance } from "./use-squad-template-instance"

async function snapshot(version: string | null) {
  return createTemplateDefinition({
    id: "legacy.agentTeam.user-1",
    domain: "agentTeam",
    status: version ? "published" : "draft",
    revision: 1,
    version,
    metadata: { name: "Parallel review" },
    payload: { team: { name: "Parallel review" } },
    inputs: [],
    dependencies: [],
    capabilities: [],
    compatibility: { platforms: ["desktop", "web", "mobile"] },
    provenance: { source: "user", trust: "unsigned" },
  })
}

async function record(teamId: string): Promise<TemplateInstanceRecord> {
  const definition = await snapshot("1.0.0")
  return {
    id: "inst-1",
    idempotencyKey: "key",
    source: {
      definitionId: definition.id,
      version: "1.0.0",
      revision: 1,
      status: "published",
      contentHash: definition.contentHash,
      snapshot: definition,
    },
    bindingFingerprint: "fp",
    resources: [{ domain: "agentTeam", id: teamId }],
    baseline: {},
    createdAt: 1,
    updatedAt: 1,
  }
}

/**
 * Hoisted, not built in the render body. `runtime` is an effect dependency, so
 * a fresh object per render would re-run the read, set state, and spin.
 */
function runtimeWith(listInstances: jest.Mock): TemplateRuntime {
  return {
    catalog: new TemplateCatalog(),
    repository: { listInstances } as unknown as TemplateRuntime["repository"],
    service: {} as TemplateRuntime["service"],
  }
}

describe("useSquadTemplateInstance", () => {
  it("finds the instance whose resources name this Squad", async () => {
    const listInstances = jest.fn(async () => [await record("team-1")])
    const runtime = runtimeWith(listInstances)
    const { result } = renderHook(() => useSquadTemplateInstance("team-1", runtime))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.instance?.id).toBe("inst-1")
    expect(result.current.templateName).toBe("Parallel review")
  })

  it("returns nothing for a Squad no instance points at", async () => {
    const listInstances = jest.fn(async () => [await record("team-other")])
    const runtime = runtimeWith(listInstances)
    const { result } = renderHook(() => useSquadTemplateInstance("team-1", runtime))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.instance).toBeUndefined()
    expect(result.current.availableVersions).toEqual([])
  })

  it("does not read at all without a Squad id", async () => {
    const listInstances = jest.fn(async () => [])
    const runtime = runtimeWith(listInstances)
    const { result } = renderHook(() => useSquadTemplateInstance(undefined, runtime))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(listInstances).not.toHaveBeenCalled()
  })

  it("offers the definition's usable releases and skips the yanked ones", async () => {
    const catalog = new TemplateCatalog()
    catalog.replaceSource("user", [
      await snapshot("1.0.0"),
      { ...(await snapshot("2.0.0")), status: "yanked" as const },
    ])
    const listInstances = jest.fn(async () => [await record("team-1")])
    const runtime = runtimeWith(listInstances)
    const { result } = renderHook(() => useSquadTemplateInstance("team-1", runtime, catalog))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.availableVersions).toEqual(["1.0.0"])
  })

  it("re-reads on refresh, which is how an update or detach becomes visible", async () => {
    const listInstances = jest.fn(async () => [await record("team-1")])
    const runtime = runtimeWith(listInstances)
    const { result } = renderHook(() => useSquadTemplateInstance("team-1", runtime))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(listInstances).toHaveBeenCalledTimes(1)
    act(() => result.current.refresh())
    await waitFor(() => expect(listInstances).toHaveBeenCalledTimes(2))
  })

  it("settles rather than hanging when the read fails", async () => {
    const listInstances = jest.fn(async () => {
      throw new Error("dexie is closed")
    })
    const runtime = runtimeWith(listInstances)
    const { result } = renderHook(() => useSquadTemplateInstance("team-1", runtime))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.instance).toBeUndefined()
  })
})
