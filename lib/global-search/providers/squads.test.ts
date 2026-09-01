jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: { getState: () => ({ teams: {}, teammates: {} }) },
}))

import {
  createSquadsProvider,
  loadSquadSearchRows,
  squadControlVerb,
  type SquadsProviderDeps,
} from "./squads"
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

/** Just the "open this Squad" rows, for cases that are about which Squads survive. */
const navigateIds = (items: readonly { id: string }[]) =>
  items.map((i) => i.id).filter((id) => id.split(":").length === 2)

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
    expect(navigateIds(scoped.items)).toEqual(["squad:squad-1"])
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
    expect(navigateIds(scoped.items)).toEqual(["squad:squad-1"])
  })
})

describe("control rows", () => {
  /**
   * A `GlobalSearchItem` carries exactly one `action`, so a control has to be
   * its own row. That constraint is why this is two rows and not one row with
   * two buttons.
   */
  it("offers the Squad and, under it, the one control its state admits", async () => {
    const result = await search(createSquadsProvider(deps()), "review")
    expect(result.items.map((item) => item.id)).toEqual(["squad:squad-1", "squad:squad-1:start"])
    expect(result.items[1]).toMatchObject({
      kind: "squad",
      title: "squads.fleet.palette.start",
      meta: "squads.fleet.palette.meta",
      action: { type: "callback" },
    })
  })

  /**
   * Enter on a Squad you searched for must look at it, never spend tokens on
   * it. Ranking is what guarantees that, not a confirmation nobody would read.
   */
  it("ranks the control below its own Squad", async () => {
    const result = await search(createSquadsProvider(deps()), "review")
    expect(result.items[1]!.score).toBeLessThan(result.items[0]!.score)
  })

  /** The palette can never offer a verb the run controls would refuse. */
  it("offers pause for a running Squad and resume for a paused one", async () => {
    const running = await search(
      createSquadsProvider(deps({ listSquads: () => [squad({ status: "executing" })] })),
      "review"
    )
    expect(running.items[1]).toMatchObject({ id: "squad:squad-1:pause" })

    const paused = await search(
      createSquadsProvider(deps({ listSquads: () => [squad({ status: "paused" })] })),
      "review"
    )
    expect(paused.items[1]).toMatchObject({ id: "squad:squad-1:resume" })
  })

  it("maps every status in the union to a verb", () => {
    const statuses = [
      "idle",
      "planning",
      "executing",
      "paused",
      "completed",
      "failed",
      "cancelled",
    ] as const
    for (const status of statuses) expect(squadControlVerb(status)).not.toBeNull()
  })

  /**
   * Every match can produce two rows, so asking the list for the caller's full
   * budget and then doubling would overrun whatever the section was sized for.
   */
  it("keeps the caller's limit across both row kinds", async () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      squad({ id: `squad-${i}`, name: `Review Crew ${i}` })
    )
    const provider = createSquadsProvider(deps({ listSquads: () => many }))
    const result = await provider.search({
      query: { needle: "review", raw: "review" } as never,
      ctx,
      limit: 6,
      signal: new AbortController().signal,
    })
    expect(result.items.length).toBeLessThanOrEqual(6)
  })

  /**
   * `total` answers "how many Squads matched", which is what a "3 more" hint
   * means to a reader. Counting control rows there reports a number nobody
   * asked for.
   */
  it("counts Squads in total, not rows", async () => {
    const result = await search(createSquadsProvider(deps()), "review")
    expect(result.total).toBe(1)
  })
})
