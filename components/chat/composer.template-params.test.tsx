/**
 * @jest-environment jsdom
 *
 * `{{parameter}}` chips in the composer: recognising them, filling them, and
 * getting them back after a reload.
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
  formatShellResult: jest.fn(),
}))
jest.mock("@/lib/files/memory", () => ({ appendMemory: jest.fn() }))
const listWorkspaceDir = jest.fn(async () => [] as unknown[])
const readWorkspaceFile = jest.fn(async () => "")
jest.mock("@/lib/files/workspace-fs", () => ({
  ...jest.requireActual("@/lib/files/workspace-fs"),
  listWorkspaceDir: (...args: unknown[]) => listWorkspaceDir(...(args as [])),
  readWorkspaceFile: (...args: unknown[]) => readWorkspaceFile(...(args as [])),
}))
const searchWorkspace = jest.fn(async () => [] as unknown[])
jest.mock("@/lib/files/workspace-search", () => ({
  searchWorkspace: (...args: unknown[]) => searchWorkspace(...(args as [])),
  __resetWorkspaceSearchCache: jest.fn(),
}))
jest.mock("./composer/voice-controls", () => ({ VoiceControls: () => null }))

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { ReactNode } from "react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Composer } from "./composer"
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import type { DataAdapter } from "@/lib/data-hooks/types"
import { useChatStore } from "@/stores/chat"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { flushDebouncedDraftWrites, getDraft, setDraft } from "@/lib/db/chat-drafts"
import { createChatTemplate, listChatTemplates } from "@/lib/db/chat-templates"
import { requestTemplateRerun } from "@/lib/chat/template/rerun-request"
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
  } as DataAdapter
}

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <DataAdapterProvider adapter={makeAdapter()}>
      <TooltipProvider>{children}</TooltipProvider>
    </DataAdapterProvider>
  )
}

const session: ChatSession = {
  id: "ses_params",
  title: "Params",
  kind: "direct",
  createdAt: 0,
  updatedAt: 0,
}

async function mount(
  onSend: (content: unknown, manifest?: unknown, templateRun?: unknown) => void = () => undefined,
  sessionOverride: Partial<ChatSession> = {}
) {
  const view = render(
    <Wrapper>
      <Composer
        session={{ ...session, ...sessionOverride }}
        onStartNewSession={async () => undefined}
        onOpenSettings={() => undefined}
        onSend={onSend}
        onStop={async () => undefined}
      />
    </Wrapper>
  )
  const ta = document.querySelector("textarea") as HTMLTextAreaElement
  // The draft hydration effect is async; let it settle so the persist effect
  // is armed before the test types anything.
  await act(async () => {
    await Promise.resolve()
  })
  return { ...view, ta }
}

/** Put the caret at `index` and release the pointer there, as a click would. */
function clickAt(ta: HTMLTextAreaElement, index: number) {
  ta.selectionStart = index
  ta.selectionEnd = index
  fireEvent.mouseUp(ta)
}

const chips = () => Array.from(document.querySelectorAll('[data-chip="param"]'))

/** Flatten whatever shape the send pipeline handed `onSend` into plain text. */
const textOf = (content: unknown): string =>
  Array.isArray(content)
    ? content
        .map((part) => (typeof part === "string" ? part : ((part as { text?: string }).text ?? "")))
        .join("")
    : typeof content === "string"
      ? content
      : ((content as { text?: string })?.text ?? JSON.stringify(content))

/** Enter submits; the pipeline is async, so give it a tick to land. */
async function submit(ta: HTMLTextAreaElement) {
  fireEvent.keyDown(ta, { key: "Enter" })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50))
  })
}
/** The popover's field — `getByRole("textbox")` also matches the composer itself. */
const paramInput = () => within(screen.getByTestId("template-param-popover")).getByRole("textbox")

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  useChatStore.getState().clear()
  await dbFixture.restore()
})
afterAll(dbFixture.dispose)

