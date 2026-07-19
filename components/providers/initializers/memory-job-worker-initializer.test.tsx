/** @jest-environment jsdom */
import { render } from "@testing-library/react"

const stop = jest.fn()
const startMemoryJobWorker = jest.fn(() => stop)
jest.mock("@/lib/memory/lifecycle/job-worker", () => ({
  startMemoryJobWorker: () => startMemoryJobWorker(),
}))

import { MemoryJobWorkerInitializer } from "./memory-job-worker-initializer"

it("starts the durable memory worker and stops it on unmount", () => {
  const view = render(<MemoryJobWorkerInitializer />)
  expect(startMemoryJobWorker).toHaveBeenCalledTimes(1)
  view.unmount()
  expect(stop).toHaveBeenCalledTimes(1)
})
