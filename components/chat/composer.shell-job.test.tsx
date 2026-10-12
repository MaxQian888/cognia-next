/**
 * @jest-environment jsdom
 *
 * A `!` line through the REAL <Composer>: it starts as a supervised job owned
 * by the conversation, posts a live card and hands the job to a run; a Host
 * without the job command still runs the line through the capture path; and a
 * refused spawn is reported, not silently retried another way.
 *
 * The job module's rules (argv, approval, missing-command detection) are
 * `lib/shell-intelligence/shell-job.test.ts`; the run is
 * `shell-job-run.test.ts`. This suite is the wiring between them.
 */

import "fake-indexeddb/auto"

jest.setTimeout(30_000)

jest.mock("@/lib/slash-commands/custom", () => ({
  loadCustomSlashCommands: jest.fn(async () => []),
}))
jest.mock("@/lib/search/search-service", () => ({
  search: jest.fn(),
  formatSearchResultsForLLM: jest.fn(),
}))
jest.mock("@/lib/shell/exec", () => ({
  executeShell: jest.fn(),
  formatShellResult: jest.fn(() => "captured result"),
}))
jest.mock("@/lib/files/memory", () => ({ appendMemory: jest.fn() }))
jest.mock("./composer/voice-controls", () => ({ VoiceControls: () => null }))
jest.mock("./composer/attach-menu", () => ({ ComposerAttachMenu: () => null }))
jest.mock("@/hooks/use-platform", () => ({ usePlatform: jest.fn(() => "web") }))

const mockExec = jest.fn(async () => ({ stdout: "ok", stderr: "", exitCode: 0, timedOut: false }))
jest.mock("@/lib/terminal/remote-api", () => ({
  ...jest.requireActual("@/lib/terminal/remote-api"),
  listTerminalPathExecutables: jest.fn(async () => []),
  completeTerminalPaths: jest.fn(async () => []),
  execTerminalCommand: (...a: unknown[]) => mockExec(...(a as [])),
}))
jest.mock("@/lib/terminal/pick-transport", () => ({
  ...jest.requireActual("@/lib/terminal/pick-transport"),
  terminalAvailable: () => true,
}))

const mockSpawn = jest.fn()
jest.mock("@/lib/jobs/background-jobs", () => ({
  ...jest.requireActual("@/lib/jobs/background-jobs"),
  spawnSessionBackgroundJob: (...a: unknown[]) => mockSpawn(...a),
}))

const mockUpsert = jest.fn(async () => undefined)
jest.mock("@/lib/chat/shell-job-transcript", () => ({
  shellJobTranscript: { upsert: (...a: unknown[]) => mockUpsert(...(a as [])) },
}))

const mockStartRun = jest.fn()
jest.mock("@/lib/shell-intelligence/shell-job-run", () => ({
  ...jest.requireActual("@/lib/shell-intelligence/shell-job-run"),
  startShellJobRun: (...a: unknown[]) => mockStartRun(...a),
}))

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
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
import { setRuntimeSnapshot } from "@/lib/runtime/runtime-snapshot-store"
import { getCommandDescriptor } from "@/lib/tauri/command-descriptors"
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

const session: ChatSession = {
  id: "ses_shell",
  title: "Shell",
  kind: "direct",
  permissionMode: undefined,
  createdAt: 0,
  updatedAt: 0,
  workingDir: "/tmp/work",
}

function renderComposer() {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <DataAdapterProvider adapter={makeAdapter()}>
      <TooltipProvider>{children}</TooltipProvider>
    </DataAdapterProvider>
  )
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

async function runLine(ta: HTMLTextAreaElement, value: string) {
  await act(async () => {
    fireEvent.change(ta, {
      target: { value, selectionStart: value.length, selectionEnd: value.length },
    })
    await new Promise((r) => setTimeout(r, 100))
  })
  await act(async () => {
    fireEvent.keyDown(ta, { key: "Enter" })
    await new Promise((r) => setTimeout(r, 50))
  })
}

const systemTexts = () =>
  (useChatStore.getState().sessions[session.id]?.messages ?? useChatStore.getState().messages)
    .filter((m) => m.role === "system")
    .flatMap((m) => m.parts)
    .map((p) => (p as { text?: string }).text ?? "")

beforeEach(() => {
  useChatStore.getState().clear()
  useSettingsStore.setState({
    settings: { terminal: { autocomplete: { enabled: false }, defaultShell: "/bin/zsh" } },
  } as never)
  __resetHostCapabilitiesForTests()
  recordHostCapabilities({
    platform: "macos",
    defaultShell: "/bin/zsh",
    availableShells: [{ path: "/bin/zsh", kind: "zsh" }],
  })
  setRuntimeSnapshot({
    target: { id: "web-companion-test", kind: "companion", hostKind: "desktop", platform: "web" },
    vaultState: "unlocked",
    connectionState: "online",
    host: {
      compatible: true,
      operations: ["terminal_exec"],
      grants: [getCommandDescriptor("terminal_exec")?.capability ?? "terminal.open"],
    },
  })
  mockExec.mockClear()
  mockSpawn.mockReset()
  mockUpsert.mockClear()
  mockStartRun.mockReset()
})

describe("Composer — `!` lines as background jobs", () => {
  it("spawns the line as a job, posts its card and starts the run", async () => {
    mockSpawn.mockResolvedValue({ id: "job-7", status: "running" })
    const ta = renderComposer()
    await runLine(ta, "! pnpm build")

    await waitFor(() => expect(mockStartRun).toHaveBeenCalled())
    expect(mockSpawn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "ses_shell",
        command: "pnpm build",
        program: "/bin/zsh",
        args: ["-lc", "pnpm build"],
        cwd: "/tmp/work",
      })
    )
    const block = {
      kind: "shell-job",
      jobId: "job-7",
      sessionId: "ses_shell",
      command: "pnpm build",
      cwd: "/tmp/work",
    }
    expect(mockUpsert).toHaveBeenCalledWith("ses_shell", {
      id: "sys-shell-job-7",
      role: "system",
      parts: [{ type: "data-diagnostics", data: block }],
    })
    // The card is in before the run can rewrite it.
    expect(mockUpsert.mock.invocationCallOrder[0]).toBeLessThan(
      mockStartRun.mock.invocationCallOrder[0]
    )
    expect(mockStartRun.mock.calls[0][0]).toEqual(block)
    expect(mockExec).not.toHaveBeenCalled()
  })

  it("falls back to the capture path on a Host without the job command", async () => {
    mockSpawn.mockRejectedValue(
      Object.assign(new Error("the requested command is not registered"), {
        code: "unknown_command",
      })
    )
    const ta = renderComposer()
    await runLine(ta, "! ls")

    await waitFor(() => expect(mockExec).toHaveBeenCalled())
    expect(mockStartRun).not.toHaveBeenCalled()
    expect(mockExec).toHaveBeenCalledWith(
      expect.objectContaining({ command: "/bin/zsh", args: ["-lc", "ls"], timeoutMs: 120_000 })
    )
  })

  it("reports a refused spawn instead of running the line another way", async () => {
    mockSpawn.mockRejectedValue(new Error("at most 8 background jobs may run at once"))
    const ta = renderComposer()
    await runLine(ta, "! make")

    await waitFor(() =>
      expect(systemTexts().join("\n")).toContain("at most 8 background jobs may run at once")
    )
    expect(mockExec).not.toHaveBeenCalled()
    expect(mockStartRun).not.toHaveBeenCalled()
    expect(screen.queryByText(/captured result/)).toBeNull()
  })
})
