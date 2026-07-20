/** @jest-environment jsdom */
jest.mock("next-intl", () => ({
  // Flatten the namespace so the component's `t("record.step.click", …)` keys
  // render as themselves — assertions then pin the key, not the copy.
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
// Radix's real DropdownMenu never dispatches onSelect under jsdom (its pointer
// handling needs a layout engine), so the repo's convention is to flatten it —
// see components/settings/search/search-provider-grid.test.tsx. The menu's own
// behavior is Radix's to test; what matters here is which artifact each item
// exports.
jest.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div role="menu">{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onSelect,
  }: {
    children: React.ReactNode
    onSelect?: () => void
  }) => (
    <button type="button" role="menuitem" onClick={() => onSelect?.()}>
      {children}
    </button>
  ),
}))
jest.mock("@/lib/db/browser-recordings", () => ({
  saveRecording: jest.fn(),
  listRecordingsForBase: jest.fn(),
  renameRecording: jest.fn(),
  deleteRecording: jest.fn(),
}))
// The saved-flows list reads Dexie through useLiveQuery (the repo's convention —
// see twin-binding-section.test.tsx). Stubbing the hook keeps the rows under the
// test's control and, unlike a real async read, updates no state outside `act`.
// Dexie's own re-run-on-write is its contract, not this component's; the querier
// and its deps are pinned separately below.
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: jest.fn() }))
jest.mock("@/hooks/browser/use-flow-recorder", () => ({ useFlowRecorder: jest.fn() }))

import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useLiveQuery } from "dexie-react-hooks"

import { useFlowRecorder } from "@/hooks/browser/use-flow-recorder"
import type { RecordedFlow, RecordedStep } from "@/lib/browser/recording/protocol"
import {
  deleteRecording,
  listRecordingsForBase,
  renameRecording,
  saveRecording,
} from "@/lib/db/browser-recordings"
import { toast } from "sonner"
import { BrowserRecorderPanel } from "./browser-recorder-panel"

const useRecorder = useFlowRecorder as jest.Mock
const save = saveRecording as jest.Mock
const listForBase = listRecordingsForBase as jest.Mock
const rename = renameRecording as jest.Mock
const remove = deleteRecording as jest.Mock
const live = useLiveQuery as jest.Mock

/** The rows the saved-flows live query yields on the next render. */
function savedRows(rows: RecordedFlow[]) {
  live.mockReturnValue(rows)
}

const BASE = "http://localhost:3000"

function target(name: string | null = "Sign in", selector = "#submit") {
  return { selector, role: "button", name, domPath: "form > button" }
}

function recorderMock(over: Partial<ReturnType<typeof useFlowRecorder>> = {}) {
  const value = {
    recording: false,
    steps: [] as RecordedStep[],
    replayProgress: null,
    replaying: false,
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(null),
    addAssertion: jest.fn(),
    removeStep: jest.fn(),
    replay: jest.fn().mockResolvedValue(true),
    stopReplay: jest.fn(),
    secretsFor: jest.fn().mockReturnValue([]),
    ...over,
  }
  useRecorder.mockReturnValue(value)
  return value
}

function flow(over: Partial<RecordedFlow> = {}): RecordedFlow {
  return {
    id: "f1",
    name: "login",
    baseUrl: BASE,
    createdAt: 0,
    updatedAt: 0,
    steps: [{ act: "navigate", at: 0, url: BASE }],
    ...over,
  }
}

const writeText = jest.fn().mockResolvedValue(undefined)

/**
 * `userEvent.setup()` installs its OWN navigator.clipboard stub, so our mock has
 * to be defined after it or the component writes to userEvent's clipboard and
 * `writeText` is never called. jsdom also exposes navigator.clipboard as a
 * getter-only property, so this must be defineProperty, not Object.assign.
 */
function setupUser() {
  const user = userEvent.setup()
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
  return user
}

beforeEach(() => {
  jest.clearAllMocks()
  recorderMock()
  // Default every render to "this origin has nothing saved"; tests opt into rows.
  savedRows([])
  listForBase.mockResolvedValue([])
  rename.mockResolvedValue(true)
  remove.mockResolvedValue(undefined)
  save.mockResolvedValue(undefined)
})

