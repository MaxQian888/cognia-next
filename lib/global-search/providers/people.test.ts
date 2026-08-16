import type { Character, Team } from "@cognia/agent-config-types"

import { __resetGlobalSearchCachesForTesting } from "../cache"
import { makeProviderInput, makeTestContext } from "../testing"
import { createCharactersProvider, createTeamsProvider } from "./people"

jest.mock("@/lib/db/characters", () => ({ listCharacters: jest.fn(async () => []) }))
jest.mock("@/lib/db/teams", () => ({ listTeams: jest.fn(async () => []) }))

const characters: Character[] = [
  {
    id: "c1",
    name: "Alice",
    description: "helpful",
    avatarColor: "#f00",
    systemPrompt: "",
  } as Character,
  { id: "c2", name: "Bob", avatarColor: "#0f0", systemPrompt: "" } as Character,
]
const teams: Team[] = [
  {
    id: "t1",
    name: "Alpha team",
    description: "ships",
    avatarColor: "#00f",
    members: [{}, {}],
  } as Team,
]

describe("people providers", () => {
  afterEach(() => __resetGlobalSearchCachesForTesting())

  it("finds characters by name / description / id and starts a chat", async () => {
    const provider = createCharactersProvider({ listCharacters: async () => characters })
    const out = await provider.search(makeProviderInput("ali"))
    expect(out.items).toHaveLength(1)
    expect(out.items[0]).toMatchObject({
      id: "character:c1",
      kind: "character",
      title: "Alice",
      subtitle: "helpful",
      meta: "globalSearch.people.newChatWith",
      icon: { avatar: characters[0] },
      action: { type: "new-chat-with-character", characterId: "c1", characterName: "Alice" },
    })
    const byDesc = await provider.search(makeProviderInput("helpful"))
    expect(byDesc.items[0]!.id).toBe("character:c1")
    const byId = await provider.search(makeProviderInput("c2"))
    expect(byId.items[0]!.id).toBe("character:c2")
    expect(byId.items[0]!.subtitle).toBeUndefined()
  })

  it("suggests characters for the empty query", async () => {
    const provider = createCharactersProvider({ listCharacters: async () => characters })
    const items = await provider.suggest!({
      ctx: makeTestContext(),
      limit: 1,
      signal: new AbortController().signal,
    })
    expect(items.map((i) => i.id)).toEqual(["character:c1"])
    expect(items[0]!.action.type).toBe("new-chat-with-character")
  })

  it("finds teams and switches the guild", async () => {
    const provider = createTeamsProvider({ listTeams: async () => teams })
    const out = await provider.search(makeProviderInput("alpha"))
    expect(out.items[0]).toMatchObject({
      id: "team:t1",
      kind: "team",
      meta: 'globalSearch.people.members:{"count":2}',
      action: { type: "switch-guild", kind: "team", teamId: "t1" },
    })
    expect(provider.suggest).toBeUndefined()
    const memberless = createTeamsProvider({
      listTeams: async () => [{ ...teams[0]!, members: undefined as never }],
    })
    // Fresh provider → fresh cache; different id would collide, so clear first.
    __resetGlobalSearchCachesForTesting()
    const out2 = await memberless.search(makeProviderInput("alpha"))
    expect(out2.items[0]!.meta).toBe('globalSearch.people.members:{"count":0}')
  })
})
