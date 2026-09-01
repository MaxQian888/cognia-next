import { fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { TooltipProvider } from "@/components/ui/tooltip"
import { toast } from "sonner"

import type { ChatSession } from "@cognia/agent-config-types"

const acknowledge = jest.fn(async (_id: string) => {})
const resumeNative = jest.fn()
const setRuntimeRef = jest.fn()
const setSessionComposition = jest.fn()
jest.mock("@/lib/db/sessions", () => ({
  acknowledgeImportDivergence: (id: string) => acknowledge(id),
}))
jest.mock("@/lib/session-import/native-resume", () => ({
  resumeImportedSessionNative: (...args: unknown[]) => resumeNative(...args),
}))
jest.mock("@/stores/agent/agent-runtime-store", () => ({
  compositionForSession: () => ({ presetId: "standard" }),
  useAgentRuntimeStore: {
    getState: () => ({ setRuntimeRef, setSessionComposition }),
  },
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string, vals?: Record<string, unknown>) =>
    vals ? `${ns}.${key}:${JSON.stringify(vals)}` : `${ns}.${key}`,
}))

import { ImportedOriginChip } from "./imported-origin-chip"

const toastSuccess = toast.success as jest.Mock
const toastError = toast.error as jest.Mock

// `TooltipProvider` is mounted app-wide in `app/layout.tsx`; supply it here.
const render = (ui: React.ReactElement) =>
  rtlRender(<TooltipProvider delayDuration={0}>{ui}</TooltipProvider>)

function session(over: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "import:claude-code:abc",
    title: "Fix the parser",
    createdAt: 0,
    updatedAt: 0,
    importSource: "claude-code",
    importSourceLabel: "Claude Code",
    ...over,
  } as ChatSession
}

beforeEach(() => {
  acknowledge.mockClear()
  resumeNative.mockReset()
  setRuntimeRef.mockClear()
  setSessionComposition.mockClear()
  toastSuccess.mockClear()
  toastError.mockClear()
})

describe("ImportedOriginChip", () => {
  it("renders nothing for a native session", () => {
    const { container } = render(
      <ImportedOriginChip
        session={{ id: "s1", title: "x", createdAt: 0, updatedAt: 0 } as ChatSession}
      />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it("names a built-in source from the message catalogue, not the stored label", () => {
    render(<ImportedOriginChip session={session()} />)
    // The catalogue entry is what makes the label localized.
    expect(screen.getByTestId("imported-origin-chip")).toHaveTextContent(
      "sessionImport.sources.claude-code"
    )
  })

  it("keeps the persisted fidelity and canonical state inspectable after import", async () => {
    const user = userEvent.setup()
    render(
      <ImportedOriginChip
        session={session({
          importSourceVersion: "2.1.0",
          importRelation: { kind: "background", parentCanonicalSessionId: "parent" },
          importLifecycle: { status: "running", background: true },
          importLossReport: {
            fidelity: "structured",
            losses: [{ path: "events.unknown", kind: "omitted", detail: "redacted" }],
          },
          importCanonicalState: {
            tasks: [{ taskId: "task-1", status: "running" }],
            plans: [],
            goals: [],
            history: [],
            checkpoints: [],
            interAgentMessages: [],
            recordedEvents: [],
            permissions: [],
          },
        })}
      />
    )

    await user.hover(screen.getByTestId("imported-origin-chip"))
    expect(await screen.findByTestId("fidelity-report")).toBeInTheDocument()
    expect(screen.getByTestId("source-version")).toHaveTextContent("2.1.0")
    expect(screen.getByTestId("session-relationship")).toHaveTextContent("background")
    expect(screen.getByTestId("imported-canonical-state-summary")).toHaveTextContent('count":1')
  })

  it("uses the stamped label for a plugin source instead of a raw key path", () => {
    render(
      <ImportedOriginChip
        session={session({
          id: "import:acme:cursor:1",
          importSource: "acme:cursor",
          importSourceLabel: "Cursor (Acme)",
        })}
      />
    )
    expect(screen.getByTestId("imported-origin-chip")).toHaveTextContent("Cursor (Acme)")
  })

  it("still identifies a row imported before importSource existed", () => {
    render(
      <ImportedOriginChip
        session={session({ importSource: undefined, importSourceLabel: undefined })}
      />
    )
    expect(screen.getByTestId("imported-origin-chip")).toHaveTextContent("unknownSource")
  })

  it("warns when the source diverged after Cognia took ownership", () => {
    render(<ImportedOriginChip session={session({ importFrozen: true, importDiverged: true })} />)
    expect(screen.getByTestId("imported-diverged-chip")).toBeInTheDocument()
    expect(screen.queryByTestId("imported-origin-chip")).not.toBeInTheDocument()
  })

  it("acknowledging the divergence clears it", () => {
    render(<ImportedOriginChip session={session({ importDiverged: true })} />)
    fireEvent.click(screen.getByTestId("imported-diverged-chip"))
    expect(acknowledge).toHaveBeenCalledWith("import:claude-code:abc")
  })

  it("verifies native resume before selecting the external runtime", async () => {
    resumeNative.mockResolvedValue({ ok: true, agentId: "agent-1", nativeSessionId: "native-1" })
    const imported = session({
      importOwnership: "source-mirror",
      importRuntimeBinding: { nativeSessionId: "native-1", presetId: "claude-code" },
    })
    render(<ImportedOriginChip session={imported} />)
    fireEvent.click(screen.getByTestId("imported-native-resume"))
    await waitFor(() => expect(resumeNative).toHaveBeenCalledWith(imported))
    expect(setSessionComposition).toHaveBeenCalledWith(imported.id, {
      presetId: "standard",
      runtimeBindingRef: "native-1",
    })
    // One write picks the lane AND the agent, so the chip can no longer leave
    // the composer on an external lane with nothing selected.
    expect(setRuntimeRef).toHaveBeenCalledWith({ kind: "external", agentId: "agent-1" })
  })

  it("keeps the current runtime when native resume verification fails", async () => {
    resumeNative.mockResolvedValue({ ok: false, code: "cwd-missing", detail: "/gone" })
    render(
      <ImportedOriginChip
        session={session({
          importRuntimeBinding: { nativeSessionId: "native-1", presetId: "claude-code" },
        })}
      />
    )
    fireEvent.click(screen.getByTestId("imported-native-resume"))
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(setRuntimeRef).not.toHaveBeenCalled()
  })
})