describe("Composer — {{parameter}} chips", () => {
  it("paints a typed parameter as an empty chip", async () => {
    const { ta } = await mount()

    fireEvent.change(ta, { target: { value: "review {{module}} please" } })

    expect(chips()).toHaveLength(1)
    expect(chips()[0]).toHaveAttribute("data-param-state", "empty")
    expect(chips()[0].textContent).toBe("{{module}}")
  })

  it("opens the editor on a click inside the token, and fills the chip", async () => {
    const { ta } = await mount()
    fireEvent.change(ta, { target: { value: "review {{module}}" } })

    clickAt(ta, 10)

    expect(screen.getByTestId("template-param-popover")).toBeInTheDocument()
    fireEvent.change(paramInput(), { target: { value: "login" } })

    await waitFor(() => expect(chips()[0]).toHaveAttribute("data-param-state", "filled"))
  })

  it("does not open the editor when the caret merely passes through", async () => {
    // `onSelect` fires for arrow keys too. A panel that appeared every time the
    // caret drifted through a token would flash at someone reading back their
    // own sentence.
    const { ta } = await mount()
    fireEvent.change(ta, { target: { value: "review {{module}}" } })

    ta.selectionStart = 10
    ta.selectionEnd = 10
    fireEvent.select(ta)

    expect(screen.queryByTestId("template-param-popover")).not.toBeInTheDocument()
  })

  it("keeps the value across a reload, reading the tokens back out of the text", async () => {
    const { ta, unmount } = await mount()
    fireEvent.change(ta, { target: { value: "review {{module}}" } })
    clickAt(ta, 10)
    fireEvent.change(paramInput(), { target: { value: "login" } })

    await act(async () => {
      await flushDebouncedDraftWrites()
    })
    await waitFor(async () =>
      expect(await getDraft(session.id)).toMatchObject({
        text: "review {{module}}",
        templateBinding: { params: { module: { kind: "text", value: "login" } } },
      })
    )

    unmount()
    await mount()

    await waitFor(() => expect(chips()[0]).toHaveAttribute("data-param-state", "filled"))
  })

  it("drops a value when its token is broken, so retyping it starts clean", async () => {
    await setDraft(session.id, "review {{module}}", [], {
      templateBinding: {
        templateId: "",
        version: "",
        params: { module: { kind: "text", value: "login" } },
        insertedAt: 1,
      },
    })
    const { ta } = await mount()
    await waitFor(() => expect(ta.value).toBe("review {{module}}"))

    fireEvent.change(ta, { target: { value: "review {{modul" } })

    expect(chips()).toHaveLength(0)
    await act(async () => {
      await flushDebouncedDraftWrites()
    })
    await waitFor(async () => {
      const row = await getDraft(session.id)
      expect(row?.templateBinding?.params).toEqual({})
    })
  })

  it("steps Tab from one parameter to the next", async () => {
    const { ta } = await mount()
    fireEvent.change(ta, { target: { value: "{{a}} and {{b}}" } })
    ta.selectionStart = 0
    ta.selectionEnd = 0

    fireEvent.keyDown(ta, { key: "Tab" })

    expect(ta.selectionStart).toBe(10)
    expect(screen.getByTestId("template-param-popover")).toBeInTheDocument()
  })

  it("leaves Tab alone when the text has no parameters", async () => {
    // Tab is the only way a keyboard user gets out of the composer to the
    // toolbar; claiming it unconditionally would strand them.
    const { ta } = await mount()
    fireEvent.change(ta, { target: { value: "just prose" } })

    const event = fireEvent.keyDown(ta, { key: "Tab" })

    expect(event).toBe(true) // not preventDefault-ed
  })

  it("substitutes the value into the sent message", async () => {
    const onSend = jest.fn()
    const { ta } = await mount(onSend)
    fireEvent.change(ta, { target: { value: "review {{module}} please" } })
    clickAt(ta, 10)
    fireEvent.change(paramInput(), { target: { value: "the login flow" } })
    fireEvent.keyDown(paramInput(), { key: "Enter" })

    await submit(ta)

    expect(onSend).toHaveBeenCalledTimes(1)
    expect(textOf(onSend.mock.calls[0][0])).toContain("review the login flow please")
  })

  it("refuses to send while a parameter has no value", async () => {
    // A literal `{{module}}` reaching the model is never what anyone meant, and
    // the model will cheerfully act as though it understood.
    const onSend = jest.fn()
    const { ta } = await mount(onSend)
    fireEvent.change(ta, { target: { value: "review {{module}}" } })

    await submit(ta)

    expect(onSend).not.toHaveBeenCalled()
    // The text is still there — the refusal happens before the optimistic
    // clear, so nothing has to be restored.
    expect(ta.value).toBe("review {{module}}")
    // ...and the editor is open on the parameter that is missing.
    await waitFor(() => expect(screen.getByTestId("template-param-popover")).toBeInTheDocument())
  })

  it("sends a `{{ }}` inside a code fence untouched", async () => {
    const onSend = jest.fn()
    const { ta } = await mount(onSend)
    fireEvent.change(ta, { target: { value: "```\nname: {{ jinja }}\n```" } })

    await submit(ta)

    expect(onSend).toHaveBeenCalledTimes(1)
    expect(textOf(onSend.mock.calls[0][0])).toContain("{{ jinja }}")
  })

  describe("preview", () => {
    it("offers no toggle when the message has no parameters", async () => {
      // There would be nothing to preview — the box already shows the sentence.
      const { ta } = await mount()
      fireEvent.change(ta, { target: { value: "just prose" } })

      expect(screen.queryByTestId("composer-param-preview-toggle")).not.toBeInTheDocument()
    })

    it("shows the finished sentence, then goes back to editing", async () => {
      const { ta } = await mount()
      fireEvent.change(ta, { target: { value: "review {{module}} please" } })
      clickAt(ta, 10)
      fireEvent.change(paramInput(), { target: { value: "the login flow" } })
      fireEvent.keyDown(paramInput(), { key: "Enter" })

      fireEvent.click(screen.getByTestId("composer-param-preview-toggle"))

      expect(screen.getByTestId("composer-param-preview")).toHaveTextContent(
        "review the login flow please"
      )
      // The textarea is hidden, never unmounted — unmounting would drop focus,
      // the caret, the scroll position and every ref the composer holds on it.
      expect(document.querySelector("textarea")).toBeInTheDocument()

      fireEvent.click(screen.getByTestId("composer-param-preview-toggle"))
      expect(screen.queryByTestId("composer-param-preview")).not.toBeInTheDocument()
    })

    it("still shows the token for a value nobody has supplied", async () => {
      const { ta } = await mount()
      fireEvent.change(ta, { target: { value: "review {{module}}" } })

      fireEvent.click(screen.getByTestId("composer-param-preview-toggle"))

      expect(screen.getByTestId("composer-param-preview")).toHaveTextContent("review {{module}}")
    })
  })

  describe("saved templates", () => {
    it("saves what is in the box, deriving the parameters from it", async () => {
      const { ta } = await mount()
      fireEvent.change(ta, { target: { value: "review {{module}} on {{branch}}" } })

      fireEvent.click(screen.getByTestId("composer-save-as-template"))
      fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "Review a PR" } })
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /^save$/i }))
      })

      await waitFor(async () => {
        const [saved] = await listChatTemplates()
        expect(saved).toMatchObject({
          name: "Review a PR",
          body: "review {{module}} on {{branch}}",
        })
        expect(saved.params.map((p) => p.id)).toEqual(["module", "branch"])
      })
    })

    it("offers no save control for an empty message", async () => {
      await mount()

      expect(screen.queryByTestId("composer-save-as-template")).not.toBeInTheDocument()
    })

    it("inserts a template's body from the / menu and lands on the first parameter", async () => {
      await createChatTemplate({ name: "Review a PR", body: "review {{module}} please" })
      const { ta } = await mount()

      fireEvent.change(ta, { target: { value: "/" } })
      // The popover picks on mouseDown (it must preventDefault to keep the
      // textarea from blurring), so a plain click never reaches it.
      fireEvent.mouseDown(await screen.findByText("Review a PR"))

      await waitFor(() => expect(ta.value).toBe("review {{module}} please "))
      // ...with its editor already open, because filling it in is the point.
      await waitFor(() => expect(screen.getByTestId("template-param-popover")).toBeInTheDocument())
    }, 20_000)

    it("pre-fills a template with what it was set to last time", async () => {
      const template = await createChatTemplate({
        name: "Review a PR",
        body: "review {{module}} please",
      })
      const { recordChatTemplateUse } = await import("@/lib/db/chat-templates")
      await recordChatTemplateUse(template.id, { module: { kind: "text", value: "auth" } })

      const { ta } = await mount()
      fireEvent.change(ta, { target: { value: "/" } })
      fireEvent.mouseDown(await screen.findByText("Review a PR"))

      // Filled, not empty — nine uses in ten repeat most of the values.
      await waitFor(() => expect(chips()[0]).toHaveAttribute("data-param-state", "filled"))
    }, 20_000)
  })
})