describe("arming", () => {
  it("cannot record without a loaded page", () => {
    render(<BrowserRecorderPanel pageUrl={null} />)
    expect(screen.getByRole("button", { name: "record.start" })).toBeDisabled()
  })

  it("starts recording at the pane's live url", async () => {
    const user = userEvent.setup()
    const rec = recorderMock()
    render(<BrowserRecorderPanel pageUrl={BASE} />)
    await user.click(screen.getByRole("button", { name: "record.start" }))
    expect(rec.start).toHaveBeenCalledWith(BASE)
  })

  it("shows a live step count while recording", () => {
    recorderMock({ recording: true, steps: [{ act: "navigate", at: 0, url: BASE }] })
    render(<BrowserRecorderPanel pageUrl={BASE} />)
    expect(screen.getByText('record.recording:{"count":1}')).toBeInTheDocument()
  })

  it("swaps to stop while recording", async () => {
    const user = userEvent.setup()
    const rec = recorderMock({ recording: true })
    render(<BrowserRecorderPanel pageUrl={BASE} />)
    expect(screen.queryByRole("button", { name: "record.start" })).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "record.stop" }))
    expect(rec.stop).toHaveBeenCalled()
  })

  it("invites interaction when nothing is captured yet", () => {
    render(<BrowserRecorderPanel pageUrl={BASE} />)
    expect(screen.getByText("record.empty")).toBeInTheDocument()
  })

  it("collapses and restores the recorder body while keeping its controls available", async () => {
    const user = userEvent.setup()
    render(<BrowserRecorderPanel pageUrl={BASE} />)

    const toggle = screen.getByRole("button", { name: "record.collapse" })
    expect(toggle).toHaveAttribute("aria-expanded", "true")
    await user.click(toggle)
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByText("record.empty")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "record.start" })).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "record.expand" }))
    expect(screen.getByText("record.empty")).toBeInTheDocument()
  })

  it("expands the body when recording starts", async () => {
    const user = userEvent.setup()
    const rec = recorderMock()
    render(<BrowserRecorderPanel pageUrl={BASE} />)
    await user.click(screen.getByRole("button", { name: "record.collapse" }))

    await user.click(screen.getByRole("button", { name: "record.start" }))

    expect(rec.start).toHaveBeenCalledWith(BASE)
    expect(screen.getByText("record.empty")).toBeInTheDocument()
  })
})

describe("step list", () => {
  it("labels each kind of step", () => {
    recorderMock({
      recording: true,
      steps: [
        { act: "navigate", at: 0, url: BASE },
        { act: "click", at: 1, target: target() },
        { act: "fill", at: 2, target: target("Email", "#email"), value: "a@b.c" },
        { act: "select", at: 3, target: target("Plan", "#plan"), value: "pro" },
        { act: "press_key", at: 4, key: "Enter" },
        { act: "wait_for", at: 5, text: "Welcome" },
        { act: "double_click", at: 6, target: target("Card", "#card") },
        { act: "hover", at: 7, target: target("Menu", "#menu") },
        { act: "scroll", at: 8, direction: "down", amount: 200 },
      ],
    })
    render(<BrowserRecorderPanel pageUrl={BASE} />)
    expect(screen.getByText(`record.step.navigate:{"url":"${BASE}"}`)).toBeInTheDocument()
    expect(screen.getByText('record.step.click:{"target":"Sign in"}')).toBeInTheDocument()
    expect(screen.getByText('record.step.fill:{"target":"Email"}')).toBeInTheDocument()
    expect(
      screen.getByText('record.step.select:{"target":"Plan","value":"pro"}')
    ).toBeInTheDocument()
    expect(screen.getByText('record.step.pressKey:{"key":"Enter"}')).toBeInTheDocument()
    expect(screen.getByText('record.step.waitFor:{"text":"Welcome"}')).toBeInTheDocument()
    expect(screen.getByText('record.step.doubleClick:{"target":"Card"}')).toBeInTheDocument()
    expect(screen.getByText('record.step.hover:{"target":"Menu"}')).toBeInTheDocument()
    expect(
      screen.getByText('record.step.scroll:{"direction":"record.step.direction.down","amount":200}')
    ).toBeInTheDocument()
  })

  it("marks a secret fill as such rather than showing a value", () => {
    recorderMock({
      recording: true,
      steps: [{ act: "fill", at: 1, target: target("Password", "#pw"), value: "", secret: true }],
    })
    render(<BrowserRecorderPanel pageUrl={BASE} />)
    expect(screen.getByText('record.step.secret:{"target":"Password"}')).toBeInTheDocument()
  })

  it("falls back to the selector when the element has no accessible name", () => {
    recorderMock({
      recording: true,
      steps: [{ act: "click", at: 1, target: target(null, "#raw") }],
    })
    render(<BrowserRecorderPanel pageUrl={BASE} />)
    expect(screen.getByText('record.step.click:{"target":"#raw"}')).toBeInTheDocument()
  })

  it("removes a step", async () => {
    const user = userEvent.setup()
    const rec = recorderMock({
      recording: true,
      steps: [{ act: "click", at: 1, target: target() }],
    })
    render(<BrowserRecorderPanel pageUrl={BASE} />)
    await user.click(screen.getByRole("button", { name: "record.removeStep" }))
    expect(rec.removeStep).toHaveBeenCalledWith(0)
  })

  it("does not offer removal when no take is live — a finished flow is read-only", () => {
    recorderMock({ recording: false, steps: [{ act: "click", at: 1, target: target() }] })
    render(<BrowserRecorderPanel pageUrl={BASE} />)
    expect(screen.getByText('record.step.click:{"target":"Sign in"}')).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "record.removeStep" })).not.toBeInTheDocument()
  })
})

