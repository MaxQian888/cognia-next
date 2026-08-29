/**
 * @jest-environment jsdom
 *
 * Integration coverage for `!` shell intelligence through the REAL <Composer>.
 * `lib/shell-intelligence/*` proves the parsing, ranking and commitment rules
 * in isolation; this suite proves the wiring those rules ride on — that the
 * panel opens with real candidates, that Tab/arrows/Escape reach it, that
 * accepting rewrites the right span of the textarea, and that Enter still runs
 * the line no matter what the panel is showing.
 *
 * The acceptance scenarios from the plan live here:
 *   `! kub`         → kubectl
 *   `! cat ./sr`    → ./src/
 *   `! cat f | gre` → grep (the SECOND command's name, not a file for `cat`)
 *   `! abcdef …`    → underlined, and still runnable
 *   standalone web  → static spec completion, execution disabled
 */

import "fake-indexeddb/auto"

jest.mock("@/lib/slash-commands/custom", () => ({
  loadCustomSlashCommands: jest.fn(async () => []),
}))
jest.mock("@/lib/search/search-service", () => ({
  search: jest.fn(),
  formatSearchResultsForLLM: jest.fn(),
}))
jest.mock("@/lib/shell/exec", () => ({
  executeShell: jest.fn(),
  formatShellResult: jest.fn(() => "result"),
}))
jest.mock("@/lib/files/memory", () => ({ appendMemory: jest.fn() }))
jest.mock("./composer/voice-controls", () => ({ VoiceControls: () => null }))
jest.mock("@/hooks/use-platform", () => ({ usePlatform: jest.fn(() => "web") }))

const mockListPathExecutables = jest.fn(async (_o: { prefix: string }) => [] as string[])
const mockCompletePaths = jest.fn(
  async (_o: { fragment: string }) => [] as { name: string; isDir: boolean }[]
)
const mockExec = jest.fn(async () => ({
  stdout: "ok",
  stderr: "",
  exitCode: 0,
  timedOut: false,
}))
jest.mock("@/lib/terminal/remote-api", () => ({
  ...jest.requireActual("@/lib/terminal/remote-api"),
  listTerminalPathExecutables: (o: { prefix: string }) => mockListPathExecutables(o),
  completeTerminalPaths: (o: { fragment: string }) => mockCompletePaths(o),
  execTerminalCommand: (...a: unknown[]) => mockExec(...(a as [])),
}))

const mockTerminalAvailable = jest.fn(() => true)
jest.mock("@/lib/terminal/pick-transport", () => ({
  ...jest.requireActual("@/lib/terminal/pick-transport"),
  terminalAvailable: () => mockTerminalAvailable(),
}))

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"

import { TooltipProvider } from "@/components/ui/tooltip"
import { Composer } from "./composer"
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import type { DataAdapter } from "@/lib/data-hooks/types"
import { useChatStore } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import {
  __resetHostCapabilitiesForTests,
  recordHostCapabilities,
} from "@/lib/terminal/host-capabilities"
import type { ChatSession } from "@cognia/agent-config-types"

function makeAdapter(): DataAdapter {
  return {
    useCharacters: () => undefined,
    useCharacter: () => undefined,
    useSkillsByIds: () => undefined,
    usePresets: () => undefined,
    clearMessages: jest.fn(async () => undefined),
    updateSession: jest.fn(async () => undefined),
    recordPresetUsage: jest.fn(async () => undefined),
    trustWorkspace: jest.fn(async () => undefined),
  } as unknown as DataAdapter
}

function renderComposer() {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <DataAdapterProvider adapter={makeAdapter()}>
      <TooltipProvider>{children}</TooltipProvider>
    </DataAdapterProvider>
  )
  const session: ChatSession = {
    id: "ses_shell",
    title: "Shell",
    kind: "direct",
    permissionMode: undefined,
    createdAt: 0,
    updatedAt: 0,
    workingDir: "/tmp/work",
  }
  render(
    <Wrapper>
      <Composer
        session={session}
        onStartNewSession={async () => undefined}
        onOpenSettings={() => undefined}
        onSend={jest.fn()}
        onStop={async () => undefined}
      />
    </Wrapper>
  )
  return document.querySelector("textarea") as HTMLTextAreaElement
}

