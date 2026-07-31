import { act, render } from "@testing-library/react"

const reconcile = jest.fn(async () => undefined)
jest.mock("@/lib/project-knowledge/wire-ingest", () => ({
  createProjectKnowledgeIngestController: () => ({
    reconcile,
    reindexFile: jest.fn(),
    reindexProject: jest.fn(),
  }),
}))

let storeListener: ((state: unknown, prev: unknown) => void) | undefined
const unsubscribe = jest.fn()
const getState = jest.fn(() => ({ projects: [{ id: "p1" }] }))
const subscribe = jest.fn((listener: (state: unknown, prev: unknown) => void) => {
  storeListener = listener
  return unsubscribe
})
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: { getState: () => getState(), subscribe: (l: never) => subscribe(l) },
}))

import { ProjectKnowledgeWorkerInitializer } from "./project-kb-worker-initializer"

beforeEach(() => {
  jest.useFakeTimers()
  reconcile.mockClear()
  unsubscribe.mockClear()
  subscribe.mockClear()
  storeListener = undefined
})

afterEach(() => {
  jest.runOnlyPendingTimers()
  jest.useRealTimers()
})

describe("ProjectKnowledgeWorkerInitializer", () => {
  it("renders nothing and subscribes to the project store", () => {
    const { container } = render(<ProjectKnowledgeWorkerInitializer />)
    expect(container).toBeEmptyDOMElement()
    expect(subscribe).toHaveBeenCalledTimes(1)
  })

  it("reconciles the loaded projects after the debounce", () => {
    render(<ProjectKnowledgeWorkerInitializer />)
    expect(reconcile).not.toHaveBeenCalled()
    act(() => {
      jest.advanceTimersByTime(800)
    })
    expect(reconcile).toHaveBeenCalledWith([{ id: "p1" }])
  })

  it("re-reconciles when the projects array identity changes", () => {
    render(<ProjectKnowledgeWorkerInitializer />)
    act(() => jest.advanceTimersByTime(800))
    reconcile.mockClear()
    act(() => {
      storeListener?.({ projects: [{ id: "p2" }] }, { projects: [{ id: "p1" }] })
      jest.advanceTimersByTime(800)
    })
    expect(reconcile).toHaveBeenCalledTimes(1)
  })

  it("ignores store changes that don't touch the projects array", () => {
    render(<ProjectKnowledgeWorkerInitializer />)
    act(() => jest.advanceTimersByTime(800))
    reconcile.mockClear()
    const same = [{ id: "p1" }]
    act(() => {
      storeListener?.({ projects: same }, { projects: same })
      jest.advanceTimersByTime(800)
    })
    expect(reconcile).not.toHaveBeenCalled()
  })

  it("unsubscribes on unmount", () => {
    const { unmount } = render(<ProjectKnowledgeWorkerInitializer />)
    unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})
