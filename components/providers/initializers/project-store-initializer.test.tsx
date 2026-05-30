/**
 * @jest-environment jsdom
 */
import { render } from "@testing-library/react"

const loadMock = jest.fn(async () => undefined)
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: { getState: () => ({ load: loadMock }) },
}))
jest.mock("@/lib/logging", () => ({
  loggers: { shell: { warn: jest.fn(), info: jest.fn(), error: jest.fn() } },
}))

import { ProjectStoreInitializer } from "./project-store-initializer"

beforeEach(() => loadMock.mockClear())

describe("ProjectStoreInitializer", () => {
  it("calls the project store load() once on mount", () => {
    render(<ProjectStoreInitializer />)
    expect(loadMock).toHaveBeenCalledTimes(1)
  })

  it("does not re-run load() on re-render", () => {
    const { rerender } = render(<ProjectStoreInitializer />)
    rerender(<ProjectStoreInitializer />)
    expect(loadMock).toHaveBeenCalledTimes(1)
  })

  it("renders nothing", () => {
    const { container } = render(<ProjectStoreInitializer />)
    expect(container).toBeEmptyDOMElement()
  })
})