describe("assertions", () => {
  it("adds a trimmed assertion and clears the field", async () => {
    const user = userEvent.setup()
    const rec = recorderMock({ recording: true })
    render(<BrowserRecorderPanel pageUrl={BASE} />)
    const field = screen.getByLabelText("record.addAssertion")
    await user.type(field, "  Welcome  ")
    await user.click(screen.getByRole("button", { name: "record.addAssertion" }))
    expect(rec.addAssertion).toHaveBeenCalledWith("Welcome")
    expect(field).toHaveValue("")
  })

  it("cannot add an empty assertion", async () => {
    const user = userEvent.setup()
    recorderMock({ recording: true })
    render(<BrowserRecorderPanel pageUrl={BASE} />)
    await user.type(screen.getByLabelText("record.addAssertion"), "   ")
    expect(screen.getByRole("button", { name: "record.addAssertion" })).toBeDisabled()
  })
})

describe("review", () => {
  async function finish(
    user: ReturnType<typeof userEvent.setup>,
    over: Partial<RecordedFlow> = {}
  ) {
    const rec = recorderMock({ recording: true, stop: jest.fn().mockResolvedValue(flow(over)) })
    render(<BrowserRecorderPanel pageUrl={BASE} />)
    await user.click(screen.getByRole("button", { name: "record.stop" }))
    return rec
  }

  it("saves the flow under the edited name", async () => {
    const user = userEvent.setup()
    await finish(user)
    const nameField = screen.getByLabelText("record.name")
    await user.clear(nameField)
    await user.type(nameField, "checkout")
    await user.click(screen.getByRole("button", { name: "record.save" }))
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ name: "checkout" }))
    expect(toast.success).toHaveBeenCalledWith("record.saved")
  })

  it("falls back to the base url when the name is blanked", async () => {
    const user = userEvent.setup()
    await finish(user)
    await user.clear(screen.getByLabelText("record.name"))
    await user.click(screen.getByRole("button", { name: "record.save" }))
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ name: BASE }))
  })

  it("replays and reports success", async () => {
    const user = userEvent.setup()
    const rec = await finish(user)
    await user.click(screen.getByRole("button", { name: "record.replay" }))
    expect(rec.replay).toHaveBeenCalled()
    expect(toast.success).toHaveBeenCalledWith('record.replaySucceeded:{"count":1}')
  })

  it("reports which step failed", async () => {
    const user = userEvent.setup()
    recorderMock({
      recording: true,
      stop: jest.fn().mockResolvedValue(flow()),
      replay: jest.fn().mockResolvedValue(false),
      replayProgress: { index: 2, step: flow().steps[0], ok: false, error: "no element" },
    })
    render(<BrowserRecorderPanel pageUrl={BASE} />)
    await user.click(screen.getByRole("button", { name: "record.stop" }))
    await user.click(screen.getByRole("button", { name: "record.replay" }))
    expect(toast.error).toHaveBeenCalledWith('record.replayFailed:{"index":3,"error":"no element"}')
  })

  // A replay the user aborted settles false with no failing step to point at.
  it("stays quiet when a replay ends without a failing step", async () => {
    const user = userEvent.setup()
    recorderMock({
      recording: true,
      stop: jest.fn().mockResolvedValue(flow()),
      replay: jest.fn().mockResolvedValue(false),
      replayProgress: null,
    })
    render(<BrowserRecorderPanel pageUrl={BASE} />)
    await user.click(screen.getByRole("button", { name: "record.stop" }))
    await user.click(screen.getByRole("button", { name: "record.replay" }))
    expect(toast.error).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
  })

  it("locks the replay button while a replay is in flight", async () => {
    const user = userEvent.setup()
    recorderMock({ recording: true, replaying: true, stop: jest.fn().mockResolvedValue(flow()) })
    render(<BrowserRecorderPanel pageUrl={BASE} />)
    await user.click(screen.getByRole("button", { name: "record.stop" }))
    expect(screen.getByRole("button", { name: "record.replaying" })).toBeDisabled()
    expect(screen.queryByRole("button", { name: "record.replay" })).not.toBeInTheDocument()
  })
})

