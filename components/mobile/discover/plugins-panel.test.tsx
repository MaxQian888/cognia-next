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

jest.mock("@/lib/plugin/core/set-plugin-enabled-for-host", () => ({
  setPluginEnabledForHost: jest.fn().mockResolvedValue({ ok: true, queued: false }),
}))

jest.mock("sonner", () => ({
  toast: { error: jest.fn(), success: jest.fn(), info: jest.fn() },
}))

import { useLiveQuery } from "dexie-react-hooks"
import { getDb } from "@/lib/db/schema"
import { enqueue } from "@/lib/db/mobile-outbound-queue"
import { setPluginEnabledForHost } from "@/lib/plugin/core/set-plugin-enabled-for-host"

const useLiveQueryMock = useLiveQuery as jest.Mock
const updateMock = getDb().plugins.update as jest.Mock
const enqueueMock = enqueue as jest.Mock
const setEnabledMock = setPluginEnabledForHost as jest.Mock

beforeEach(() => {
  useLiveQueryMock.mockReset()
  updateMock.mockClear()
  enqueueMock.mockClear()
  setEnabledMock.mockClear().mockResolvedValue({ ok: true, queued: false })
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

  // This panel used to write Dexie and enqueue `plugin_set_enabled`
  // unconditionally, which is right on a paired phone and wrong on a desktop
  // or a standalone browser. Where a toggle goes is one decision, and it lives
  // in `setPluginEnabledForHost`.
  it("delegates a toggle to the host-aware seam", async () => {
    useLiveQueryMock.mockReturnValue([{ id: "p1", name: "Web Tools", enabled: false }])
    const user = userEvent.setup()
    render(<PluginsPanel />)
    await user.click(screen.getByTestId("plugin-switch-p1"))
    expect(setEnabledMock).toHaveBeenCalledWith("p1", true)
    expect(updateMock).not.toHaveBeenCalled()
    expect(enqueueMock).not.toHaveBeenCalled()
  })

  it("surfaces a failed toggle as a toast", async () => {
    setEnabledMock.mockResolvedValue({ ok: false, queued: false, error: "no runtime" })
    useLiveQueryMock.mockReturnValue([{ id: "p1", name: "Web Tools", enabled: false }])
    const user = userEvent.setup()
    render(<PluginsPanel />)
    await user.click(screen.getByTestId("plugin-switch-p1"))
    const { toast } = jest.requireMock("sonner") as { toast: { error: jest.Mock } }
    expect(toast.error).toHaveBeenCalledWith("toggleFailed")
  })
})
