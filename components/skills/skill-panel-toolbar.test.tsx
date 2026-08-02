/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

jest.mock("@/lib/tauri", () => ({
  isTauri: () => false,
}))

const checkAllMock = jest.fn(async () => 0)
jest.mock("@/hooks/skills", () => ({
  useSkillSync: () => ({ busy: false, push: jest.fn(), pull: jest.fn(), pushOne: jest.fn() }),
  useSkillUpdate: () => ({
    statuses: {},
    checkAll: checkAllMock,
    updateOne: jest.fn(),
    checking: false,
    updatingId: null,
    hasUpdate: () => false,
  }),
}))

jest.mock("@/lib/db/skills", () => ({
  listSkills: jest.fn(async () => []),
}))

jest.mock("@/lib/files/file-bridge", () => ({
  pickAndReadFiles: jest.fn(async () => []),
}))

jest.mock("@/lib/claude/skills-io", () => ({
  parseSkillMarkdown: jest.fn(),
  nameFromFilename: (s: string) => s,
}))

jest.mock("@/lib/claude/ipc", () => ({
  scanClaudeSkills: jest.fn(async () => []),
}))

jest.mock("@/lib/skills/export-toast", () => ({
  exportSkillsToDirWithFeedback: jest.fn(),
}))

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() },
}))

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { toast } from "sonner"
import { useSkillsStore } from "@/stores/skills"
import {
  __resetRecorderAvailabilityForTesting,
  setRecorderAvailability,
} from "@/lib/skills/recording/recorder-availability"
import { useRecorderStore } from "@/stores/skills/recorder-store"
import { SkillPanelToolbar } from "./skill-panel-toolbar"

beforeEach(() => {
  jest.clearAllMocks()
})

describe("SkillPanelToolbar", () => {
  it("renders the 'New' and 'Import' triggers with localized labels", () => {
    render(<SkillPanelToolbar />)
    expect(screen.getByText("new")).toBeInTheDocument()
    expect(screen.getByText("import")).toBeInTheDocument()
  })

  it("collapses export + sync into a More-actions menu trigger at narrow widths", () => {
    render(<SkillPanelToolbar />)
    // The aria-labeled overflow trigger is mounted alongside the inline buttons; both share
    // the underlying actions so we just confirm the trigger exists and uses the localized label.
    expect(screen.getByLabelText("moreActions")).toBeInTheDocument()
  })

  it("'Check for updates' runs the scan and reports the up-to-date toast", async () => {
    checkAllMock.mockResolvedValueOnce(0)
    render(<SkillPanelToolbar />)
    fireEvent.click(screen.getByTestId("skill-panel-toolbar-check-updates"))
    await waitFor(() => expect(checkAllMock).toHaveBeenCalled())
    expect(toast.info).toHaveBeenCalledWith("updatesNone")
  })

  it("'Check for updates' reports the found-count toast when updates exist", async () => {
    checkAllMock.mockResolvedValueOnce(3)
    render(<SkillPanelToolbar />)
    fireEvent.click(screen.getByTestId("skill-panel-toolbar-check-updates"))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('updatesFound:{"count":3}'))
  })

  it("'Check for updates' surfaces scan failures as an error toast", async () => {
    checkAllMock.mockRejectedValueOnce(new Error("offline"))
    render(<SkillPanelToolbar />)
    fireEvent.click(screen.getByTestId("skill-panel-toolbar-check-updates"))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('updatesError:{"error":"offline"}')
    )
  })

  it("exposes the Install-from-URL entry inside the Import menu", async () => {
    const user = userEvent.setup()
    render(<SkillPanelToolbar />)
    await user.click(screen.getByText("import"))
    const item = await screen.findByTestId("skill-panel-toolbar-install-from-url")
    await user.click(item)
    expect(useSkillsStore.getState().urlInstallOpen).toBe(true)
    useSkillsStore.setState({ urlInstallOpen: false })
  })
})

describe("the Record Skill entry", () => {
  beforeEach(() => {
    __resetRecorderAvailabilityForTesting()
    useRecorderStore.getState().reset()
  })

  it("is absent until the owning plugin publishes", () => {
    // Gated on the plugin, not on `isTauri()`: the plugin holds the native
    // grants, so disabling it must take every entry point with it.
    render(<SkillPanelToolbar />)
    expect(screen.queryByText("entry.toolbarButton")).not.toBeInTheDocument()
  })

  it("appears once the plugin publishes, and opens the global recorder", async () => {
    setRecorderAvailability({ available: true, pluginId: "cognia-skill-recorder" })
    render(<SkillPanelToolbar />)
    await userEvent.click(screen.getByText("entry.toolbarButton"))
    expect(useRecorderStore.getState().sheetOpen).toBe(true)
    expect(useRecorderStore.getState().phase).toBe("setup")
  })

  it("disappears again when the plugin is turned off", async () => {
    setRecorderAvailability({ available: true, pluginId: "cognia-skill-recorder" })
    render(<SkillPanelToolbar />)
    await act(async () => {
      setRecorderAvailability({ available: false, pluginId: null })
    })
    expect(screen.queryByText("entry.toolbarButton")).not.toBeInTheDocument()
  })
})