// The user-visible half of the never-record-a-password guarantee.
describe("secrets", () => {
  it("asks for each secret the flow needs, masked", async () => {
    const user = userEvent.setup()
    recorderMock({
      recording: true,
      stop: jest.fn().mockResolvedValue(flow()),
      secretsFor: jest.fn().mockReturnValue(["PASSWORD"]),
    })
    render(<BrowserRecorderPanel pageUrl={BASE} />)
    await user.click(screen.getByRole("button", { name: "record.stop" }))
    expect(screen.getByText('record.secretNeeded:{"names":"PASSWORD"}')).toBeInTheDocument()
    expect(screen.getByLabelText('record.secretPlaceholder:{"name":"PASSWORD"}')).toHaveAttribute(
      "type",
      "password"
    )
  })

  it("passes the typed secret to replay", async () => {
    const user = userEvent.setup()
    const rec = recorderMock({
      recording: true,
      stop: jest.fn().mockResolvedValue(flow()),
      secretsFor: jest.fn().mockReturnValue(["PASSWORD"]),
    })
    render(<BrowserRecorderPanel pageUrl={BASE} />)
    await user.click(screen.getByRole("button", { name: "record.stop" }))
    await user.type(
      screen.getByLabelText('record.secretPlaceholder:{"name":"PASSWORD"}'),
      "hunter2"
    )
    await user.click(screen.getByRole("button", { name: "record.replay" }))
    expect(rec.replay).toHaveBeenCalledWith(expect.anything(), { PASSWORD: "hunter2" })
  })

  it("asks for nothing when the flow has no secrets", async () => {
    const user = userEvent.setup()
    recorderMock({ recording: true, stop: jest.fn().mockResolvedValue(flow()) })
    render(<BrowserRecorderPanel pageUrl={BASE} />)
    await user.click(screen.getByRole("button", { name: "record.stop" }))
    expect(screen.queryByText(/record.secretNeeded/)).not.toBeInTheDocument()
  })
})

