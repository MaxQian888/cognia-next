/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
const routerPush = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({
    push: routerPush,
    replace: jest.fn(),
    prefetch: jest.fn(),
    back: jest.fn(),
    pathname: "/",
    query: {},
    asPath: "/",
  }),
  usePathname: () => "/",
}))
// Radix Select needs pointer APIs jsdom lacks; the repo pattern is a native
// <select> stand-in (see observability/refresh-select.test.tsx).
jest.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value?: string
    onValueChange?: (v: string) => void
    children: React.ReactNode
  }) => (
    <select value={value} onChange={(e) => onValueChange?.(e.target.value)}>
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectGroup: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectValue: () => null,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}))
// jsdom never measures a width, so the density tier is driven by hand.
let listDensity: "split" | "stacked" = "split"
jest.mock("@/components/settings/common/settings-master-detail", () => ({
  ...jest.requireActual("@/components/settings/common/settings-master-detail"),
  useSettingsListDensity: () => listDensity,
}))
const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}))
const downloadBlobMock = jest.fn()
jest.mock("@cognia/plugin-sdk/api/download", () => ({
  downloadBlob: (...a: unknown[]) => downloadBlobMock(...a),
}))
const saveToRepoMock = jest.fn()
jest.mock("@/lib/chat/template/repo-template-write", () => ({
  saveChatTemplateToRepository: (...a: unknown[]) => saveToRepoMock(...a),
}))
const loadRepoMock = jest.fn<Promise<RepoChatTemplate[]>, [string | null | undefined]>()
jest.mock("@/hooks/chat/use-repo-chat-templates", () => ({
  loadRepoChatTemplates: (root: string | null | undefined) => loadRepoMock(root),
}))
jest.mock("@/hooks/chat/use-effective-cwd", () => ({
  resolveEffectiveCwdForSession: async () => "/repo",
}))
// The resource picker's live sources — mutable so a test can stand in for a
// device that does (or does not) know about an agent.
let mentionableSubagents: { id: string; handle: string }[] = []
let markdownChatAgents: { id: string; handle: string }[] = []
jest.mock("@/hooks/chat/use-mentionable-subagents", () => ({
  useMentionableSubagents: () => mentionableSubagents,
}))
jest.mock("@/hooks/chat/use-markdown-chat-agents", () => ({
  useMarkdownChatAgents: () => markdownChatAgents,
}))
jest.mock("@/hooks/chat/use-template-resource-search", () => ({
  useTemplateResourceSearch: () => async () => [],
}))
// "Use in chat" hands off to session+draft plumbing; the wiring is what the
// test pins, not Dexie writes on the session side.
const createSessionMock = jest.fn(async () => ({ id: "sess-use-1" }))
jest.mock("@/lib/db/sessions", () => ({
  ...jest.requireActual("@/lib/db/sessions"),
  createSession: () => createSessionMock(),
}))
const setDraftMock = jest.fn(async (..._a: unknown[]) => undefined)
jest.mock("@/lib/db/chat-drafts", () => ({
  ...jest.requireActual("@/lib/db/chat-drafts"),
  setDraft: (...a: unknown[]) => setDraftMock(...a),
}))
const setActiveSessionMock = jest.fn()
jest.mock("@/stores/chat", () => ({
  useChatStore: Object.assign((selector: (s: Record<string, never>) => unknown) => selector({}), {
    getState: () => ({ setActiveSession: setActiveSessionMock }),
  }),
}))
const assistGenerate = jest.fn()
const assistImprove = jest.fn()
const assistSuggest = jest.fn()
jest.mock("@/hooks/chat/use-template-assist", () => ({
  useTemplateAssist: () => ({
    running: false,
    op: null,
    generate: (...a: unknown[]) => assistGenerate(...a),
    improve: (...a: unknown[]) => assistImprove(...a),
    suggest: (...a: unknown[]) => assistSuggest(...a),
    cancel: jest.fn(),
  }),
}))

