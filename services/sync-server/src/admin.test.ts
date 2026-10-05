import { describe, expect, it } from "vitest"

import { spaceWithGenesis, requestToJoin, testEnv } from "../test/helpers"
import { purgeSpaceOf } from "./admin"

describe("purgeSpaceOf", () => {
  it("deletes the whole space of a person", async () => {
    const space = await spaceWithGenesis()
    await requestToJoin(space)
    const { spaceId } = await purgeSpaceOf(testEnv, space.person.userId)
    expect(spaceId).toBe(space.chain.spaceId)
    expect((await space.person.json("GET", "/v1/space")).body).toEqual({
      state: "empty",
      protocolVersion: 1,
    })
    expect((await space.person.json("GET", "/v1/registry")).body.entries).toEqual([])
    // The space can start over afterwards.
    await spaceWithGenesis(space.person)
  })

  it("refuses something that is not a person id", async () => {
    await expect(purgeSpaceOf(testEnv, "dev_123")).rejects.toThrow(/usr_/)
  })
})