// Saving to Dexie without a way to read back is the ADR-0072 defect these pin.
describe("saved flows", () => {
  const saved = (over: Partial<RecordedFlow> = {}) =>
    flow({ id: "s1", name: "saved login", ...over })

  it("lists the flows saved for the loaded origin", () => {
    savedRows([saved(), saved({ id: "s2", name: "checkout" })])
    render(<BrowserRecorderPanel pageUrl={BASE} />)
    expect(screen.getByText("record.savedTitle")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "saved login" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "checkout" })).toBeInTheDocument()
  })

  it("shows each saved flow's step count", () => {
    savedRows([saved()])
    render(<BrowserRecorderPanel pageUrl={BASE} />)
    expect(screen.getByText('record.savedSteps:{"count":1}')).toBeInTheDocument()
  })

  it("says nothing about saved flows when the origin has none", () => {
    render(<BrowserRecorderPanel pageUrl={BASE} />)
    expect(screen.queryByText("record.savedTitle")).not.toBeInTheDocument()
  })

  // The live query is what makes the list reflect every write — a save, a
  // rename and a delete all land through it. These two pin the query itself:
  // Dexie re-runs it on any write to `browserRecordings`, and re-subscribes
  // when the pane navigates, because `pageUrl` is a dependency.
  it("queries by the loaded origin, and re-subscribes when the pane navigates", async () => {
    render(<BrowserRecorderPanel pageUrl={BASE} />)
    const [querier, deps] = live.mock.calls[0]
    expect(await querier()).toEqual([])
    expect(listForBase).toHaveBeenCalledWith(BASE)
    expect(deps).toEqual([BASE])
  })

  it("queries nothing until a page is loaded", async () => {
    render(<BrowserRecorderPanel pageUrl={null} />)
    const [querier] = live.mock.calls[0]
    expect(await querier()).toEqual([])
    expect(listForBase).not.toHaveBeenCalled()
  })

  // Dexie yields undefined for the first render, before the query settles.
  it("renders nothing rather than crashing before the first read settles", () => {
    live.mockReturnValue(undefined)
    render(<BrowserRecorderPanel pageUrl={BASE} />)
    expect(screen.queryByText("record.savedTitle")).not.toBeInTheDocument()
  })

  // The point of the list: a saved flow lands in the same state `stop()` fills,
  // so it is immediately replayable.
  it("loads a selected flow into the panel for replay", async () => {
    const user = userEvent.setup()
    const rec = recorderMock()
    savedRows([saved()])
    render(<BrowserRecorderPanel pageUrl={BASE} />)
    await user.click(screen.getByRole("button", { name: "saved login" }))
    expect(screen.getByLabelText("record.name")).toHaveValue("saved login")
    await user.click(screen.getByRole("button", { name: "record.replay" }))
    expect(rec.replay).toHaveBeenCalledWith(expect.objectContaining({ id: "s1" }), {})
  })

  it("shows a selected flow's steps", async () => {
    const user = userEvent.setup()
    savedRows([saved()])
    render(<BrowserRecorderPanel pageUrl={BASE} />)
    await user.click(screen.getByRole("button", { name: "saved login" }))
    expect(screen.getByText(`record.step.navigate:{"url":"${BASE}"}`)).toBeInTheDocument()
  })

  // One flow's password must never be handed to another's replay.
  it("drops typed secrets when another flow is selected", async () => {
    const user = userEvent.setup()
    recorderMock({
      recording: true,
      stop: jest.fn().mockResolvedValue(flow()),
      secretsFor: jest.fn().mockReturnValue(["PASSWORD"]),
    })
    savedRows([saved({ id: "s2", name: "checkout" })])
    const { rerender } = render(<BrowserRecorderPanel pageUrl={BASE} />)
    await user.click(screen.getByRole("button", { name: "record.stop" }))
    await user.type(
      screen.getByLabelText('record.secretPlaceholder:{"name":"PASSWORD"}'),
      "hunter2"
    )
    // `recorderMock` is static, so the take only reads as finished — and the
    // saved list only reappears — once the hook is re-mocked.
    recorderMock({ recording: false, secretsFor: jest.fn().mockReturnValue(["PASSWORD"]) })
    rerender(<BrowserRecorderPanel pageUrl={BASE} />)
    await user.click(screen.getByRole("button", { name: "checkout" }))
    expect(screen.getByLabelText('record.secretPlaceholder:{"name":"PASSWORD"}')).toHaveValue("")
  })

  it("hides the list while a take is live so it cannot clobber the recording", () => {
    savedRows([saved()])
    const { rerender } = render(<BrowserRecorderPanel pageUrl={BASE} />)
    expect(screen.getByText("record.savedTitle")).toBeInTheDocument()
    recorderMock({ recording: true })
    rerender(<BrowserRecorderPanel pageUrl={BASE} />)
    expect(screen.queryByText("record.savedTitle")).not.toBeInTheDocument()
  })
})

