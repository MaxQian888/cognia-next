import type { SessionPatch } from "./types"

describe("SessionPatch", () => {
  it("keeps immutable and working-set fields out of adapter patches", () => {
    type HasId = "id" extends keyof SessionPatch ? true : false
    type HasCreatedAt = "createdAt" extends keyof SessionPatch ? true : false
    type HasWorkingSet = "workingSet" extends keyof SessionPatch ? true : false

    const excluded: [HasId, HasCreatedAt, HasWorkingSet] = [false, false, false]
    expect(excluded).toEqual([false, false, false])
  })
})