import { ChatTemplatesSection } from "./chat-templates-section"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import {
  createChatTemplate,
  getChatTemplate,
  listChatTemplates,
  recordChatTemplateUse,
} from "@/lib/db/chat-templates"
import {
  parseRepoTemplate,
  serializeChatTemplate,
  type RepoChatTemplate,
} from "@/lib/chat/template/repo-templates"
import { RESOURCE_PARAM_KINDS } from "@/lib/chat/template/resource-kinds"
import enSettings from "@/i18n/messages/en/chatTemplatesSettings.json"
import zhSettings from "@/i18n/messages/zh-CN/chatTemplatesSettings.json"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
afterAll(dbFixture.dispose)

beforeEach(async () => {
  toastSuccess.mockClear()
  toastError.mockClear()
  downloadBlobMock.mockClear()
  listDensity = "split"
  mentionableSubagents = []
  markdownChatAgents = []
  saveToRepoMock.mockReset()
  saveToRepoMock.mockResolvedValue({ ok: true, path: ".cognia/templates/review.md" })
  loadRepoMock.mockReset()
  loadRepoMock.mockResolvedValue([])
  routerPush.mockClear()
  createSessionMock.mockClear()
  setDraftMock.mockClear()
  setActiveSessionMock.mockClear()
  await dbFixture.restore()
})

/** jsdom's Blob has no `.text()`, and the app does not use it either. */
function readBlobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    reader.onload = () => resolve(String(reader.result))
    reader.readAsText(blob)
  })
}

async function mount() {
  await act(async () => {
    render(<ChatTemplatesSection />)
  })
}

/**
 * Opens the detail pane's overflow menu, where the destructive/file actions
 * live. Radix menus open on pointerdown — userEvent, not a bare click.
 */
async function openActions() {
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: "moreActions" }))
  return user
}

/** Opens the editor's parameter disclosure — the rows sit behind it. */
function expandParams() {
  fireEvent.click(screen.getByRole("button", { name: /customizeParams/ }))
}

