import {
  getPerformanceHostAdapter,
  registerPerformanceHostAdapter,
  resetPerformanceHostAdapterForTesting,
  type PerformanceHostAdapter,
} from "./host-adapter"

const adapter = { stop: jest.fn() } as unknown as PerformanceHostAdapter

afterEach(resetPerformanceHostAdapterForTesting)

it("registers one host adapter and removes only the active registration", () => {
  const unregister = registerPerformanceHostAdapter(adapter)
  expect(getPerformanceHostAdapter()).toBe(adapter)
  expect(() => registerPerformanceHostAdapter({} as PerformanceHostAdapter)).toThrow(
    /already registered/
  )
  unregister()
  expect(() => getPerformanceHostAdapter()).toThrow(/unsupported/)
})