describe("Composer — reference parameters", () => {
  // The whole chain: a declaration says "this one is a workspace file", the
  // picker answers from the same source the `@` menu does, and the send
  // substitutes the token that menu would have inserted.
  it("picks a file through the shared source and sends the mention it produces", async () => {
    searchWorkspace.mockResolvedValue([
      {
        relPath: "src/app.ts",
        absolutePath: "/repo/src/app.ts",
        isDir: false,
        size: 0,
        mtimeMs: 0,
      },
    ])
    await createChatTemplate({
      name: "Review a file",
      body: "review {{target}}",
      params: [
        { id: "target", label: "Target", required: true, kind: "resource", resourceKind: "file" },
      ],
    })
    const sent: unknown[] = []
    const { ta } = await mount((content) => sent.push(content), { workingDir: "/repo" })

    fireEvent.change(ta, { target: { value: "/" } })
    fireEvent.mouseDown(await screen.findByText("Review a file"))
    await waitFor(() => expect(ta.value).toBe("review {{target}} "))

    // A field would mean typing a path by hand; the declaration promised a picker.
    const search = await screen.findByTestId("template-param-search")
    expect(search).toBeInTheDocument()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300))
    })
    fireEvent.click(await screen.findByRole("option", { name: /src\/app\.ts/ }))

    await waitFor(() => expect(chips()[0]).toHaveAttribute("data-param-state", "filled"))
    await submit(ta)

    expect(textOf(sent[0])).toContain("@src/app.ts")
    expect(textOf(sent[0])).not.toContain("{{target}}")
  }, 30_000)

  it("sends without a parameter the template declared optional", async () => {
    await createChatTemplate({
      name: "Optional note",
      body: "ship it {{note}}",
      params: [{ id: "note", label: "Note", required: false, kind: "string" }],
    })
    const sent: unknown[] = []
    const { ta } = await mount((content) => sent.push(content))

    fireEvent.change(ta, { target: { value: "/" } })
    fireEvent.mouseDown(await screen.findByText("Optional note"))
    await waitFor(() => expect(ta.value).toBe("ship it {{note}} "))

    await submit(ta)
    expect(sent).toHaveLength(1)
  }, 30_000)

  it("still refuses a send when an undeclared token is empty", async () => {
    const sent: unknown[] = []
    const { ta } = await mount((content) => sent.push(content))

    fireEvent.change(ta, { target: { value: "review {{module}}" } })
    await submit(ta)

    expect(sent).toHaveLength(0)
  }, 30_000)
})