describe("ChatTemplatesSection", () => {
  it("says so when nothing has been saved", async () => {
    await mount()

    expect(screen.getByText("empty")).toBeInTheDocument()
  })

  it("lists a template with its parameters as fill-in chips", async () => {
    await createChatTemplate({ name: "Review a PR", body: "review {{module}} on {{branch}}" })

    await mount()

    await waitFor(() => expect(screen.getAllByText("Review a PR").length).toBeGreaterThan(0))
    // The detail preview renders each token as a chip — the message is the
    // primary object now, not a list of action buttons.
    expect(screen.getByText("{{module}}")).toBeInTheDocument()
    expect(screen.getByText("{{branch}}")).toBeInTheDocument()
  })

  it("edits the body and re-derives what the template asks for", async () => {
    // Saving used to be a one-way door: a typo in the body was permanent.
    const row = await createChatTemplate({ name: "Review", body: "review {{module}}" })
    await mount()
    await waitFor(() => expect(screen.getAllByText("Review").length).toBeGreaterThan(0))

    fireEvent.click(screen.getByRole("button", { name: "edit" }))
    fireEvent.change(screen.getByLabelText("body"), {
      target: { value: "review {{module}} on {{branch}}" },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "save" }))
    })

    await waitFor(async () => {
      const stored = await getChatTemplate(row.id)
      expect(stored?.body).toBe("review {{module}} on {{branch}}")
      expect(stored?.params.map((p) => p.id)).toEqual(["module", "branch"])
      // A content edit invalidates drafts that quoted the old body.
      expect(stored?.revision).toBe(2)
    })
  })

  it("deletes a template only after the confirm dialog", async () => {
    await createChatTemplate({ name: "Review", body: "x" })
    await mount()
    await waitFor(() => expect(screen.getAllByText("Review").length).toBeGreaterThan(0))

    const user = await openActions()
    await act(async () => {
      await user.click(screen.getByRole("menuitem", { name: "delete" }))
    })

    // The menu item only asked — the row must still be there.
    expect(await listChatTemplates()).toHaveLength(1)
    const dialog = await screen.findByRole("alertdialog")
    await act(async () => {
      await user.click(within(dialog).getByRole("button", { name: "delete" }))
    })

    await waitFor(async () => expect(await listChatTemplates()).toEqual([]))
  })

  it("dismisses the delete dialog without touching the row", async () => {
    await createChatTemplate({ name: "Review", body: "x" })
    await mount()
    await waitFor(() => expect(screen.getAllByText("Review").length).toBeGreaterThan(0))

    const user = await openActions()
    await act(async () => {
      await user.click(screen.getByRole("menuitem", { name: "delete" }))
    })
    const dialog = await screen.findByRole("alertdialog")
    await act(async () => {
      await user.click(within(dialog).getByRole("button", { name: "cancel" }))
    })

    expect(await listChatTemplates()).toHaveLength(1)
  })

  it("copies the message with the rehearsed values substituted", async () => {
    await createChatTemplate({
      name: "Review",
      body: "review {{module}} on {{branch}}",
      params: [
        { id: "module", label: "Module", required: true, kind: "string" },
        { id: "branch", label: "Branch", required: true, kind: "string" },
      ],
    })
    await mount()
    await waitFor(() => expect(screen.getAllByText("Review").length).toBeGreaterThan(0))

    // userEvent.setup() (inside openActions) installs its own clipboard stub —
    // spy on writeText only after it exists, or the spy is silently replaced.
    const user = await openActions()
    const writeText = jest.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined)
    await act(async () => {
      await user.click(screen.getByRole("menuitem", { name: "copyMessage" }))
    })

    // Unfilled tokens stay literal — the render layer refuses to punch a hole.
    expect(writeText).toHaveBeenCalledWith("review {{module}} on {{branch}}")
    expect(toastSuccess).toHaveBeenCalledWith("copied")
  })

  it("copies seeded values in place of their tokens", async () => {
    await createChatTemplate({
      name: "Deploy",
      body: "deploy {{service}} to {{env}}",
      params: [
        { id: "service", label: "Service", required: true, kind: "string", defaultValue: "web" },
        { id: "env", label: "Env", required: true, kind: "string" },
      ],
    })
    await mount()
    await waitFor(() => expect(screen.getAllByText("Deploy").length).toBeGreaterThan(0))

    const user = await openActions()
    const writeText = jest.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined)
    await act(async () => {
      await user.click(screen.getByRole("menuitem", { name: "copyMessage" }))
    })

    // The declared default seeds the rehearsal; the unfilled slot stays a token.
    expect(writeText).toHaveBeenCalledWith("deploy web to {{env}}")
  })

  it("says so when the clipboard refuses the write", async () => {
    await createChatTemplate({ name: "Review", body: "x" })
    await mount()
    await waitFor(() => expect(screen.getAllByText("Review").length).toBeGreaterThan(0))

    const user = await openActions()
    jest.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"))
    await act(async () => {
      await user.click(screen.getByRole("menuitem", { name: "copyMessage" }))
    })

    expect(toastError).toHaveBeenCalledWith("copyFailed")
    expect(toastSuccess).not.toHaveBeenCalledWith("copied")
  })

  it("opens a fresh chat with the rehearsed binding as the draft", async () => {
    await createChatTemplate({
      name: "Review",
      body: "review {{module}}",
      params: [{ id: "module", label: "Module", required: true, kind: "string" }],
    })
    await mount()
    await waitFor(() => expect(screen.getAllByText("Review").length).toBeGreaterThan(0))

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "useInChat" }))
    })

    expect(createSessionMock).toHaveBeenCalled()
    expect(setDraftMock).toHaveBeenCalledWith(
      "sess-use-1",
      "review {{module}}",
      [],
      expect.objectContaining({
        templateBinding: expect.objectContaining({
          templateId: expect.any(String),
          version: "1",
        }),
      })
    )
    expect(setActiveSessionMock).toHaveBeenCalledWith("sess-use-1")
    expect(routerPush).toHaveBeenCalledWith("/")
  })

  it("says so instead of navigating when the session cannot be created", async () => {
    createSessionMock.mockRejectedValueOnce(new Error("db gone"))
    await createChatTemplate({ name: "Review", body: "x" })
    await mount()
    await waitFor(() => expect(screen.getAllByText("Review").length).toBeGreaterThan(0))

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "useInChat" }))
    })

    expect(toastError).toHaveBeenCalledWith("useInChatFailed")
    expect(setActiveSessionMock).not.toHaveBeenCalled()
    expect(routerPush).not.toHaveBeenCalled()
  })

  it("creates a template from the New flow", async () => {
    await mount()
    await waitFor(() => expect(screen.getByText("empty")).toBeInTheDocument())

    fireEvent.click(screen.getByRole("button", { name: "emptyCreate" }))
    fireEvent.change(screen.getByLabelText("name"), { target: { value: "Standup" } })
    fireEvent.change(screen.getByLabelText("body"), {
      target: { value: "today: {{today}}, blocked: {{blocked}}" },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "save" }))
    })

    await waitFor(async () => {
      const rows = await listChatTemplates()
      expect(rows).toHaveLength(1)
      expect(rows[0].name).toBe("Standup")
      expect(rows[0].params.map((p) => p.id)).toEqual(["today", "blocked"])
    })
  })

  it("opens the composer's fill popover when a slot chip is clicked", async () => {
    await createChatTemplate({ name: "Review", body: "review {{module}}" })
    await mount()
    await waitFor(() => expect(screen.getAllByText("Review").length).toBeGreaterThan(0))

    fireEvent.click(screen.getByRole("button", { name: "fillSlot" }))

    await waitFor(() => expect(screen.getByTestId("template-param-popover")).toBeInTheDocument())
  })

  it("fills a slot through the popover and clears the required count", async () => {
    await createChatTemplate({ name: "Review", body: "review {{module}}" })
    await mount()
    await waitFor(() => expect(screen.getAllByText("Review").length).toBeGreaterThan(0))

    expect(screen.getByText("requiredLeft")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "fillSlot" }))
    const input = await screen.findByLabelText("module")
    fireEvent.change(input, { target: { value: "core" } })

    // The committed value lands in the chip and the send gate opens.
    await waitFor(() => expect(screen.getByText("readyToSend")).toBeInTheDocument())
    const preview = screen.getByTestId("chat-template-body-preview")
    expect(preview.textContent).toContain("core")
  })

  it("filters the rail by search text", async () => {
    await createChatTemplate({ name: "Review", body: "review {{module}}" })
    await createChatTemplate({ name: "Standup", body: "did {{today}}" })
    await mount()
    await waitFor(() => expect(screen.getAllByText("Review").length).toBeGreaterThan(0))

    fireEvent.change(screen.getByLabelText("searchPlaceholder"), {
      target: { value: "stand" },
    })

    // The rail drops non-matches; the selected detail stays put.
    const rail = screen.getByRole("complementary")
    await waitFor(() => {
      expect(within(rail).queryByText("Review")).toBeNull()
      expect(within(rail).getByText("Standup")).toBeInTheDocument()
    })
  })

  it("switches the detail when another rail item is picked", async () => {
    await createChatTemplate({ name: "Review", body: "review {{module}}" })
    await createChatTemplate({ name: "Standup", body: "did {{today}}" })
    await mount()
    await waitFor(() => expect(screen.getAllByText("Review").length).toBeGreaterThan(0))

    const rail = screen.getByRole("complementary")
    fireEvent.click(within(rail).getByText("Standup"))

    const preview = screen.getByTestId("chat-template-body-preview")
    await waitFor(() => expect(preview.textContent).toContain("{{today}}"))
  })

  it("opens the editor from the rail's New button", async () => {
    await mount()
    const rail = screen.getByRole("complementary")
    fireEvent.click(within(rail).getByRole("button", { name: "newTemplate" }))

    expect(screen.getByLabelText("name")).toBeInTheDocument()

    // Cancel leaves the form without touching the table.
    fireEvent.click(screen.getByRole("button", { name: "cancel" }))
    expect(screen.queryByLabelText("name")).toBeNull()
    expect(await listChatTemplates()).toEqual([])
  })

  it("cancels an edit without writing anything back", async () => {
    await createChatTemplate({ name: "Review", body: "review {{module}}" })
    await mount()
    await waitFor(() => expect(screen.getAllByText("Review").length).toBeGreaterThan(0))

    fireEvent.click(screen.getByRole("button", { name: "edit" }))
    fireEvent.change(screen.getByLabelText("name"), { target: { value: "Renamed" } })
    fireEvent.click(screen.getByRole("button", { name: "cancel" }))

    expect(screen.queryByLabelText("name")).toBeNull()
    expect((await listChatTemplates())[0].name).toBe("Review")
  })

  it("dismisses the fill popover without committing a value", async () => {
    await createChatTemplate({ name: "Review", body: "review {{module}}" })
    await mount()
    await waitFor(() => expect(screen.getAllByText("Review").length).toBeGreaterThan(0))

    fireEvent.click(screen.getByRole("button", { name: "fillSlot" }))
    await screen.findByTestId("template-param-popover")
    fireEvent.keyDown(document.body, { key: "Escape" })

    await waitFor(() => expect(screen.queryByTestId("template-param-popover")).toBeNull())
  })

  it("opens the file picker from both import affordances", async () => {
    const clickSpy = jest.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {})
    await mount()
    await waitFor(() => expect(screen.getByText("empty")).toBeInTheDocument())

    // Both import buttons — the rail's and the empty detail's — drive the
    // same hidden file input.
    for (const button of screen.getAllByRole("button", { name: "importAction" })) {
      fireEvent.click(button)
    }
    expect(clickSpy).toHaveBeenCalledTimes(2)
    clickSpy.mockRestore()
  })
})