describe("renaming a saved flow", () => {
  const saved = () => flow({ id: "s1", name: "saved login" })

  async function beginRename(user: ReturnType<typeof userEvent.setup>, now = () => 4242) {
    savedRows([saved()])
    render(<BrowserRecorderPanel pageUrl={BASE} now={now} />)
    await user.click(screen.getByRole("button", { name: "record.rename" }))
  }

  it("renames the flow under the trimmed name, stamped with the injected clock", async () => {
    const user = userEvent.setup()
    await beginRename(user)
    const field = screen.getByLabelText("record.renameLabel")
    expect(field).toHaveValue("saved login")
    await user.clear(field)
    await user.type(field, "  signin  ")
    await user.click(screen.getByRole("button", { name: "record.renameConfirm" }))
    expect(rename).toHaveBeenCalledWith("s1", "signin", 4242)
    expect(toast.success).toHaveBeenCalledWith("record.renamed")
  })

  it("leaves the edit field once the rename lands", async () => {
    const user = userEvent.setup()
    await beginRename(user)
    await user.click(screen.getByRole("button", { name: "record.renameConfirm" }))
    await waitFor(() =>
      expect(screen.queryByLabelText("record.renameLabel")).not.toBeInTheDocument()
    )
  })

  // The row went away underneath the rename — don't claim it was renamed.
  it("stays quiet when the row is already gone", async () => {
    const user = userEvent.setup()
    rename.mockResolvedValue(false)
    await beginRename(user)
    await user.click(screen.getByRole("button", { name: "record.renameConfirm" }))
    expect(rename).toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalledWith("record.renamed")
  })

  it("cannot rename to blank", async () => {
    const user = userEvent.setup()
    await beginRename(user)
    await user.clear(screen.getByLabelText("record.renameLabel"))
    await user.type(screen.getByLabelText("record.renameLabel"), "   ")
    expect(screen.getByRole("button", { name: "record.renameConfirm" })).toBeDisabled()
    expect(rename).not.toHaveBeenCalled()
  })

  it("abandons the rename on cancel", async () => {
    const user = userEvent.setup()
    await beginRename(user)
    await user.click(screen.getByRole("button", { name: "record.renameCancel" }))
    expect(screen.queryByLabelText("record.renameLabel")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "saved login" })).toBeInTheDocument()
    expect(rename).not.toHaveBeenCalled()
  })

  it("edits only the row it was opened on", async () => {
    const user = userEvent.setup()
    savedRows([saved(), flow({ id: "s2", name: "checkout" })])
    render(<BrowserRecorderPanel pageUrl={BASE} now={() => 7} />)
    const rows = screen.getAllByRole("button", { name: "record.rename" })
    await user.click(rows[1])
    expect(screen.getByLabelText("record.renameLabel")).toHaveValue("checkout")
    expect(screen.getByRole("button", { name: "saved login" })).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "record.renameConfirm" }))
    expect(rename).toHaveBeenCalledWith("s2", "checkout", 7)
  })

  // Default-clock path: no `now` prop, so the component falls back to Date.now.
  it("falls back to the wall clock when no clock is injected", async () => {
    const user = userEvent.setup()
    savedRows([saved()])
    render(<BrowserRecorderPanel pageUrl={BASE} />)
    await user.click(screen.getByRole("button", { name: "record.rename" }))
    await user.click(screen.getByRole("button", { name: "record.renameConfirm" }))
    expect(rename).toHaveBeenCalledWith("s1", "saved login", expect.any(Number))
  })
})

describe("deleting a saved flow", () => {
  it("deletes the flow it was clicked on", async () => {
    const user = userEvent.setup()
    savedRows([flow({ id: "s1", name: "saved login" }), flow({ id: "s2", name: "checkout" })])
    render(<BrowserRecorderPanel pageUrl={BASE} />)
    await user.click(screen.getAllByRole("button", { name: "record.delete" })[1])
    expect(remove).toHaveBeenCalledWith("s2")
    expect(toast.success).toHaveBeenCalledWith("record.deleted")
  })

  // The live query drops the row for us; this pins that the list renders
  // whatever it currently yields, which is how that re-read reaches the screen.
  it("drops the row once the live query stops yielding it", () => {
    savedRows([flow({ id: "s1", name: "saved login" })])
    const { rerender } = render(<BrowserRecorderPanel pageUrl={BASE} />)
    expect(screen.getByRole("button", { name: "saved login" })).toBeInTheDocument()
    savedRows([])
    rerender(<BrowserRecorderPanel pageUrl={BASE} />)
    expect(screen.queryByRole("button", { name: "saved login" })).not.toBeInTheDocument()
    expect(screen.queryByText("record.savedTitle")).not.toBeInTheDocument()
  })
})

