// Node environment is intentional: Node 26 defines localStorage as an
// undefined global, which used to make zustand persistence throw on writes.

import { useVectorStore } from "./vector-store"

beforeEach(() => {
  useVectorStore.setState({
    settings: { provider: "native", embeddingProvider: "openai" },
  })
})

it("updates and resets safely without browser localStorage", () => {
  expect(typeof window).toBe("undefined")
  expect(() =>
    useVectorStore.getState().setSettings({ provider: "qdrant", qdrantConfigId: "cfg-1" })
  ).not.toThrow()
  expect(useVectorStore.getState().settings).toMatchObject({
    provider: "qdrant",
    qdrantConfigId: "cfg-1",
  })

  expect(() => useVectorStore.getState().reset()).not.toThrow()
  expect(useVectorStore.getState().settings).toEqual({
    provider: "native",
    embeddingProvider: "openai",
  })
})
