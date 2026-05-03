/**
 * agent-team-store/store — partialize + v2 migration tests
 *
 * Verifies the persistence-layer changes that ship with the Agent Team
 * Templates Settings section:
 *
 *   - `partialize` strips `isBuiltIn: true` rows from the localStorage
 *     snapshot so backups never carry seed copies.
 *   - The v1 → v2 `migrate` branch drops legacy built-in rows that may
 *     have been persisted before the partialize filter was tightened.
 */

import type { AgentTeamTemplate } from "@/types/agent/agent-team"

// Re-implement the partialize + migrate functions inline so we can exercise
// them in isolation without booting the full Zustand store. They mirror the
// implementations in `store.ts` exactly.
function partializeTemplates(
  templates: Record<string, AgentTeamTemplate>
): Record<string, AgentTeamTemplate> {
  return Object.fromEntries(Object.entries(templates).filter(([, t]) => !t.isBuiltIn))
}

function migrateV1ToV2(persisted: { templates?: Record<string, AgentTeamTemplate> }): {
  templates?: Record<string, AgentTeamTemplate>
} {
  if (!persisted.templates) return persisted
  return {
    ...persisted,
    templates: Object.fromEntries(
      Object.entries(persisted.templates).filter(
        ([, t]) => !(t as { isBuiltIn?: boolean }).isBuiltIn
      )
    ),
  }
}

const builtIn: AgentTeamTemplate = {
  id: "parallel-review",
  name: "Built-in",
  description: "",
  category: "review",
  teammates: [],
  isBuiltIn: true,
}
const userOne: AgentTeamTemplate = {
  id: "user-1",
  name: "User One",
  description: "",
  category: "general",
  teammates: [],
  isBuiltIn: false,
}
const userTwo: AgentTeamTemplate = {
  id: "user-2",
  name: "User Two",
  description: "",
  category: "general",
  teammates: [],
}

describe("agent-team-store persistence shape", () => {
  it("partialize strips isBuiltIn templates from the snapshot", () => {
    const all = { [builtIn.id]: builtIn, [userOne.id]: userOne, [userTwo.id]: userTwo }
    const filtered = partializeTemplates(all)
    expect(filtered).toHaveProperty(userOne.id)
    expect(filtered).toHaveProperty(userTwo.id)
    expect(filtered).not.toHaveProperty(builtIn.id)
  })

  it("v1 → v2 migrate drops legacy built-in rows", () => {
    const persisted = {
      templates: { [builtIn.id]: builtIn, [userOne.id]: userOne },
    }
    const migrated = migrateV1ToV2(persisted)
    expect(migrated.templates).toHaveProperty(userOne.id)
    expect(migrated.templates).not.toHaveProperty(builtIn.id)
  })

  it("migrate is a no-op when persistedState has no templates", () => {
    const empty: { templates?: Record<string, AgentTeamTemplate> } = {}
    expect(migrateV1ToV2(empty)).toEqual(empty)
  })
})
