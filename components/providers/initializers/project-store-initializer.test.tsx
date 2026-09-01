/**
 * @jest-environment jsdom
 */
import { render, waitFor } from "@testing-library/react"

const loadMock = jest.fn(async () => undefined)
const adoptMock = jest.fn()
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: {
    getState: () => ({ load: loadMock, adoptPersistedProjects: adoptMock }),
  },
}))
jest.mock("@cognia/logging", () => ({
  loggers: { shell: { warn: jest.fn(), info: jest.fn(), error: jest.fn() } },
}))

const getAllProjectsMock = jest.fn(async () => [{ id: "ws1", name: "Synced" }])
jest.mock("@/lib/db/projects", () => ({
  getAllProjects: () => getAllProjectsMock(),
}))

// `Dexie.liveQuery` rather than the named export, which is undefined under
// Jest's module interop. Stubbed here so the subscription is observable.
const unsubscribe = jest.fn()
let emit: ((rows: unknown) => void) | null = null
jest.mock("dexie", () => ({
  __esModule: true,
  default: {
    liveQuery: (query: () => Promise<unknown>) => ({
      subscribe: ({ next }: { next: (rows: unknown) => void }) => {
        emit = next
        void query().then((rows) => next(rows))
        return { unsubscribe }
      },
    }),
  },
}))

import { ProjectStoreInitializer } from "./project-store-initializer"

beforeEach(() => {
  loadMock.mockClear()
  adoptMock.mockClear()
  unsubscribe.mockClear()
  emit = null
})

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

  it("pushes workspaces that arrive after boot into the store", async () => {
    // `load()` returns early once it has run, and `projects` is companion
    // synced, so on a paired phone the Host's workspaces land in Dexie after
    // boot. Without this subscription they stayed invisible to the switcher
    // until the app was restarted.
    render(<ProjectStoreInitializer />)
    await waitFor(() => expect(adoptMock).toHaveBeenCalledWith([{ id: "ws1", name: "Synced" }]))

    emit?.([{ id: "ws2", name: "Later" }])
    expect(adoptMock).toHaveBeenLastCalledWith([{ id: "ws2", name: "Later" }])
  })

  it("drops the subscription on unmount", async () => {
    const { unmount } = render(<ProjectStoreInitializer />)
    await waitFor(() => expect(adoptMock).toHaveBeenCalled())
    unmount()
    expect(unsubscribe).toHaveBeenCalled()
  })

  it("renders nothing", () => {
    const { container } = render(<ProjectStoreInitializer />)
    expect(container).toBeEmptyDOMElement()
  })
})
