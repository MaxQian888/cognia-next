/** @jest-environment jsdom */

// "Build with AI", step one (ADR-0220): the runtime and model pickers bound to
// a pristine builder session, and the start button that stamps the chosen
// runtime on the draft. The pickers and the drafts list are stubbed probes.

import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { AgentBuilderDraft, ChatSession } from "@cognia/agent-config-types"

jest.mock("sonner", () => ({ toast: { error: jest.fn(), success: jest.fn() } }))
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: jest.fn() }))
jest.mock("@/lib/db/schema", () => ({ getDb: jest.fn() }))
jest.mock("@/lib/chat/start-session", () => ({ startNewSession: jest.fn() }))
jest.mock("@/lib/agents/builder/builder-session", () => ({
  ensureSetupBuilderSession: jest.fn(),
  writeBuilderDraft: jest.fn(),
}))
jest.mock("@/lib/agents/runtime-binding", () => ({ runtimeBindingFromRef: jest.fn() }))
jest.mock("@/stores/settings", () => ({ useSettingsStore: jest.fn() }))
jest.mock("@/stores/agent/agent-runtime-store", () => ({ useRuntimeRefForSession: jest.fn() }))
jest.mock("@/hooks/agent/use-agent-runtime-catalog", () => ({ useAgentRuntimeCatalog: jest.fn() }))
jest.mock("@/hooks/agents/use-builder-tool-support", () => ({ useBuilderToolSupport: jest.fn() }))
jest.mock("@/components/agent/mode/runtime-selector", () => ({
  AgentRuntimeSelector: (props: { variant?: string; sessionId: string; providerId: string }) => (
    <div
      data-testid="runtime-selector"
      data-variant={props.variant}
      data-session={props.sessionId}
      data-provider={props.providerId}
    />
  ),
}))
jest.mock("@/components/chat/composer/model-picker", () => ({
  ModelPicker: (props: { session: ChatSession }) => (
    <div data-testid="model-picker" data-session={props.session.id} />
  ),
}))
let draftsOnResume: ((id: string) => void) | undefined
jest.mock("./agent-builder-drafts", () => ({
  AgentBuilderDrafts: (props: { onResume: (id: string) => void }) => {
    draftsOnResume = props.onResume
    return <div data-testid="drafts" />
  },
}))

import { toast } from "sonner"
import { useLiveQuery } from "dexie-react-hooks"
import { getDb } from "@/lib/db/schema"
import { startNewSession } from "@/lib/chat/start-session"
import { ensureSetupBuilderSession, writeBuilderDraft } from "@/lib/agents/builder/builder-session"
import { runtimeBindingFromRef } from "@/lib/agents/runtime-binding"
import { useSettingsStore } from "@/stores/settings"
import { useRuntimeRefForSession } from "@/stores/agent/agent-runtime-store"
import { useAgentRuntimeCatalog } from "@/hooks/agent/use-agent-runtime-catalog"
import { useBuilderToolSupport } from "@/hooks/agents/use-builder-tool-support"
import { AgentBuilderSetup } from "./agent-builder-setup"

type DraftUpdater = (draft: AgentBuilderDraft) => AgentBuilderDraft
const ensureMock = ensureSetupBuilderSession as jest.Mock
const writeMock = writeBuilderDraft as unknown as jest.Mock<
  Promise<void>,
  [string, DraftUpdater, "user" | "agent"]
>
const useLiveQueryMock = useLiveQuery as jest.Mock
const getDbMock = getDb as jest.Mock
const startNewSessionMock = startNewSession as jest.Mock
const bindingMock = runtimeBindingFromRef as jest.Mock
const useSettingsStoreMock = useSettingsStore as unknown as jest.Mock
const useRuntimeRefMock = useRuntimeRefForSession as jest.Mock
const useCatalogMock = useAgentRuntimeCatalog as jest.Mock
const useToolSupportMock = useBuilderToolSupport as jest.Mock
const toastError = toast.error as jest.Mock

const session = {
  id: "s1",
  title: "Agent Builder",
  kind: "agent-builder",
} as unknown as ChatSession
const runtimeRef = { kind: "external", agentId: "codex" }
const binding = { kind: "external", agentId: "codex", name: "Codex" }

let mockSession: ChatSession | null | undefined
let defaultProvider: string | undefined
const sessionsGet = jest.fn()

beforeEach(() => {
  jest.clearAllMocks()
  draftsOnResume = undefined
  mockSession = session
  defaultProvider = "openai"
  ensureMock.mockResolvedValue(session)
  writeMock.mockResolvedValue(undefined)
  useLiveQueryMock.mockImplementation(() => mockSession)
  sessionsGet.mockResolvedValue(session)
  getDbMock.mockReturnValue({ sessions: { get: sessionsGet } })
  bindingMock.mockReturnValue(binding)
  useSettingsStoreMock.mockImplementation(
    (selector: (s: { settings?: { defaultProvider?: string } }) => unknown) =>
      selector({ settings: { defaultProvider } })
  )
  useRuntimeRefMock.mockReturnValue(runtimeRef)
  useCatalogMock.mockReturnValue({ selected: { name: "Codex" } })
  useToolSupportMock.mockReturnValue("supported")
})