describe("ChatTemplatesSection — resource slots", () => {
  const subagentParam = {
    id: "helper",
    label: "helper",
    required: true,
    kind: "resource" as const,
    resourceKind: "subagent" as const,
  }
  const ghostValue = {
    kind: "resource" as const,
    resourceKind: "subagent" as const,
    id: "ghost-agent",
    label: "Ghost Agent",
    raw: "@ghost-agent",
  }

  it("keeps a synced value filled when no source can judge it", async () => {
    // No agents known on this device at all — the same "no evidence" call the
    // composer makes, not an unresolved red chip.
    const row = await createChatTemplate({
      name: "Ask an agent",
      body: "ask {{helper}}",
      params: [subagentParam],
    })
    await recordChatTemplateUse(row.id, { helper: ghostValue })
    await mount()
    await waitFor(() => expect(screen.getAllByText("Ask an agent").length).toBeGreaterThan(0))

    const chip = screen.getByText("@ghost-agent")
    expect(chip.className).not.toContain("border-dashed")
  })

  it("marks the value unresolved when the device knows the agent is gone", async () => {
    markdownChatAgents = [{ id: "md-1", handle: "reviewer" }]
    const row = await createChatTemplate({
      name: "Ask an agent",
      body: "ask {{helper}}",
      params: [subagentParam],
    })
    await recordChatTemplateUse(row.id, { helper: ghostValue })
    await mount()
    await waitFor(() => expect(screen.getAllByText("Ask an agent").length).toBeGreaterThan(0))

    // The label stays readable — only the amber ring carries the warning,
    // the same unresolved tint the composer overlay paints.
    const chip = screen.getByText("@ghost-agent")
    expect(chip.className).toContain("ring-amber-500/40")
  })

  it("never marks a file value unresolved — this surface cannot judge files", async () => {
    const row = await createChatTemplate({
      name: "Explain file",
      body: "explain {{target}}",
      params: [
        {
          id: "target",
          label: "target",
          required: true,
          kind: "resource" as const,
          resourceKind: "file" as const,
        },
      ],
    })
    await recordChatTemplateUse(row.id, {
      target: {
        kind: "resource",
        resourceKind: "file",
        id: "src/old.ts",
        label: "old.ts",
        raw: "@src/old.ts",
      },
    })
    await mount()
    await waitFor(() => expect(screen.getAllByText("Explain file").length).toBeGreaterThan(0))

    expect(screen.getByText("@src/old.ts").className).not.toContain("border-dashed")
  })
})

