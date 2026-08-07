import { blankServerSeed } from "./server-seed"

describe("blankServerSeed", () => {
  it("starts disabled and unprojected until trust review", async () => {
    const seed = await blankServerSeed()
    expect(seed.transport).toBe("stdio")
    expect(seed.enabled).toBe(false)
    expect(seed.config).toEqual({ command: "", args: [] })
    expect(seed.appsEnabled).toEqual({})
  })
})
