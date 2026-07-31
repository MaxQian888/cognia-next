/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { PluginsPanel } from "./plugins-panel"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: jest.fn(),
}))

jest.mock("@/lib/db/schema", () => {
  const plugins = {
    update: jest.fn().mockResolvedValue(undefined),
    toArray: jest.fn().mockResolvedValue([]),
  }
  return { getDb: () => ({ plugins }) }
})

jest.mock("@/lib/db/mobile-outbound-queue", () => ({
  enqueue: jest.fn().mockResolvedValue(undefined),
}))

jest.mock("sonner", () => ({
  toast: { error: jest.fn(), success: jest.fn(), info: jest.fn() },
}))

import { useLiveQuery } from "dexie-react-hooks"
import { getDb } from "@/lib/db/schema"
import { enqueue } from "@/lib/db/mobile-outbound-queue"

const useLiveQueryMock = useLiveQuery as jest.Mock
const updateMock = getDb().plugins.update as jest.Mock
const enqueueMock = enqueue as jest.Mock

beforeEach(() => {
  useLiveQueryMock.mockReset()
  updateMock.mockClear()
  enqueueMock.mockClear()
})

describe("PluginsPanel", () => {
  it("renders the empty message when there are no plugins", () => {
    useLiveQueryMock.mockReturnValue([])
    render(<PluginsPanel />)
    expect(screen.getByText("empty")).toBeInTheDocument()
    expect(screen.queryByTestId("plugins-panel")).not.toBeInTheDocument()
  })

  it("renders a row with a version badge per installed plugin", () => {
    useLiveQueryMock.mockReturnValue([
      { id: "p1", name: "Web Tools", version: "1.2.0", enabled: true },
      { id: "p2", enabled: false },
    ])
    render(<PluginsPanel />)
    expect(screen.getByTestId("plugins-panel")).toBeInTheDocument()
    expect(screen.getByText("Web Tools")).toBeInTheDocument()
    expect(screen.getByText("v1.2.0")).toBeInTheDocument()
    // p2 falls back to its id for the display name.
    expect(screen.getByText("p2")).toBeInTheDocument()
  })

  it("persists and enqueues a toggle when the switch flips", async () => {
    useLiveQueryMock.mockReturnValue([{ id: "p1", name: "Web Tools", enabled: false }])
    const user = userEvent.setup()
    render(<PluginsPanel />)
    await user.click(screen.getByTestId("plugin-switch-p1"))
    expect(updateMock).toHaveBeenCalledWith("p1", expect.objectContaining({ enabled: true }))
    expect(enqueueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "plugin_set_enabled",
        payload: { id: "p1", enabled: true },
      })
    )
  })
})
