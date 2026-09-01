jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: { getState: () => ({ teams: {}, teammates: {} }) },
}))

import { createSquadsProvider, loadSquadSearchRows, type SquadsProviderDeps } from "./squads"
import type { AgentTeam, AgentTeammate } from "@/types/agent/agent-team"
import type { GlobalSearchContext } from "../types"

const squad = (over: Partial<AgentTeam> = {}) =>
  ({
    id: "squad-1",
    name: "Review Crew",
    description: "reads every diff",
    status: "idle",
    projectId: "proj-a",
    ...over,
  }) as AgentTeam

const member = (over: Partial<AgentTeammate> = {}) =>
  ({ id: "m1", teamId: "squad-1", name: "Reviewer", role: "teammate", ...over }) as AgentTeammate

const deps = (over: Partial<SquadsProviderDeps> = {}): SquadsProviderDeps => ({
  listSquads: () => [squad()],
  listTeammates: () => [member(), member({ id: "m2" })],
  ...over,
})

const ctx = {
  now: 10_000,
  t: (key: string) => key,
} as unknown as GlobalSearchContext

const search = async (provider: ReturnType<typeof createSquadsProvider>, needle: string) =>
  provider.search({
    query: { needle, raw: needle } as never,
    ctx,
    limit: 10,
    signal: new AbortController().signal,
  })

describe("loadSquadSearchRows", () => {
  it("counts the roster per Squad", () => {
    expect(loadSquadSearchRows(deps())).toEqual([
      {
        id: "squad-1",
        name: "Review Crew",
        description: "reads every diff",
        status: "idle",
        memberCount: 2,
        projectId: "proj-a",
      },
    ])
  })

  /**
   * A provider's `load` is cached, so a throw does not drop one keystroke: it
   * blanks Squads from the palette until the TTL expires.
   */
  it("survives a store read before hydration", () => {
    expect(
      loadSquadSearchRows(
        deps({
          listSquads: () => {
            throw new Error("store not hydrated")
          },
        })
      )
    ).toEqual([])
  })
})

describe("squadsProvider", () => {
  /**
   * `teamsProvider` finds a guild of Characters, not an `AgentTeam`, so before
   * this the only way to reach a Squad from the palette was the `/squads` page
   * entry, which answers "show me the list" rather than "open the Review Crew".
   */
  it("matches on the name and opens the Squad, not the list", async () => {
    const result = await search(createSquadsProvider(deps()), "review")
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({
      id: "squad:squad-1",
      kind: "squad",
      title: "Review Crew",
      action: { type: "navigate", href: "/squads?id=squad-1" },
    })
  })

  /** An id pasted from a run row or a notification has to resolve. */
  it("matches on the id, not just the name", async () => {
    const result = await search(createSquadsProvider(deps()), "squad-1")
    expect(result.items[0]).toMatchObject({ id: "squad:squad-1" })
  })

  /**
   * A Squad belongs to a workspace: `createTeam` stamps the active project and
   * the store purges per project. Out of scope it is noise, not a preference,
   * which is what separates `filter` from `demote`.
   */
  it("hides a Squad from another workspace", async () => {
    const provider = createSquadsProvider(
      deps({
        listSquads: () => [
          squad(),
          squad({ id: "squad-2", name: "Review Squad B", projectId: "proj-b" }),
        ],
      })
    )
    const scoped = await provider.search({
      query: { needle: "review", raw: "review" } as never,
      ctx: { ...ctx, activeProjectId: "proj-a" } as unknown as GlobalSearchContext,
      limit: 10,
      signal: new AbortController().signal,
    })
    expect(scoped.items.map((i) => i.id)).toEqual(["squad:squad-1"])
  })

  /**
   * A reusable template carries no `projectId`. That has to read as
   * "everywhere", not "nowhere", or scoped search loses every row written
   * before the column existed.
   */
  it("keeps a Squad that names no workspace", async () => {
    const provider = createSquadsProvider(
      deps({ listSquads: () => [squad({ projectId: undefined })] })
    )
    const scoped = await provider.search({
      query: { needle: "review", raw: "review" } as never,
      ctx: { ...ctx, activeProjectId: "proj-b" } as unknown as GlobalSearchContext,
      limit: 10,
      signal: new AbortController().signal,
    })
    expect(scoped.items.map((i) => i.id)).toEqual(["squad:squad-1"])
  })
})
