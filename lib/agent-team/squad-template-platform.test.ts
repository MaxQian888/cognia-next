import { TemplateCatalog } from "@/lib/templates/catalog"
import { createTemplateDefinition } from "@/lib/templates/contracts"
import { InMemoryTemplateRepository } from "@/lib/templates/repository"
import type { TemplateRuntime } from "@/lib/templates/runtime"
import type { AgentTeamTemplate } from "@/types/agent/agent-team"

import {
  catalogRowsFor,
  compareTemplateVersions,
  readSquadTemplatePlatformStatus,
  resolveSquadTemplateDefinition,
  squadTemplateDefinitionId,
} from "./squad-template-platform"

const userTemplate: AgentTeamTemplate = {
  id: "user-1",
  name: "Mine",
  description: "",
  category: "general",
  teammates: [],
  isBuiltIn: false,
}
const builtInTemplate: AgentTeamTemplate = {
  ...userTemplate,
  id: "parallel-review",
  isBuiltIn: true,
}
const pluginTemplate: AgentTeamTemplate = { ...userTemplate, id: "demo.plugin:review" }

async function definition(overrides: {
  id: string
  version: string | null
  status?: "draft" | "published" | "yanked"
}) {
  return createTemplateDefinition({
    id: overrides.id,
    domain: "agentTeam",
    status: overrides.status ?? (overrides.version ? "published" : "draft"),
    revision: 1,
    version: overrides.version,
    metadata: { name: overrides.id },
    payload: { team: { name: overrides.id } },
    inputs: [],
    dependencies: [],
    capabilities: [],
    compatibility: { platforms: ["desktop", "web", "mobile"] },
    provenance: { source: "user", trust: "unsigned" },
  })
}

describe("squadTemplateDefinitionId", () => {
  it("maps a user template onto its legacy mirror id", () => {
    expect(squadTemplateDefinitionId(userTemplate)).toBe("legacy.agentTeam.user-1")
  })

  it("maps a built-in onto the per-boot overlay id", () => {
    expect(squadTemplateDefinitionId(builtInTemplate)).toBe("builtin.agentTeam.parallel-review")
  })

  it("leaves a plugin row's namespaced runtime id alone", () => {
    // `projectPluginTemplate` and `registerLegacyPluginTemplateCompatibility`
    // build the same `<pluginId>:<defId>`, so re-deriving it would only risk
    // disagreeing with the catalog.
    expect(squadTemplateDefinitionId(pluginTemplate, { pluginSource: "demo.plugin" })).toBe(
      "demo.plugin:review"
    )
  })
})

describe("compareTemplateVersions", () => {
  it("orders by numeric component", () => {
    expect(compareTemplateVersions("1.2.0", "1.10.0")).toBe(-1)
    expect(compareTemplateVersions("2.0.0", "1.9.9")).toBe(1)
    expect(compareTemplateVersions("1.0.0", "1.0.0")).toBe(0)
  })

  it("sorts a pre-release below the same numbers without one", () => {
    // The legacy plugin bridge stamps `0.0.0-compat`, which must never outrank
    // a real release.
    expect(compareTemplateVersions("0.0.0-compat", "0.0.0")).toBe(-1)
    expect(compareTemplateVersions("0.0.0-compat", "1.0.0")).toBe(-1)
  })
})