describe("ChatTemplatesSection — layout tiers", () => {
  it("offers the picker instead of the rail at the stacked density", async () => {
    listDensity = "stacked"
    await createChatTemplate({ name: "Review", body: "review {{module}}" })
    await createChatTemplate({ name: "Standup", body: "did {{today}}" })
    await mount()
    await waitFor(() => expect(screen.getAllByText("Review").length).toBeGreaterThan(0))

    // The native-select stand-in carries one option per template.
    const picker = screen.getByRole("combobox")
    fireEvent.change(picker, {
      target: { value: (await listChatTemplates()).find((r) => r.name === "Standup")!.id },
    })

    const preview = screen.getByTestId("chat-template-body-preview")
    await waitFor(() => expect(preview.textContent).toContain("{{today}}"))
  })
})

describe("ChatTemplatesSection — parameter declarations", () => {
  it("makes a parameter optional, so a send no longer waits on it", async () => {
    const row = await createChatTemplate({ name: "Review", body: "review {{module}}" })
    await mount()
    await waitFor(() => expect(screen.getAllByText("Review").length).toBeGreaterThan(0))

    fireEvent.click(screen.getByRole("button", { name: "edit" }))
    expandParams()
    fireEvent.click(screen.getByRole("checkbox", { name: "paramRequired" }))
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "save" }))
    })

    const saved = await getChatTemplate(row.id)
    expect(saved?.params).toEqual([
      { id: "module", label: "module", required: false, kind: "string" },
    ])
    // A declaration change IS content: a draft quoting the old revision must
    // not silently inherit the new rules.
    expect(saved?.revision).toBe(2)
  })

  it("keeps an edited label when the body is rewritten around it", async () => {
    const row = await createChatTemplate({ name: "Review", body: "review {{module}}" })
    await mount()
    await waitFor(() => expect(screen.getAllByText("Review").length).toBeGreaterThan(0))

    fireEvent.click(screen.getByRole("button", { name: "edit" }))
    expandParams()
    fireEvent.change(screen.getByLabelText("paramLabel"), { target: { value: "Which module" } })
    fireEvent.change(screen.getByLabelText("body"), {
      target: { value: "please review {{module}} today" },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "save" }))
    })

    const saved = await getChatTemplate(row.id)
    expect(saved?.params[0].label).toBe("Which module")
    expect(saved?.body).toBe("please review {{module}} today")
  })
})