describe("Composer — repository templates", () => {
  const REVIEW_MD = "---\nname: House review\n---\nReview {{module}} the way we do here."

  beforeEach(() => {
    listWorkspaceDir.mockResolvedValue([
      {
        relPath: ".cognia/templates/review.md",
        isDir: false,
        absolutePath: "",
        size: 0,
        mtimeMs: 0,
      },
    ])
    readWorkspaceFile.mockResolvedValue(REVIEW_MD)
  })

  it("offers a checkout's template beside the personal ones and inserts it", async () => {
    await createChatTemplate({ name: "Mine", body: "my own {{thing}}" })
    const { ta } = await mount(() => undefined, { workingDir: "/repo" })

    fireEvent.change(ta, { target: { value: "/" } })
    // Personal first: a `git pull` must not reorder the list you built muscle
    // memory on.
    await waitFor(() => expect(screen.getByText("Mine")).toBeInTheDocument())
    expect(await screen.findByText("House review")).toBeInTheDocument()
    // Where it came from is on the row — a template that arrived with the code
    // is a different kind of thing from one you saved.
    expect(screen.getByText(".cognia/templates/review.md")).toBeInTheDocument()

    fireEvent.mouseDown(screen.getByText("House review"))
    await waitFor(() => expect(ta.value).toBe("Review {{module}} the way we do here. "))
  }, 30_000)

  it("offers nothing from a checkout with no templates directory", async () => {
    listWorkspaceDir.mockRejectedValue(new Error("no such file or directory"))
    await createChatTemplate({ name: "Mine", body: "my own {{thing}}" })
    const { ta } = await mount(() => undefined, { workingDir: "/repo" })

    fireEvent.change(ta, { target: { value: "/" } })
    await waitFor(() => expect(screen.getByText("Mine")).toBeInTheDocument())
    expect(screen.queryByText("House review")).not.toBeInTheDocument()
  }, 30_000)
})

