/**
 * @jest-environment jsdom
 */

import { act, renderHook, waitFor } from "@testing-library/react"

import { TemplateCatalog } from "@/lib/templates/catalog"
import { createTemplateDefinition } from "@/lib/templates/contracts"
import { InMemoryTemplateRepository } from "@/lib/templates/repository"
import type { TemplateRuntime } from "@/lib/templates/runtime"
import type { AgentTeamTemplate } from "@/types/agent/agent-team"

import {
  useSquadTemplatePlatformStatuses,
  type SquadTemplateStatusRow,
} from "./use-squad-template-platform-statuses"

const mine: AgentTeamTemplate = {
  id: "user-1",
  name: "Mine",
  description: "",
  category: "general",
  teammates: [],
  isBuiltIn: false,
}

async function draft(id: string) {
  return createTemplateDefinition({
    id,
    domain: "agentTeam",
    status: "draft",
    revision: 1,
    version: null,
    metadata: { name: id },
    payload: { team: { name: id } },
    inputs: [],
    dependencies: [],
    capabilities: [],
    compatibility: { platforms: ["desktop", "web", "mobile"] },
    provenance: { source: "user", trust: "unsigned" },
  })
}

async function release(id: string, version: string) {
  return createTemplateDefinition({
    id,
    domain: "agentTeam",
    status: "published",
    revision: 1,
    version,
    metadata: { name: id },
    payload: { team: { name: id } },
    inputs: [],
    dependencies: [],
    capabilities: [],
    compatibility: { platforms: ["desktop", "web", "mobile"] },
    provenance: { source: "user", trust: "unsigned" },
  })
}

function makeRuntime() {
  const repository = new InMemoryTemplateRepository()
  const runtime = {
    catalog: new TemplateCatalog(),
    repository,
    service: { getDerivation: async () => undefined } as unknown as TemplateRuntime["service"],
  } as TemplateRuntime
  return { runtime, repository }
}

describe("useSquadTemplatePlatformStatuses", () => {
  it("reports absent for a template that was never mirrored", async () => {
    const { runtime } = makeRuntime()
    const rows: SquadTemplateStatusRow[] = [{ template: mine }]
    const { result } = renderHook(() => useSquadTemplatePlatformStatuses(rows, runtime))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.byTemplateId["user-1"]).toMatchObject({ state: "absent" })
  })

  it("reports draft, then published once a release exists", async () => {
    const { runtime, repository } = makeRuntime()
    await repository.saveDraft(await draft("legacy.agentTeam.user-1"), 0)
    const rows: SquadTemplateStatusRow[] = [{ template: mine }]
    const { result } = renderHook(() => useSquadTemplatePlatformStatuses(rows, runtime))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.byTemplateId["user-1"]?.state).toBe("draft")

    await repository.putRelease(await release("legacy.agentTeam.user-1", "1.0.0"))
    act(() => result.current.refresh())
    await waitFor(() => expect(result.current.byTemplateId["user-1"]?.state).toBe("published"))
    expect(result.current.byTemplateId["user-1"]?.latestVersion).toBe("1.0.0")
  })

  it("keys by the store template id, not the definition id", async () => {
    const { runtime } = makeRuntime()
    const rows: SquadTemplateStatusRow[] = [{ template: mine }]
    const { result } = renderHook(() => useSquadTemplatePlatformStatuses(rows, runtime))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(Object.keys(result.current.byTemplateId)).toEqual(["user-1"])
    expect(result.current.byTemplateId["user-1"]?.definitionId).toBe("legacy.agentTeam.user-1")
  })

  it("answers nothing rather than a wrong badge when the read fails", async () => {
    const { runtime } = makeRuntime()
    runtime.repository.listReleases = async () => {
      throw new Error("dexie is closed")
    }
    const rows: SquadTemplateStatusRow[] = [{ template: mine }]
    const { result } = renderHook(() => useSquadTemplatePlatformStatuses(rows, runtime))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.byTemplateId).toEqual({})
  })
})
