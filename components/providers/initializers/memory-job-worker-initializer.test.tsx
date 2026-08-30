/** @jest-environment jsdom */
import { render } from "@testing-library/react"

const stop = jest.fn()
const startMemoryJobWorker = jest.fn(() => stop)
jest.mock("@/lib/memory/lifecycle/job-worker", () => ({
  startMemoryJobWorker: (...args: unknown[]) => startMemoryJobWorker(...(args as [])),
}))

import { MemoryJobWorkerInitializer } from "./memory-job-worker-initializer"

beforeEach(() => jest.clearAllMocks())

it("starts the durable memory worker and stops it on unmount", () => {
  const view = render(<MemoryJobWorkerInitializer />)
  expect(startMemoryJobWorker).toHaveBeenCalledTimes(1)
  view.unmount()
  expect(stop).toHaveBeenCalledTimes(1)
})

it("gives each window its own lease owner", () => {
  // Two windows sharing one worker id would each accept the other's fenced
  // completions, which is exactly what the fence exists to prevent.
  render(<MemoryJobWorkerInitializer />)
  render(<MemoryJobWorkerInitializer />)
  const ids = startMemoryJobWorker.mock.calls.map(
    ([options]) => (options as { workerId: string }).workerId
  )
  expect(ids).toHaveLength(2)
  expect(ids[0]).toMatch(/^renderer-memory-job-worker:/)
  expect(new Set(ids).size).toBe(2)
})