describe("Composer — re-running a turn", () => {
  it("records what the turn was written from, tokens intact", async () => {
    const runs: unknown[] = []
    const { ta } = await mount((_content, _manifest, templateRun) => runs.push(templateRun))

    fireEvent.change(ta, { target: { value: "review {{module}} please" } })
    clickAt(ta, 10)
    fireEvent.change(paramInput(), { target: { value: "auth" } })
    await submit(ta)

    // The text as it read BEFORE substitution — the only form in which the
    // parameters are still visible as parameters.
    expect(runs[0]).toEqual({
      templateId: expect.any(String),
      version: expect.any(String),
      text: "review {{module}} please",
      params: { module: { kind: "text", value: "auth" } },
    })
  }, 30_000)

  it("records nothing for a turn with no parameters", async () => {
    const runs: unknown[] = []
    const { ta } = await mount((_content, _manifest, templateRun) => runs.push(templateRun))

    fireEvent.change(ta, { target: { value: "just a message" } })
    await submit(ta)

    expect(runs[0]).toBeNull()
  }, 30_000)

  it("loads a past turn back into the box with its chips filled", async () => {
    const { ta } = await mount()

    await act(async () => {
      requestTemplateRerun({
        sessionId: session.id,
        run: {
          templateId: "tpl",
          version: "1",
          text: "review {{module}} please",
          params: { module: { kind: "text", value: "billing" } },
        },
      })
    })

    await waitFor(() => expect(ta.value).toBe("review {{module}} please"))
    expect(chips()[0]).toHaveAttribute("data-param-state", "filled")
    // ...with the editor open on it, because changing a value is the reason to
    // re-run a turn at all.
    await waitFor(() => expect(screen.getByTestId("template-param-popover")).toBeInTheDocument())
  }, 30_000)

  // Several composers are mounted at once in a split pane group.
  it("ignores a request addressed to another conversation", async () => {
    const { ta } = await mount()

    await act(async () => {
      requestTemplateRerun({
        sessionId: "ses_other",
        run: {
          templateId: "tpl",
          version: "1",
          text: "review {{module}}",
          params: { module: { kind: "text", value: "billing" } },
        },
      })
    })

    expect(ta.value).toBe("")
  }, 30_000)

  // The input history only holds SENT messages, so replacing a half-written
  // draft would leave nothing to recover it from.
  it("refuses over a non-empty box rather than destroying the draft", async () => {
    const { ta } = await mount()
    fireEvent.change(ta, { target: { value: "half a thought" } })

    await act(async () => {
      requestTemplateRerun({
        sessionId: session.id,
        run: {
          templateId: "tpl",
          version: "1",
          text: "review {{module}}",
          params: { module: { kind: "text", value: "billing" } },
        },
      })
    })

    expect(ta.value).toBe("half a thought")
  }, 30_000)
})