// The "Picks from" select labels each kind with a DYNAMIC key
// (`resource${Kind}`), which `pnpm lint:i18n` does not see. Walked from the
// runtime list, so a new parameter kind fails here instead of shipping an option
// that reads `resourceWhatever`.
describe("ChatTemplatesSection — resource kind labels", () => {
  const catalogues = {
    en: enSettings as Record<string, string>,
    "zh-CN": zhSettings as Record<string, string>,
  }
  const keyOf = (kind: string) => `resource${kind.charAt(0).toUpperCase()}${kind.slice(1)}`

  it.each(Object.keys(catalogues))("%s labels every parameter kind", (locale) => {
    const catalogue = catalogues[locale as keyof typeof catalogues]
    const missing = RESOURCE_PARAM_KINDS.filter(
      (kind) => typeof catalogue[keyOf(kind)] !== "string"
    )
    expect(missing).toEqual([])
  })

  it("gives each kind a distinct label", () => {
    // An Agent Team teammate (`agent`) and a team room member (`member`) are
    // different pickers over different sources; one word for both would leave
    // the author guessing which one they declared.
    for (const catalogue of Object.values(catalogues)) {
      const labels = RESOURCE_PARAM_KINDS.map((kind) => catalogue[keyOf(kind)])
      expect(new Set(labels).size).toBe(labels.length)
    }
  })
})