async function renderReady(onStart = jest.fn()) {
  const utils = render(<AgentBuilderSetup onStart={onStart} />)
  await screen.findByTestId("runtime-selector")
  return { ...utils, onStart }
}

describe("preparing the setup session", () => {
  it("prepares the session with the builder title and the single new-chat path", async () => {
    const created = { id: "s9" }
    startNewSessionMock.mockResolvedValue(created)
    await renderReady()
    // The jest next-intl stub hands out a fresh `t` each render, so the effect
    // (keyed on `t`) may run more than once here; every call is the same.
    expect(ensureMock).toHaveBeenCalled()
    const [title, deps] = ensureMock.mock.calls[0]! as [
      string,
      { startSession: (input: unknown) => Promise<unknown>; now: () => number },
    ]
    expect(title).toBe("Agent Builder")
    expect(deps.now).toBe(Date.now)
    const input = { title: "Agent Builder", kind: "agent-builder", activate: false }
    await expect(deps.startSession(input)).resolves.toBe(created)
    expect(startNewSessionMock).toHaveBeenCalledWith(input)
  })

  it("says it is preparing until the session is ready", async () => {
    let resolve: (s: ChatSession) => void = () => undefined
    ensureMock.mockImplementation(() => new Promise<ChatSession>((r) => (resolve = r)))
    render(<AgentBuilderSetup onStart={jest.fn()} />)
    expect(screen.getByText("Choose a runtime for Agent Builder")).toBeInTheDocument()
    expect(screen.getByText("Preparing…")).toBeInTheDocument()
    expect(screen.getByTestId("agent-builder-start")).toBeDisabled()
    expect(screen.queryByTestId("runtime-selector")).not.toBeInTheDocument()
    await act(async () => resolve(session))
    expect(await screen.findByTestId("runtime-selector")).toBeInTheDocument()
    expect(screen.getByTestId("agent-builder-start")).toBeEnabled()
  })

  it("keeps preparing while the session row has not been read yet", async () => {
    mockSession = undefined
    render(<AgentBuilderSetup onStart={jest.fn()} />)
    await waitFor(() => expect(ensureMock).toHaveBeenCalled())
    await act(async () => {})
    expect(screen.getByText("Preparing…")).toBeInTheDocument()
    expect(screen.getByTestId("agent-builder-start")).toBeDisabled()
  })

  it("reads the session row once it knows the id", async () => {
    await renderReady()
    const calls = useLiveQueryMock.mock.calls
    const [querier, deps] = calls[calls.length - 1]! as [() => Promise<unknown>, unknown[]]
    expect(deps).toEqual(["s1"])
    await expect(querier()).resolves.toBe(session)
    expect(sessionsGet).toHaveBeenCalledWith("s1")

    sessionsGet.mockResolvedValue(undefined)
    await expect(querier()).resolves.toBeNull()
  })

  it("reads nothing before the id is known", async () => {
    ensureMock.mockImplementation(() => new Promise(() => undefined))
    render(<AgentBuilderSetup onStart={jest.fn()} />)
    const [querier] = useLiveQueryMock.mock.calls[0]! as [() => Promise<unknown>]
    await expect(querier()).resolves.toBeNull()
    expect(getDbMock).not.toHaveBeenCalled()
  })

  it.each([
    ["an Error", new Error("db locked"), "Couldn't prepare the builder: db locked"],
    ["a non-Error", "nope", "Couldn't prepare the builder: nope"],
  ])("says why preparing failed with %s", async (_n, err, message) => {
    ensureMock.mockRejectedValue(err)
    render(<AgentBuilderSetup onStart={jest.fn()} />)
    expect(await screen.findByText(message)).toBeInTheDocument()
    expect(screen.queryByText("Preparing…")).not.toBeInTheDocument()
    expect(screen.getByTestId("agent-builder-start")).toBeDisabled()
  })

  it("drops a result that lands after unmount", async () => {
    let resolve: (s: ChatSession) => void = () => undefined
    let reject: (e: unknown) => void = () => undefined
    ensureMock.mockImplementationOnce(() => new Promise<ChatSession>((r) => (resolve = r)))
    const first = render(<AgentBuilderSetup onStart={jest.fn()} />)
    first.unmount()
    await act(async () => resolve(session))
    ensureMock.mockImplementationOnce(() => new Promise<ChatSession>((_r, j) => (reject = j)))
    const second = render(<AgentBuilderSetup onStart={jest.fn()} />)
    second.unmount()
    await act(async () => reject(new Error("late")))
    expect(screen.queryByText(/Couldn't prepare/)).not.toBeInTheDocument()
  })
})

describe("fields", () => {
  it("binds the runtime and model pickers to the setup session", async () => {
    await renderReady()
    const selector = screen.getByTestId("runtime-selector")
    expect(selector).toHaveAttribute("data-variant", "field")
    expect(selector).toHaveAttribute("data-session", "s1")
    expect(selector).toHaveAttribute("data-provider", "openai")
    expect(screen.getByTestId("model-picker")).toHaveAttribute("data-session", "s1")
    expect(screen.getByText("Runtime")).toBeInTheDocument()
    expect(screen.getByText("Model")).toBeInTheDocument()
    expect(useRuntimeRefMock).toHaveBeenLastCalledWith("s1")
    expect(useCatalogMock).toHaveBeenLastCalledWith("openai", "s1")
    expect(useToolSupportMock).toHaveBeenLastCalledWith("s1")
  })

  it("asks the hooks about no session before one exists", () => {
    ensureMock.mockImplementation(() => new Promise(() => undefined))
    render(<AgentBuilderSetup onStart={jest.fn()} />)
    expect(useRuntimeRefMock).toHaveBeenCalledWith(undefined)
    expect(useToolSupportMock).toHaveBeenCalledWith(undefined)
    expect(useCatalogMock).toHaveBeenCalledWith("openai", undefined)
  })

  it("prefers the session's provider override, then the default, then Anthropic", async () => {
    mockSession = { ...session, providerOverride: "deepseek" } as ChatSession
    const { unmount } = await renderReady()
    expect(screen.getByTestId("runtime-selector")).toHaveAttribute("data-provider", "deepseek")
    unmount()

    mockSession = session
    defaultProvider = undefined
    await renderReady()
    expect(screen.getByTestId("runtime-selector")).toHaveAttribute("data-provider", "anthropic")
  })

  it("warns when the runtime cannot call the builder's tools", async () => {
    useToolSupportMock.mockReturnValue("unsupported")
    await renderReady()
    expect(screen.getByTestId("agent-builder-no-tools")).toHaveTextContent(
      /can't call Cognia's tools/
    )
  })

  it("does not warn when tool support is unknown", async () => {
    useToolSupportMock.mockReturnValue("unknown")
    await renderReady()
    expect(screen.queryByTestId("agent-builder-no-tools")).not.toBeInTheDocument()
  })
})

describe("start", () => {
  it("stamps the chosen runtime on the draft and starts the conversation", async () => {
    const user = userEvent.setup()
    const { onStart } = await renderReady()
    await user.click(screen.getByTestId("agent-builder-start"))
    await waitFor(() => expect(onStart).toHaveBeenCalledWith("s1"))
    expect(bindingMock).toHaveBeenCalledWith(runtimeRef, "Codex")
    const [sessionId, update, by] = writeMock.mock.calls[0]!
    expect(sessionId).toBe("s1")
    expect(by).toBe("user")
    expect(update({ name: "Kept" })).toEqual({ name: "Kept", runtime: binding })
    expect(screen.getByTestId("agent-builder-start")).toBeEnabled()
  })

  it("passes no runtime name when the catalog has no selection", async () => {
    useCatalogMock.mockReturnValue({ selected: undefined })
    const user = userEvent.setup()
    const { onStart } = await renderReady()
    await user.click(screen.getByTestId("agent-builder-start"))
    await waitFor(() => expect(onStart).toHaveBeenCalled())
    expect(bindingMock).toHaveBeenCalledWith(runtimeRef, undefined)
  })

  it("disables the button while starting", async () => {
    let resolve: () => void = () => undefined
    writeMock.mockImplementation(() => new Promise<void>((r) => (resolve = r)))
    const user = userEvent.setup()
    const { onStart } = await renderReady()
    await user.click(screen.getByTestId("agent-builder-start"))
    expect(screen.getByTestId("agent-builder-start")).toBeDisabled()
    expect(onStart).not.toHaveBeenCalled()
    await act(async () => resolve())
    expect(onStart).toHaveBeenCalledWith("s1")
    expect(screen.getByTestId("agent-builder-start")).toBeEnabled()
  })

  it.each([
    ["an Error", new Error("already created"), "already created"],
    ["a non-Error", "bad", "bad"],
  ])("toasts a failed start with %s and stays on setup", async (_n, err, message) => {
    writeMock.mockRejectedValue(err)
    const user = userEvent.setup()
    const { onStart } = await renderReady()
    await user.click(screen.getByTestId("agent-builder-start"))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(message))
    expect(onStart).not.toHaveBeenCalled()
    expect(screen.getByTestId("agent-builder-start")).toBeEnabled()
  })
})

describe("drafts", () => {
  it("lists unfinished drafts below, resuming through onStart", async () => {
    const { onStart } = await renderReady()
    expect(screen.getByTestId("drafts")).toBeInTheDocument()
    draftsOnResume?.("draft-7")
    expect(onStart).toHaveBeenCalledWith("draft-7")
  })
})
