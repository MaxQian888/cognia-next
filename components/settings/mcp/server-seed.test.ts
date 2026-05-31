const getDetectedWritableAgents = jest.fn()
jest.mock("@/hooks/agent", () => ({
  getDetectedWritableAgents: () => getDetectedWritableAgents(),
}))

import { blankServerSeed } from "./server-seed"

describe("blankServerSeed", () => {
  it("projects to every detected writable agent", async () => {
    getDetectedWritableAgents.mockResolvedValue(["claude-code", "cursor"])
    const seed = await blankServerSeed()
    expect(seed.transport).toBe("stdio")
    expect(seed.enabled).toBe(true)
    expect(seed.config).toEqual({ command: "", args: [] })
    expect(seed.appsEnabled).toEqual({ "claude-code": true, cursor: true })
  })

  it("yields an empty projection when no agents are detected", async () => {
    getDetectedWritableAgents.mockResolvedValue([])
    const seed = await blankServerSeed()
    expect(seed.appsEnabled).toEqual({})
  })
})