describe("ChatTemplatesSection — portability", () => {
  it("exports the same Markdown document the composer reads back", async () => {
    await createChatTemplate({ name: "Review a PR", body: "review {{module}}" })
    await mount()
    await waitFor(() => expect(screen.getAllByText("Review a PR").length).toBeGreaterThan(0))

    const user = await openActions()
    await act(async () => {
      await user.click(screen.getByRole("menuitem", { name: /exportAction/ }))
    })

    expect(downloadBlobMock).toHaveBeenCalledTimes(1)
    const [filename, blob] = downloadBlobMock.mock.calls[0] as [string, Blob]
    expect(filename).toBe("review-a-pr.md")
    const parsed = parseRepoTemplate(filename, await readBlobText(blob))
    expect(parsed?.name).toBe("Review a PR")
    expect(parsed?.body).toBe("review {{module}}")
  })

  it("imports a Markdown file under a freshly minted id", async () => {
    await mount()
    const file = new File(
      [serializeChatTemplate({ name: "From a file", body: "do {{thing}}", params: [] })],
      "from-a-file.md",
      { type: "text/markdown" }
    )

    await act(async () => {
      fireEvent.change(screen.getByLabelText("importAction"), { target: { files: [file] } })
    })

    await waitFor(async () => {
      const rows = await listChatTemplates()
      expect(rows).toHaveLength(1)
      expect(rows[0].name).toBe("From a file")
      // The parser's id names a FILE. Reusing it would collide with the
      // checkout's own template the moment one is opened.
      expect(rows[0].id.startsWith("repo:")).toBe(false)
      expect(rows[0].id.startsWith("tpl_")).toBe(true)
    })
  })

  it("says so rather than saving nothing when the file is not a template", async () => {
    await mount()
    const file = new File(["---\nname: [\n---\nbody"], "broken.md", { type: "text/markdown" })

    await act(async () => {
      fireEvent.change(screen.getByLabelText("importAction"), { target: { files: [file] } })
    })

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("importFailed"))
    expect(await listChatTemplates()).toEqual([])
  })

  it("writes to the workspace the send path would use", async () => {
    await createChatTemplate({ name: "Review", body: "x" })
    await mount()
    await waitFor(() => expect(screen.getAllByText("Review").length).toBeGreaterThan(0))

    const user = await openActions()
    await act(async () => {
      await user.click(screen.getByRole("menuitem", { name: /saveToRepo/ }))
    })

    await waitFor(() => expect(saveToRepoMock).toHaveBeenCalled())
    expect(saveToRepoMock.mock.calls[0][0]).toBe("/repo")
    // The mocked translator echoes the key, so the assertion is on WHICH
    // message was raised, not on its interpolation.
    expect(toastSuccess).toHaveBeenCalledWith("savedToRepo")
  })

  it("asks before replacing a file a teammate may have written", async () => {
    saveToRepoMock.mockResolvedValueOnce({
      ok: false,
      reason: "exists",
      path: ".cognia/templates/review.md",
    })
    await createChatTemplate({ name: "Review", body: "x" })
    await mount()
    await waitFor(() => expect(screen.getAllByText("Review").length).toBeGreaterThan(0))

    const user = await openActions()
    await act(async () => {
      await user.click(screen.getByRole("menuitem", { name: /saveToRepo/ }))
    })

    const dialog = await screen.findByRole("alertdialog")
    expect(dialog).toBeInTheDocument()
    // Nothing was written yet: the second call is the confirmed one.
    expect(saveToRepoMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "overwriteConfirm" }))
    })

    await waitFor(() => expect(saveToRepoMock).toHaveBeenCalledTimes(2))
    expect(saveToRepoMock.mock.calls[1][2]).toEqual({ overwrite: true })
  })

  it("names the reason a write was refused", async () => {
    saveToRepoMock.mockResolvedValueOnce({
      ok: false,
      reason: "restricted",
      path: ".cognia/templates/review.md",
    })
    await createChatTemplate({ name: "Review", body: "x" })
    await mount()
    await waitFor(() => expect(screen.getAllByText("Review").length).toBeGreaterThan(0))

    const user = await openActions()
    await act(async () => {
      await user.click(screen.getByRole("menuitem", { name: /saveToRepo/ }))
    })

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("saveToRepoRestricted"))
  })

  it("says so when there is no workspace to write into", async () => {
    saveToRepoMock.mockResolvedValueOnce({ ok: false, reason: "no-root", path: "" })
    await createChatTemplate({ name: "Review", body: "x" })
    await mount()
    await waitFor(() => expect(screen.getAllByText("Review").length).toBeGreaterThan(0))

    const user = await openActions()
    await act(async () => {
      await user.click(screen.getByRole("menuitem", { name: /saveToRepo/ }))
    })

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("saveToRepoNoRoot"))
  })

  it("names the file a write failed on", async () => {
    saveToRepoMock.mockResolvedValueOnce({
      ok: false,
      reason: "failed",
      path: ".cognia/templates/review.md",
    })
    await createChatTemplate({ name: "Review", body: "x" })
    await mount()
    await waitFor(() => expect(screen.getAllByText("Review").length).toBeGreaterThan(0))

    const user = await openActions()
    await act(async () => {
      await user.click(screen.getByRole("menuitem", { name: /saveToRepo/ }))
    })

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("saveToRepoFailed"))
  })

  it("duplicates a template as a new one, with no history behind it", async () => {
    const row = await createChatTemplate({ name: "Review", body: "review {{module}}" })
    await mount()
    await waitFor(() => expect(screen.getAllByText("Review").length).toBeGreaterThan(0))

    const user = await openActions()
    await act(async () => {
      await user.click(screen.getByRole("menuitem", { name: "duplicate" }))
    })

    await waitFor(async () => expect(await listChatTemplates()).toHaveLength(2))
    const copy = (await listChatTemplates()).find((t) => t.id !== row.id)!
    expect(copy.name).toBe("duplicatedName")
    expect(copy.usageCount).toBe(0)
    expect(copy.revision).toBe(1)
    expect(copy.params).toEqual(row.params)
  })
})

