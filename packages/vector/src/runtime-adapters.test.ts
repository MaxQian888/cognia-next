import {
  getVectorRuntimeAdapters,
  isTauri,
  resetVectorRuntimeAdaptersForTesting,
  setVectorRuntimeAdapters,
} from "./runtime-adapters"

afterEach(resetVectorRuntimeAdaptersForTesting)

test("requires an explicit host before store operations", () => {
  expect(() => getVectorRuntimeAdapters()).toThrow(
    "Vector runtime adapters have not been installed"
  )
})

test("keeps platform detection live instead of capturing startup state", () => {
  let desktop = false
  setVectorRuntimeAdapters({
    isTauri: () => desktop,
    createBedrockEmbeddingModel: jest.fn(),
    dispatchDocumentsIndexed: jest.fn(),
    dispatchVectorSearch: jest.fn(),
  })
  expect(getVectorRuntimeAdapters().isTauri()).toBe(false)
  desktop = true
  expect(getVectorRuntimeAdapters().isTauri()).toBe(true)
})

test("allows capability queries before host bootstrap during SSR", () => {
  expect(isTauri()).toBe(false)
})
