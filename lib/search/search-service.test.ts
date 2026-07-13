/**
 * Binding-level test: importing `@/lib/search/search-service` must register
 * the settings-store usage reporter with the `@cognia/web-search` core
 * (ADR-0068 E2). The core's own behavior is covered in the package.
 */

const setReporterMock = jest.fn()

jest.mock("@cognia/web-search/search-service", () => ({
  setSearchUsageReporter: (fn: unknown) => setReporterMock(fn),
}))

const incrementSearchUsageMock = jest.fn()
const stateRef: { current: Record<string, unknown> } = { current: {} }

jest.mock("@/stores/settings", () => ({
  useSettingsStore: { getState: () => stateRef.current },
}))

describe("lib/search/search-service binding", () => {
  beforeEach(() => {
    jest.resetModules()
    setReporterMock.mockClear()
    incrementSearchUsageMock.mockClear()
    stateRef.current = { incrementSearchUsage: incrementSearchUsageMock }
  })

  it("registers a usage reporter on import", async () => {
    await import("./search-service")
    expect(setReporterMock).toHaveBeenCalledTimes(1)
    expect(typeof setReporterMock.mock.calls[0][0]).toBe("function")
  })

  it("the registered reporter forwards to the store's incrementSearchUsage", async () => {
    await import("./search-service")
    const reporter = setReporterMock.mock.calls[0][0] as (
      id: string,
      ms: number,
      ok: boolean
    ) => void
    reporter("tavily", 123, true)
    expect(incrementSearchUsageMock).toHaveBeenCalledWith("tavily", 123, true)
  })

  it("the reporter is a no-op when the store lacks incrementSearchUsage", async () => {
    stateRef.current = {}
    await import("./search-service")
    const reporter = setReporterMock.mock.calls[0][0] as (
      id: string,
      ms: number,
      ok: boolean
    ) => void
    expect(() => reporter("tavily", 1, false)).not.toThrow()
    expect(incrementSearchUsageMock).not.toHaveBeenCalled()
  })
})