describe("ChatTemplatesSection — repository templates", () => {
  const repoRow = {
    id: "repo:review",
    name: "Team review",
    body: "review {{module}}",
    params: [{ id: "module", label: "module", required: true, kind: "string" as const }],
    launchSpec: { permissionMode: "plan" as const },
    revision: 7,
    source: "repo" as const,
    sourcePath: ".cognia/templates/review.md",
  }

  it("lists what the checkout contributes, read-only and named by its file", async () => {
    loadRepoMock.mockResolvedValue([repoRow])
    await mount()

    await waitFor(() => expect(screen.getByTestId("repo-chat-templates")).toBeInTheDocument())
    expect(screen.getAllByText("Team review").length).toBeGreaterThan(0)
    expect(screen.getAllByText(".cognia/templates/review.md").length).toBeGreaterThan(0)
    // A file is not editable from here, and the page must not pretend it is.
    expect(screen.queryByRole("button", { name: "edit" })).toBeNull()
  })

  it("adopts one into the local table under a fresh id, keeping the demoted setup", async () => {
    loadRepoMock.mockResolvedValue([repoRow])
    await mount()
    await waitFor(() => expect(screen.getAllByText("Team review").length).toBeGreaterThan(0))

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "adopt" }))
    })

    await waitFor(async () => {
      const rows = await listChatTemplates()
      expect(rows).toHaveLength(1)
      expect(rows[0].id.startsWith("repo:")).toBe(false)
      expect(rows[0].name).toBe("Team review")
      // Adopting must not be a way to launder a setup past the trust gate: the
      // spec copied is the one the reader already demoted.
      expect(rows[0].launchSpec).toEqual({ permissionMode: "plan" })
    })
  })

  it("reads the checkout through the loader the composer uses, under the same root", async () => {
    loadRepoMock.mockResolvedValue([])
    await mount()

    await waitFor(() => expect(loadRepoMock).toHaveBeenCalledWith("/repo"))
  })
})

describe("ChatTemplatesSection — mobile layout", () => {
  /**
   * The master/detail split is handled by `SettingsListDetail`'s measured
   * collapse. What `mobile` still owns is the editor's param rows: at 375px a
   * label input cannot share a row with the kind picker, so it goes full-width.
   */
  it("gives the param label field the full row width on mobile", async () => {
    await createChatTemplate({ name: "Review", body: "review {{module}}" })
    render(<ChatTemplatesSection mobile />)
    await act(async () => {
      await Promise.resolve()
    })
    await waitFor(() => expect(screen.getAllByText("Review").length).toBeGreaterThan(0))

    fireEvent.click(screen.getByRole("button", { name: "edit" }))
    expandParams()

    // The base Input always carries w-full; mobile drops the flex-1 share.
    expect(screen.getByLabelText("paramLabel").className).not.toContain("flex-1")
  })

  it("keeps the param label field inline when the flag is off", async () => {
    await createChatTemplate({ name: "Review", body: "review {{module}}" })
    render(<ChatTemplatesSection />)
    await act(async () => {
      await Promise.resolve()
    })
    await waitFor(() => expect(screen.getAllByText("Review").length).toBeGreaterThan(0))

    fireEvent.click(screen.getByRole("button", { name: "edit" }))
    expandParams()

    expect(screen.getByLabelText("paramLabel").className).toContain("flex-1")
  })
})
