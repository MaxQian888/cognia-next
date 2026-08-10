import { resolveMemoryAgentNamespace } from "./twin-namespace"

it("shares one namespace across Characters bound to the same Twin", () => {
  expect(resolveMemoryAgentNamespace({ twinId: "alice", characterId: "writer" })).toBe("twin:alice")
  expect(resolveMemoryAgentNamespace({ twinId: "alice", characterId: "reviewer" })).toBe(
    "twin:alice"
  )
})

it("isolates different Twins and preserves non-Twin Character behavior", () => {
  expect(resolveMemoryAgentNamespace({ twinId: "alice", characterId: "writer" })).not.toBe(
    resolveMemoryAgentNamespace({ twinId: "bob", characterId: "writer" })
  )
  expect(resolveMemoryAgentNamespace({ characterId: "writer" })).toBe("writer")
})

it("keeps an external delegation target namespace authoritative", () => {
  expect(
    resolveMemoryAgentNamespace({
      targetAgentId: "external:researcher",
      twinId: "alice",
      characterId: "writer",
    })
  ).toBe("external:researcher")
})
