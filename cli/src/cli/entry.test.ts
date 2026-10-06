/** @jest-environment node */
const mockOrder: string[] = []
let mockBoot: () => Promise<number>

jest.mock("./role", () => ({ selectRole: () => "cli" }))
jest.mock("./entry-runtime", () => ({
  installClosedPipeHandler: jest.fn(),
  runProcessEntrypoint: (boot: () => Promise<number>) => {
    mockBoot = boot
  },
}))
jest.mock("../runtime/cli-host-marker", () => ({
  markCliHostProcess: () => mockOrder.push("marker"),
}))
jest.mock("../db/install-indexeddb", () => {
  mockOrder.push("indexeddb")
  return {}
})
jest.mock("@/lib/vector/runtime-adapters", () => ({
  installVectorRuntimeAdapters: () => mockOrder.push("vector"),
}))
jest.mock("./index", () => ({
  main: () => {
    mockOrder.push("main")
    return 0
  },
}))

test("installs vector capabilities after the database preamble and before CLI consumers", async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("./entry")
  await expect(mockBoot()).resolves.toBe(0)
  expect(mockOrder).toEqual(["marker", "indexeddb", "vector", "main"])
})