/** Type a value and let the trigger memo, the 80ms debounce and the query flush. */
async function typeValue(ta: HTMLTextAreaElement, value: string, settleMs = 250) {
  fireEvent.change(ta, {
    target: { value, selectionStart: value.length, selectionEnd: value.length },
  })
  await new Promise((r) => setTimeout(r, settleMs))
}

const rowTexts = () => screen.queryAllByRole("listitem").map((li) => li.textContent ?? "")

beforeEach(() => {
  useChatStore.getState().clear()
  useSettingsStore.setState({
    settings: {
      terminal: { autocomplete: { enabled: true }, defaultShell: "/bin/zsh" },
    },
  } as never)
  __resetHostCapabilitiesForTests()
  recordHostCapabilities({
    platform: "macos",
    defaultShell: "/bin/zsh",
    availableShells: [{ path: "/bin/zsh", kind: "zsh" }],
  })
  mockTerminalAvailable.mockReturnValue(true)
  mockListPathExecutables.mockReset().mockResolvedValue([])
  mockCompletePaths.mockReset().mockResolvedValue([])
  mockExec.mockClear()
})

describe("Composer — `!` completion", () => {
  it("`! kub` offers kubectl", async () => {
    mockListPathExecutables.mockResolvedValue(["kubectl", "kubectx"])
    const ta = renderComposer()
    await typeValue(ta, "! kub")
    await waitFor(() => expect(rowTexts().join(" ")).toContain("kubectl"))
  })

  it("`! cat ./sr` offers the directory with its separator", async () => {
    mockCompletePaths.mockResolvedValue([{ name: "src", isDir: true }])
    const ta = renderComposer()
    await typeValue(ta, "! cat ./sr")
    await waitFor(() => expect(rowTexts().join(" ")).toContain("src/"))
    expect(mockCompletePaths).toHaveBeenCalledWith(expect.objectContaining({ fragment: "./sr" }))
  })

  it("completes the command AFTER a pipe, not an argument of the first one", async () => {
    mockListPathExecutables.mockResolvedValue(["grep"])
    const ta = renderComposer()
    await typeValue(ta, "! cat foo | gre")
    await waitFor(() =>
      expect(mockListPathExecutables).toHaveBeenCalledWith(
        expect.objectContaining({ prefix: "gre" })
      )
    )
    expect(rowTexts().join(" ")).toContain("grep")
  })

  it("Tab accepts the highlighted candidate over the typed token", async () => {
    mockListPathExecutables.mockResolvedValue(["kubectl"])
    const ta = renderComposer()
    await typeValue(ta, "! kub")
    await waitFor(() => expect(rowTexts().join(" ")).toContain("kubectl"))
    fireEvent.keyDown(ta, { key: "Tab" })
    await waitFor(() => expect(ta.value).toBe("! kubectl "))
  })

  it("a directory acceptance keeps the caret inside it, ready for the next segment", async () => {
    mockCompletePaths.mockResolvedValue([{ name: "src", isDir: true }])
    const ta = renderComposer()
    await typeValue(ta, "! cat ./sr")
    await waitFor(() => expect(rowTexts().join(" ")).toContain("src/"))
    fireEvent.keyDown(ta, { key: "Tab" })
    await waitFor(() => expect(ta.value).toBe("! cat ./src/"))
  })

  it("arrows move the highlight and Tab takes the one that is highlighted", async () => {
    mockListPathExecutables.mockResolvedValue(["kubectl", "kubectx"])
    const ta = renderComposer()
    await typeValue(ta, "! kubect")
    await waitFor(() => expect(screen.queryAllByRole("listitem").length).toBeGreaterThan(1))
    const first = rowTexts()[0]
    fireEvent.keyDown(ta, { key: "ArrowDown" })
    fireEvent.keyDown(ta, { key: "Tab" })
    await waitFor(() => expect(ta.value).not.toBe(`! ${first} `))
    expect(ta.value.startsWith("! kubect")).toBe(true)
  })

  it("Escape closes the panel and leaves the typed line alone", async () => {
    mockListPathExecutables.mockResolvedValue(["kubectl"])
    const ta = renderComposer()
    await typeValue(ta, "! kub")
    await waitFor(() => expect(rowTexts().join(" ")).toContain("kubectl"))
    fireEvent.keyDown(ta, { key: "Escape" })
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(ta.value).toBe("! kub")
  })

  it("does not steal a completion key mid-IME-composition", async () => {
    mockListPathExecutables.mockResolvedValue(["kubectl"])
    const ta = renderComposer()
    await typeValue(ta, "! kub")
    await waitFor(() => expect(rowTexts().join(" ")).toContain("kubectl"))
    fireEvent.compositionStart(ta)
    fireEvent.keyDown(ta, { key: "Enter", isComposing: true })
    expect(ta.value).toBe("! kub")
    expect(mockExec).not.toHaveBeenCalled()
  })

  it("runs the line under the CONFIGURED shell, not the host's platform shell", async () => {
    const ta = renderComposer()
    await typeValue(ta, "!echo hi")
    fireEvent.keyDown(ta, { key: "Enter" })
    await waitFor(() =>
      expect(mockExec).toHaveBeenCalledWith(
        expect.objectContaining({ command: "/bin/zsh", args: ["-lc", "echo hi"] })
      )
    )
  })

  it("an unknown command is underlined but still runs — diagnostics never block Enter", async () => {
    mockListPathExecutables.mockResolvedValue([])
    const ta = renderComposer()
    await typeValue(ta, "! abcdef get pods", 400)
    await waitFor(() =>
      expect(
        screen.getByTestId("shell-diagnostic-overlay").querySelector("[data-diagnostic]")
      ).toHaveTextContent("abcdef")
    )
    fireEvent.keyDown(ta, { key: "Enter" })
    await waitFor(() => expect(mockExec).toHaveBeenCalled())
  })

  it("without a Host it still completes known CLIs, and refuses to run", async () => {
    mockTerminalAvailable.mockReturnValue(false)
    const ta = renderComposer()
    await typeValue(ta, "! git rem")
    await waitFor(() => expect(rowTexts().join(" ")).toContain("remote"))
    // Static specs answered; nothing was asked of a Host that is not there.
    expect(mockCompletePaths).not.toHaveBeenCalled()
    expect(mockListPathExecutables).not.toHaveBeenCalled()
    fireEvent.keyDown(ta, { key: "Enter" })
    await new Promise((r) => setTimeout(r, 50))
    expect(mockExec).not.toHaveBeenCalled()
  })

  it("leaves `!` mode exactly as it was when the master switch is off", async () => {
    useSettingsStore.setState({
      settings: { terminal: { autocomplete: { enabled: false }, defaultShell: "/bin/zsh" } },
    } as never)
    mockListPathExecutables.mockResolvedValue(["kubectl"])
    const ta = renderComposer()
    await typeValue(ta, "! kub")
    expect(rowTexts().join(" ")).not.toContain("kubectl")
    expect(mockListPathExecutables).not.toHaveBeenCalled()
    // And it says NOTHING about completions. `autocomplete.enabled` ships
    // false, so "No completions for “kub”" would be the default experience —
    // and it would be a lie: none were looked up. The hint is the whole panel,
    // exactly as `!` mode was before this feature.
    expect(screen.queryByText(/No completions/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Connect a Host/i)).not.toBeInTheDocument()
    fireEvent.keyDown(ta, { key: "Enter" })
    await waitFor(() => expect(mockExec).toHaveBeenCalled())
  })
})
