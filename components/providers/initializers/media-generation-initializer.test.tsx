/** @jest-environment jsdom */
import { render } from "@testing-library/react"

const dispose = jest.fn()
const startVideoJobReconciler = jest.fn((..._args: unknown[]) => ({ dispose }))
const ensureRendererVideoJobHost = jest.fn()
const store = { listDue: jest.fn() }
jest.mock("@/lib/ai/media/video-jobs/reconciler", () => ({
  startVideoJobReconciler: (...args: unknown[]) => startVideoJobReconciler(...args),
}))
jest.mock("@/lib/ai/media/video-jobs/renderer-host", () => ({
  ensureRendererVideoJobHost: () => ensureRendererVideoJobHost(),
}))
jest.mock("@/lib/ai/media/video-jobs/host", () => ({
  getVideoJobEngine: jest.fn(),
  getVideoJobHost: () => ({ store }),
}))

import { MediaGenerationInitializer } from "./media-generation-initializer"

beforeEach(() => jest.clearAllMocks())

it("installs the renderer host before starting the reconciler, and stops it on unmount", () => {
  const view = render(<MediaGenerationInitializer />)
  expect(ensureRendererVideoJobHost).toHaveBeenCalledTimes(1)
  expect(startVideoJobReconciler).toHaveBeenCalledTimes(1)
  expect(ensureRendererVideoJobHost.mock.invocationCallOrder[0]).toBeLessThan(
    startVideoJobReconciler.mock.invocationCallOrder[0]
  )
  const options = startVideoJobReconciler.mock.calls[0]![0] as { store: () => unknown }
  expect(options.store()).toBe(store)
  view.unmount()
  expect(dispose).toHaveBeenCalledTimes(1)
})