describe("stopping a replay", () => {
  async function replaying(user: ReturnType<typeof userEvent.setup>) {
    const rec = recorderMock({
      recording: true,
      replaying: true,
      stop: jest.fn().mockResolvedValue(flow()),
    })
    render(<BrowserRecorderPanel pageUrl={BASE} />)
    await user.click(screen.getByRole("button", { name: "record.stop" }))
    return rec
  }

  // Replay disables its own button, so without this a hung replay is inescapable.
  it("aborts an in-flight replay", async () => {
    const user = userEvent.setup()
    const rec = await replaying(user)
    await user.click(screen.getByRole("button", { name: "record.stopReplay" }))
    expect(rec.stopReplay).toHaveBeenCalled()
  })

  it("offers no stop control when no replay is in flight", async () => {
    const user = userEvent.setup()
    recorderMock({ recording: true, stop: jest.fn().mockResolvedValue(flow()) })
    render(<BrowserRecorderPanel pageUrl={BASE} />)
    await user.click(screen.getByRole("button", { name: "record.stop" }))
    expect(screen.queryByRole("button", { name: "record.stopReplay" })).not.toBeInTheDocument()
  })
})

describe("export", () => {
  async function openExport(user: ReturnType<typeof userEvent.setup>, onSendToChat?: jest.Mock) {
    recorderMock({ recording: true, stop: jest.fn().mockResolvedValue(flow()) })
    render(<BrowserRecorderPanel pageUrl={BASE} onSendToChat={onSendToChat} />)
    await user.click(screen.getByRole("button", { name: "record.stop" }))
    return screen.getByRole("menu")
  }

  it("copies a playwright spec to the clipboard", async () => {
    const user = setupUser()
    const menu = await openExport(user)
    await user.click(within(menu).getByRole("menuitem", { name: "record.exportPlaywright" }))
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        expect.stringContaining('import { test } from "@playwright/test"')
      )
    )
    expect(toast.success).toHaveBeenCalledWith("record.exported")
  })

  it("keeps the flow's own name when the field is blanked", async () => {
    const user = setupUser()
    const menu = await openExport(user)
    await user.clear(screen.getByLabelText("record.name"))
    await user.click(within(menu).getByRole("menuitem", { name: "record.exportJson" }))
    await waitFor(() => expect(writeText).toHaveBeenCalled())
    expect(JSON.parse(writeText.mock.calls[0][0]).name).toBe("login")
  })

  it("exports under the edited name", async () => {
    const user = setupUser()
    const menu = await openExport(user)
    await user.clear(screen.getByLabelText("record.name"))
    await user.type(screen.getByLabelText("record.name"), "checkout")
    await user.click(within(menu).getByRole("menuitem", { name: "record.exportPlaywright" }))
    await waitFor(() => expect(writeText).toHaveBeenCalled())
    expect(writeText.mock.calls[0][0]).toContain('test("checkout"')
  })

  it("copies the raw flow json", async () => {
    const user = setupUser()
    const menu = await openExport(user)
    await user.click(within(menu).getByRole("menuitem", { name: "record.exportJson" }))
    await waitFor(() => expect(writeText).toHaveBeenCalled())
    expect(JSON.parse(writeText.mock.calls[0][0])).toMatchObject({ baseUrl: BASE })
  })

  it("sends the agent context to chat rather than the clipboard", async () => {
    const user = setupUser()
    const onSendToChat = jest.fn()
    const menu = await openExport(user, onSendToChat)
    await user.click(within(menu).getByRole("menuitem", { name: "record.exportAgent" }))
    await waitFor(() =>
      expect(onSendToChat).toHaveBeenCalledWith(expect.stringContaining("Recorded browser flow"))
    )
    expect(writeText).not.toHaveBeenCalled()
  })

  it("falls back to the clipboard when no chat session is open", async () => {
    const user = setupUser()
    const menu = await openExport(user)
    await user.click(within(menu).getByRole("menuitem", { name: "record.exportAgent" }))
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(expect.stringContaining("Recorded browser flow"))
    )
  })
})