describe("resolveSquadTemplateDefinition", () => {
  it("prefers the newest release over the draft", async () => {
    const catalog = new TemplateCatalog()
    catalog.replaceSource("user", [
      await definition({ id: "legacy.agentTeam.user-1", version: null }),
      await definition({ id: "legacy.agentTeam.user-1", version: "1.0.0" }),
      await definition({ id: "legacy.agentTeam.user-1", version: "1.1.0" }),
    ])
    expect(resolveSquadTemplateDefinition(userTemplate, {}, catalog)?.version).toBe("1.1.0")
  })

  it("falls back to the draft when nothing is published", async () => {
    const catalog = new TemplateCatalog()
    catalog.replaceSource("user", [
      await definition({ id: "legacy.agentTeam.user-1", version: null }),
    ])
    expect(resolveSquadTemplateDefinition(userTemplate, {}, catalog)?.version).toBeNull()
  })

  it("skips a yanked release rather than offering a plan preflight will block", async () => {
    const catalog = new TemplateCatalog()
    catalog.replaceSource("user", [
      await definition({ id: "legacy.agentTeam.user-1", version: "2.0.0", status: "yanked" }),
      await definition({ id: "legacy.agentTeam.user-1", version: "1.0.0" }),
    ])
    expect(resolveSquadTemplateDefinition(userTemplate, {}, catalog)?.version).toBe("1.0.0")
  })

  it("returns nothing when the catalog does not hold the definition", () => {
    expect(resolveSquadTemplateDefinition(userTemplate, {}, new TemplateCatalog())).toBeUndefined()
  })
})

describe("catalogRowsFor", () => {
  it("returns every row carrying the id, across sources", async () => {
    const catalog = new TemplateCatalog()
    catalog.replaceSource("user", [await definition({ id: "a", version: "1.0.0" })])
    catalog.replaceSource("built-in", [await definition({ id: "a", version: "2.0.0" })])
    expect(
      catalogRowsFor("a", catalog)
        .map((row) => row.version)
        .sort()
    ).toEqual(["1.0.0", "2.0.0"])
  })
})

describe("readSquadTemplatePlatformStatus", () => {
  function makeRuntime(): TemplateRuntime {
    const repository = new InMemoryTemplateRepository()
    return {
      catalog: new TemplateCatalog(),
      repository,
      service: {
        getDerivation: async () => undefined,
      } as unknown as TemplateRuntime["service"],
    }
  }

  it("reports absent when the mirror was never written", async () => {
    const status = await readSquadTemplatePlatformStatus(userTemplate, {}, makeRuntime())
    expect(status).toMatchObject({
      definitionId: "legacy.agentTeam.user-1",
      state: "absent",
      releases: [],
    })
  })

  it("reports draft once the mirror exists but nothing is published", async () => {
    const runtime = makeRuntime()
    await runtime.repository.saveDraft(
      await definition({ id: "legacy.agentTeam.user-1", version: null }),
      0
    )
    const status = await readSquadTemplatePlatformStatus(userTemplate, {}, runtime)
    expect(status.state).toBe("draft")
    expect(status.draft?.id).toBe("legacy.agentTeam.user-1")
  })

  it("reports the newest release and lists every version oldest first", async () => {
    const runtime = makeRuntime()
    await runtime.repository.putRelease(
      await definition({ id: "legacy.agentTeam.user-1", version: "1.1.0" })
    )
    await runtime.repository.putRelease(
      await definition({ id: "legacy.agentTeam.user-1", version: "1.0.0" })
    )
    await runtime.repository.putRelease(
      await definition({ id: "legacy.agentTeam.user-1", version: "0.9.0", status: "yanked" })
    )
    const status = await readSquadTemplatePlatformStatus(userTemplate, {}, runtime)
    expect(status.state).toBe("published")
    expect(status.latestVersion).toBe("1.1.0")
    expect(status.releases).toEqual(["1.0.0", "1.1.0"])
  })

  it("carries the fork lineage when the service records one", async () => {
    const runtime = makeRuntime()
    const derivation = {
      definitionId: "builtin.agentTeam.parallel-review",
      version: "1.0.0",
      revision: 1,
      contentHash: "hash",
      forkedAt: 1,
      baseSnapshot: await definition({ id: "builtin.agentTeam.parallel-review", version: "1.0.0" }),
    }
    runtime.service.getDerivation = async () => derivation
    const status = await readSquadTemplatePlatformStatus(userTemplate, {}, runtime)
    expect(status.derivedFrom?.definitionId).toBe("builtin.agentTeam.parallel-review")
  })
})
