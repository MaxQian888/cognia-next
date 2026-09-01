/**
 * @jest-environment jsdom
 */

import type { SkillValidationError } from "@cognia/agent-config-types"
import type { SkillResourceDraft } from "@/lib/db/skill-resources"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

jest.mock("@/lib/tauri", () => ({
  isTauri: () => false,
}))

// The host-skills predicates, not `isTauri()`, decide whether the native-sync
// control is live: the commands behind it are remote-reachable, so a browser or
// phone driving a paired Host can use it.
const hostSkillsRef = { read: false, write: false }
jest.mock("@/lib/skills/sync", () => ({
  canReadHostSkills: () => hostSkillsRef.read,
  canWriteHostSkills: () => hostSkillsRef.write,
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
  pickAndReadBinaryFiles: jest.fn(async () => []),
  pickDirectory: jest.fn(async () => null),
}))

jest.mock("@/lib/skills/bundle/loader", () => ({
  loadBundle: jest.fn(),
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
import { pickAndReadBinaryFiles } from "@/lib/files/file-bridge"
import { loadBundle } from "@/lib/skills/bundle/loader"
import {
  __resetRecorderAvailabilityForTesting,
  setRecorderAvailability,
} from "@/lib/skills/recording/recorder-availability"
import { useRecorderStore } from "@/stores/skills/recorder-store"
import { SkillPanelToolbar } from "./skill-panel-toolbar"

const mockPickAndReadBinaryFiles = pickAndReadBinaryFiles as jest.MockedFunction<
  typeof pickAndReadBinaryFiles
>
const mockLoadBundle = loadBundle as jest.MockedFunction<typeof loadBundle>

beforeEach(() => {
  jest.clearAllMocks()
  useSkillsStore.setState({ importStaging: null })
  hostSkillsRef.read = false
  hostSkillsRef.write = false
})

describe("SkillPanelToolbar", () => {
  it("renders the 'New' and 'Import' triggers with localized labels", () => {
    render(<SkillPanelToolbar />)
    expect(screen.getByText("new")).toBeInTheDocument()
    expect(screen.getByText("import")).toBeInTheDocument()
  })

  it("offers native sync to a client whose host serves its skills directory", () => {
    hostSkillsRef.read = true
    hostSkillsRef.write = true
    render(<SkillPanelToolbar />)

    const sync = screen.getByTitle("syncNative")
    expect(sync).toBeEnabled()
  })

  it("says the host cannot serve skills, not that this is not a desktop", () => {
    render(<SkillPanelToolbar />)

    // `unavailableRead` is the sentence `useSkillSync` has always shown when it
    // actually refuses. The old title claimed "requires desktop mode", which is
    // wrong for a phone paired to a Host that can serve them.
    const sync = screen.getByTitle("unavailableRead")
    expect(sync).toBeDisabled()
    expect(screen.queryByTitle("syncNativeDesktopOnly")).not.toBeInTheDocument()
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

  it("stages every portable bundle field when importing a zip", async () => {
    const user = userEvent.setup()
    const bytes = new Uint8Array([1, 2, 3])
    const resources: Array<Omit<SkillResourceDraft, "skillId">> = [
      {
        name: "run.sh",
        path: "scripts/run.sh",
        content: "echo ok",
        encoding: "utf-8",
        kind: "script",
      },
    ]
    const validationErrors: SkillValidationError[] = [
      {
        severity: "portability",
        code: "unknown",
        message: "Review compatibility",
      },
    ]
    mockPickAndReadBinaryFiles.mockResolvedValueOnce([{ name: "portable.zip", path: "", bytes }])
    mockLoadBundle.mockResolvedValueOnce({
      draft: {
        name: "Portable Skill",
        slug: "portable-skill",
        description: "Portable description",
        compatibility: "Requires git",
        metadata: { owner: "Cognia" },
        invocationPolicy: "explicit",
        frontmatterExtensions: { custom: { enabled: true } },
        codexOpenAiYaml: "interface:\n  display_name: Portable Skill\n",
        content: "# Portable Skill",
        tags: ["portable"],
        allowedTools: ["Read"],
        category: "productivity",
      },
      resources,
      flavor: "codex",
      nonFatalValidationErrors: validationErrors,
      warnings: [],
    })

    render(<SkillPanelToolbar />)
    await user.click(screen.getByText("import"))
    await user.click(await screen.findByTestId("skill-panel-toolbar-import-bundle-zip"))

    await waitFor(() => expect(useSkillsStore.getState().importStaging).not.toBeNull())
    expect(mockLoadBundle).toHaveBeenCalledWith({
      kind: "zip-blob",
      bytes,
      fallbackName: "portable",
    })
    expect(useSkillsStore.getState().importStaging).toEqual({
      drafts: [
        {
          name: "Portable Skill",
          slug: "portable-skill",
          description: "Portable description",
          compatibility: "Requires git",
          metadata: { owner: "Cognia" },
          invocationPolicy: "explicit",
          frontmatterExtensions: { custom: { enabled: true } },
          codexOpenAiYaml: "interface:\n  display_name: Portable Skill\n",
          content: "# Portable Skill",
          tags: ["portable"],
          allowedTools: ["Read"],
          category: "productivity",
          canonicalId: "bundle:zip:portable-skill",
          resources,
          validationErrors,
        },
      ],
      sourceLabel: "portable.zip",
      parseErrors: [],
      flavor: "codex",
    })
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
