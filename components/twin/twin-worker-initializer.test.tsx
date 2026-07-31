/**
 * @jest-environment jsdom
 *
 * `TwinWorkerInitializer` is the single app-level mount point for the
 * all-twins background job worker. It must call `useBackgroundTwinWorker`
 * (so the worker actually runs) and render nothing.
 */

import { render } from "@testing-library/react"

const useBackgroundTwinWorkerMock = jest.fn(() => ({ active: true }))

jest.mock("./use-twin-worker", () => ({
  useBackgroundTwinWorker: () => useBackgroundTwinWorkerMock(),
}))

import { TwinWorkerInitializer } from "./twin-worker-initializer"

beforeEach(() => {
  useBackgroundTwinWorkerMock.mockClear()
})

describe("TwinWorkerInitializer", () => {
  it("starts the background worker via the hook", () => {
    render(<TwinWorkerInitializer />)
    expect(useBackgroundTwinWorkerMock).toHaveBeenCalledTimes(1)
  })

  it("renders nothing", () => {
    const { container } = render(<TwinWorkerInitializer />)
    expect(container.firstChild).toBeNull()
  })
})
