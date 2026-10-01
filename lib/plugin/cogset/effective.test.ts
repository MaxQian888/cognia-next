import { resolveEffectiveCogset } from "./effective"

const existing =
  (...ids: string[]) =>
  async (id: string) =>
    ids.includes(id)

describe("resolveEffectiveCogset", () => {
  it("prefers the session override, then the workspace, then the global choice", async () => {
    const input = { sessionOverrideId: "s", workspaceCogsetId: "w", globalCogsetId: "g" }
    await expect(resolveEffectiveCogset(input, existing("s", "w", "g"))).resolves.toEqual({
      cogsetId: "s",
      source: "session",
    })
    await expect(
      resolveEffectiveCogset({ ...input, sessionOverrideId: undefined }, existing("w", "g"))
    ).resolves.toEqual({ cogsetId: "w", source: "workspace" })
    await expect(resolveEffectiveCogset({ globalCogsetId: "g" }, existing("g"))).resolves.toEqual({
      cogsetId: "g",
      source: "global",
    })
  })

  it("skips references to cogsets that no longer exist", async () => {
    await expect(
      resolveEffectiveCogset(
        { sessionOverrideId: "deleted", workspaceCogsetId: "also-deleted", globalCogsetId: "g" },
        existing("g")
      )
    ).resolves.toEqual({ cogsetId: "g", source: "global" })
    await expect(resolveEffectiveCogset({ globalCogsetId: "x" }, existing())).resolves.toBeNull()
    await expect(resolveEffectiveCogset({}, existing("a"))).resolves.toBeNull()
  })
})
