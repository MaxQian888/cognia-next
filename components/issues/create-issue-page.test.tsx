/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

const mockCreateIssue = jest.fn()
const mockCreateIssueProject = jest.fn()
const mockListTakenProjectKeys = jest.fn()
const mockGetCollabWorkspace = jest.fn()
const mockEnqueueCollabMutation = jest.fn()
jest.mock("@/lib/db/issues", () => ({ createIssue: (...a: unknown[]) => mockCreateIssue(...a) }))
jest.mock("@/lib/db/issue-projects", () => ({
  createIssueProject: (...a: unknown[]) => mockCreateIssueProject(...a),
  listTakenProjectKeys: (...a: unknown[]) => mockListTakenProjectKeys(...a),
}))
jest.mock("@/lib/db/collab-workspace-mirror", () => ({
  getCollabWorkspace: (...a: unknown[]) => mockGetCollabWorkspace(...a),
}))
jest.mock("@/lib/db/mobile-outbound-queue", () => ({
  enqueueCollabMutation: (...a: unknown[]) => mockEnqueueCollabMutation(...a),
}))
jest.mock("./assignee-picker", () => ({
  AssigneePicker: () => <div data-testid="assignee-picker-stub" />,
}))
// The real renderer pulls in Shiki/mermaid — far heavier than this suite needs.
jest.mock("@/components/chat/markdown-renderer", () => ({
  MarkdownRenderer: ({ content }: { content: string }) => (
    <div data-testid="markdown-stub">{content}</div>
  ),
}))
const mockToastError = jest.fn()
const mockToastMessage = jest.fn()
const mockToastSuccess = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => mockToastSuccess(...a),
    info: jest.fn(),
    message: (...a: unknown[]) => mockToastMessage(...a),
    error: (...a: unknown[]) => mockToastError(...a),
  },
}))
// AI client resolution is mocked at the transport seam; the assist module
// itself is exercised through the real prompt/cleanup path.
const mockComplete = jest.fn()
const mockBuildUtility = jest.fn()
const mockBuildHeadless = jest.fn()
jest.mock("@/lib/ai/generation/utility-client", () => ({
  buildUtilityLlmClient: (...a: unknown[]) => mockBuildUtility(...a),
}))
jest.mock("@/lib/ai/headless-turn-llm-client", () => ({
  buildHeadlessTurnLlmClient: (...a: unknown[]) => mockBuildHeadless(...a),
}))

import userEvent from "@testing-library/user-event"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { LabelRow } from "@/types/labels"
import type { IssueCycle } from "@/types/issues"
import type { UnifiedIssueItem } from "@/types/issues/unified"
import {
  applyMarkdownFormat,
  CreateIssuePage,
  type CreateIssuePageProps,
} from "./create-issue-page"

const PROJECT = {
  id: "p1",
  projectId: "w1",
  key: "MERC",
  name: "Mercury",
  status: "planned" as const,
  priority: "none" as const,
  resources: [],
  createdAt: 1,
  updatedAt: 1,
}

const LABELS: LabelRow[] = [
  {
    id: "l1",
    scope: "issue",
    name: "Bug",
    color: "#ef4444",
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
  },
  { id: "l2", scope: "issue", name: "Docs", sortOrder: 1, createdAt: 1, updatedAt: 1 },
]

function makeIssue(sourceId: string, identifier: string, title: string): UnifiedIssueItem {
  return {
    unifiedId: `local:${sourceId}`,
    kind: "local",
    sourceId,
    identifier,
    title,
    status: "backlog",
    statusCategory: "unstarted",
    priority: "none",
    labelIds: [],
    order: 0,
    createdAt: 1,
    updatedAt: 1,
    origin: { deepLinkHref: "#" },
    capabilities: {
      canEdit: true,
      canMove: true,
      canAssign: true,
      canRun: true,
      canComment: true,
      canDelete: true,
      canManageLabels: true,
      canMoveProject: true,
    },
  }
}

const ISSUES: UnifiedIssueItem[] = [
  makeIssue("i1", "DEMO-1", "Fix login redirect loop"),
  makeIssue("i2", "DEMO-2", "Add dark mode toggle"),
  makeIssue("i3", "DEMO-3", "Login loop on mobile"),
]

const CYCLES: IssueCycle[] = [
  {
    id: "cy1",
    projectId: "w1",
    kind: "cycle",
    name: "Sprint 1",
    status: "active",
    externalRefs: [],
    externalKeys: [],
    createdAt: 1,
    updatedAt: 1,
  },
]

function baseProps(overrides: Partial<CreateIssuePageProps> = {}): CreateIssuePageProps {
  return {
    open: true,
    onOpenChange: jest.fn(),
    projectId: "w1",
    projects: [PROJECT],
    labels: LABELS,
    cycles: CYCLES,
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockListTakenProjectKeys.mockResolvedValue(new Set<string>())
  mockCreateIssue.mockResolvedValue({ id: "iss_1" })
  mockCreateIssueProject.mockResolvedValue({ id: "p-new" })
  mockGetCollabWorkspace.mockResolvedValue(undefined)
  mockEnqueueCollabMutation.mockResolvedValue({ id: "op_1" })
  mockBuildUtility.mockReturnValue({ complete: (...a: unknown[]) => mockComplete(...a) })
  mockBuildHeadless.mockReturnValue(null)
  localStorage.clear()
})

// ── variant param + switcher ────────────────────────────────────────────────

describe("CreateIssuePage", () => {
  function renderPage(overrides: Partial<CreateIssuePageProps> = {}) {
    const props = baseProps({ issues: ISSUES, ...overrides })
    render(<CreateIssuePage {...props} />)
    return props
  }

  it("lays out the GitHub shape: write/preview tabs, sidebar, live card preview", async () => {
    renderPage()
    expect(await screen.findByTestId("create-page")).toBeInTheDocument()
    expect(screen.getByTestId("create-tab-write")).toHaveAttribute("aria-selected", "true")
    expect(screen.getByTestId("create-tab-preview")).toBeInTheDocument()
    expect(screen.getByTestId("create-relationships")).toBeInTheDocument()
    // Live card preview shows the identifier the chosen container will mint.
    expect(screen.getByTestId("create-card-preview")).toHaveTextContent("MERC-?")
    for (const testId of [
      "create-field-status",
      "create-field-priority",
      "assignee-picker-stub",
      "create-field-labels",
      "create-issue-project",
      "create-field-cycle",
      "create-field-due",
      "create-field-estimate",
    ]) {
      expect(screen.getByTestId(testId)).toBeInTheDocument()
    }
  })

  it("switches between the editor and a rendered markdown preview", async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByTestId("create-tab-preview"))
    expect(screen.getByTestId("create-description-preview")).toHaveTextContent(
      "create.nothingToPreview"
    )
    await user.click(screen.getByTestId("create-tab-write"))
    await user.type(screen.getByTestId("create-issue-description"), "**bold** body")
    await user.click(screen.getByTestId("create-tab-preview"))
    expect(screen.getByTestId("markdown-stub")).toHaveTextContent("**bold** body")
  })

  it("picks a parent through the relationships row", async () => {
    const user = userEvent.setup()
    const props = renderPage()
    await user.click(await screen.findByTestId("create-field-parent"))
    await user.click(await screen.findByTestId("create-field-parent-option-i1"))
    await user.type(screen.getByTestId("create-issue-title"), "Child work")
    await user.click(screen.getByTestId("create-issue-submit"))
    await waitFor(() =>
      expect(mockCreateIssue).toHaveBeenCalledWith(expect.objectContaining({ parentId: "i1" }))
    )
    expect(props.onOpenChange).toHaveBeenCalledWith(false)
  })

  it("collects blockers as chips and submits their ids", async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByTestId("create-field-blockedby"))
    await user.click(await screen.findByTestId("create-field-blockedby-option-i2"))
    expect(screen.getByTestId("create-blockedby-chip-i2")).toHaveTextContent("DEMO-2")
    // A claimed row can't be picked again.
    await user.click(screen.getByTestId("create-field-blockedby"))
    expect(screen.getByTestId("create-field-blockedby-option-i2")).toHaveAttribute(
      "aria-disabled",
      "true"
    )
    await user.keyboard("{Escape}")
    await user.type(screen.getByTestId("create-issue-title"), "Blocked work")
    await user.click(screen.getByTestId("create-issue-submit"))
    await waitFor(() =>
      expect(mockCreateIssue).toHaveBeenCalledWith(expect.objectContaining({ blockedBy: ["i2"] }))
    )
  })

  it("removes a blocker chip before submitting", async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByTestId("create-field-blockedby"))
    await user.click(await screen.findByTestId("create-field-blockedby-option-i1"))
    await user.click(screen.getByTestId("create-blockedby-remove-i1"))
    expect(screen.queryByTestId("create-blockedby-chip-i1")).not.toBeInTheDocument()
  })

  it("hides relationships entirely without local issues", () => {
    renderPage({ issues: [] })
    expect(screen.queryByTestId("create-relationships")).not.toBeInTheDocument()
  })
})

// ── D · page: markdown toolbar, templates, AI, drafts ───────────────────────

describe("applyMarkdownFormat", () => {
  it("wraps the selection for bold", () => {
    const edit = applyMarkdownFormat("hello", 0, 5, "bold")
    expect(edit.value).toBe("**hello**")
    expect(edit.selectionStart).toBe(2)
    expect(edit.selectionEnd).toBe(7)
  })

  it("inserts empty marks when nothing is selected", () => {
    const edit = applyMarkdownFormat("", 0, 0, "code")
    expect(edit.value).toBe("``")
    expect(edit.selectionStart).toBe(1)
  })

  it("builds a link and lands the caret on the url", () => {
    const edit = applyMarkdownFormat("site", 0, 4, "link")
    expect(edit.value).toBe("[site](url)")
    expect(edit.selectionStart).toBe(7)
    expect(edit.selectionEnd).toBe(10)
  })

  it("prefixes every selected line for lists", () => {
    const edit = applyMarkdownFormat("a\nb", 0, 3, "bullet")
    expect(edit.value).toBe("- a\n- b")
  })

  it("numbers lines sequentially", () => {
    const edit = applyMarkdownFormat("a\nb\nc", 0, 5, "number")
    expect(edit.value).toBe("1. a\n2. b\n3. c")
  })

  it("does not double-prefix a line that already has a marker", () => {
    const edit = applyMarkdownFormat("- a\nb", 0, 5, "bullet")
    expect(edit.value).toBe("- a\n- b")
  })

  it("inserts a task-list item", () => {
    const edit = applyMarkdownFormat("todo", 0, 4, "task")
    expect(edit.value).toBe("- [ ] todo")
  })
})

describe("CreateIssuePage v2", () => {
  function renderPage(overrides: Partial<CreateIssuePageProps> = {}) {
    const props = baseProps({ issues: ISSUES, ...overrides })
    render(<CreateIssuePage {...props} />)
    return props
  }

  it("renders the toolbar, templates and AI controls", () => {
    renderPage()
    expect(screen.getByTestId("md-toolbar")).toBeInTheDocument()
    expect(screen.getByTestId("md-bold")).toBeInTheDocument()
    expect(screen.getByTestId("create-templates")).toBeInTheDocument()
    expect(screen.getByTestId("create-ai")).toBeInTheDocument()
  })

  it("hides the toolbar on the preview tab", async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByTestId("create-tab-preview"))
    expect(screen.queryByTestId("md-toolbar")).not.toBeInTheDocument()
    expect(screen.getByTestId("create-ai")).toBeInTheDocument()
  })

  it("applies bold formatting through the toolbar button", async () => {
    const user = userEvent.setup()
    renderPage()
    const textarea = screen.getByTestId("create-issue-description") as HTMLTextAreaElement
    await user.type(textarea, "hello")
    textarea.setSelectionRange(0, 5)
    await user.click(screen.getByTestId("md-bold"))
    expect(textarea.value).toBe("**hello**")
  })

  it("applies a template body into an empty description", async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByTestId("create-templates"))
    await user.click(await screen.findByTestId("create-template-bug"))
    expect(screen.getByTestId("create-issue-description")).toHaveValue("create.templates.bugBody")
  })

  it("appends a template after existing text", async () => {
    const user = userEvent.setup()
    renderPage()
    const textarea = screen.getByTestId("create-issue-description")
    await user.type(textarea, "My notes")
    await user.click(screen.getByTestId("create-templates"))
    await user.click(await screen.findByTestId("create-template-task"))
    expect(textarea).toHaveValue("My notes\n\ncreate.templates.taskBody")
  })

  it("AI draft fills the description from the title", async () => {
    const user = userEvent.setup()
    mockComplete.mockResolvedValue("## Summary\n\nGenerated body.")
    renderPage()
    await user.type(screen.getByTestId("create-issue-title"), "Fix login")
    await user.click(screen.getByTestId("create-ai"))
    await user.click(await screen.findByTestId("create-ai-draft"))
    await waitFor(() =>
      expect(screen.getByTestId("create-issue-description")).toHaveValue(
        "## Summary\n\nGenerated body."
      )
    )
    expect(mockComplete).toHaveBeenCalled()
  })

  it("AI draft appends to a non-empty description", async () => {
    const user = userEvent.setup()
    mockComplete.mockResolvedValue("generated")
    renderPage()
    await user.type(screen.getByTestId("create-issue-title"), "Fix login")
    await user.type(screen.getByTestId("create-issue-description"), "existing")
    await user.click(screen.getByTestId("create-ai"))
    await user.click(await screen.findByTestId("create-ai-draft"))
    await waitFor(() =>
      expect(screen.getByTestId("create-issue-description")).toHaveValue("existing\n\ngenerated")
    )
  })

  it("AI improve replaces the description", async () => {
    const user = userEvent.setup()
    mockComplete.mockResolvedValue("## Better\n\nImproved.")
    renderPage()
    await user.type(screen.getByTestId("create-issue-description"), "it broke")
    await user.click(screen.getByTestId("create-ai"))
    await user.click(await screen.findByTestId("create-ai-improve"))
    await waitFor(() =>
      expect(screen.getByTestId("create-issue-description")).toHaveValue("## Better\n\nImproved.")
    )
  })

  it("AI suggest applies priority and matching labels into the submit payload", async () => {
    const user = userEvent.setup()
    mockComplete.mockResolvedValue('{"priority":"high","labels":["Bug","nope"]}')
    renderPage()
    await user.type(screen.getByTestId("create-issue-title"), "Crash on save")
    await user.click(screen.getByTestId("create-ai"))
    await user.click(await screen.findByTestId("create-ai-suggest"))
    await waitFor(() => expect(mockComplete).toHaveBeenCalled())
    await user.keyboard("{Escape}")
    await user.click(screen.getByTestId("create-issue-submit"))
    await waitFor(() =>
      expect(mockCreateIssue).toHaveBeenCalledWith(
        expect.objectContaining({ priority: "high", labelIds: ["l1"] })
      )
    )
  })

  it("toasts when no model client resolves", async () => {
    const user = userEvent.setup()
    mockBuildUtility.mockReturnValue(null)
    renderPage()
    await user.type(screen.getByTestId("create-issue-title"), "Fix login")
    await user.click(screen.getByTestId("create-ai"))
    await user.click(await screen.findByTestId("create-ai-draft"))
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("create.ai.noModel"))
    expect(mockComplete).not.toHaveBeenCalled()
  })

  it("falls back to the headless client when no BYOK client resolves", async () => {
    const user = userEvent.setup()
    mockBuildUtility.mockReturnValue(null)
    mockBuildHeadless.mockReturnValue({ complete: (...a: unknown[]) => mockComplete(...a) })
    mockComplete.mockResolvedValue("body")
    renderPage()
    await user.type(screen.getByTestId("create-issue-title"), "Fix login")
    await user.click(screen.getByTestId("create-ai"))
    await user.click(await screen.findByTestId("create-ai-draft"))
    await waitFor(() => expect(mockComplete).toHaveBeenCalled())
  })

  it("Cmd+Enter submits the issue", async () => {
    const user = userEvent.setup()
    renderPage()
    const title = screen.getByTestId("create-issue-title")
    await user.type(title, "Quick create")
    fireEvent.keyDown(title, { key: "Enter", metaKey: true })
    await waitFor(() => expect(mockCreateIssue).toHaveBeenCalled())
  })

  it("restores a saved draft and toasts", async () => {
    localStorage.setItem(
      "issue-create-draft:v1:w1",
      JSON.stringify({ title: "Draft title", description: "Draft body", labelIds: ["l1", "gone"] })
    )
    renderPage()
    await waitFor(() => expect(screen.getByTestId("create-issue-title")).toHaveValue("Draft title"))
    expect(screen.getByTestId("create-issue-description")).toHaveValue("Draft body")
    expect(mockToastMessage).toHaveBeenCalledWith("create.draftRestored")
  })

  it("persists the draft as the user types", async () => {
    const user = userEvent.setup()
    renderPage()
    await user.type(screen.getByTestId("create-issue-title"), "Autosaved")
    await waitFor(() => {
      const raw = localStorage.getItem("issue-create-draft:v1:w1")
      expect(raw).toBeTruthy()
      expect(JSON.parse(raw as string).title).toBe("Autosaved")
    })
  })

  it("clears the draft after a successful submit", async () => {
    const user = userEvent.setup()
    renderPage()
    await user.type(screen.getByTestId("create-issue-title"), "To submit")
    await waitFor(() => expect(localStorage.getItem("issue-create-draft:v1:w1")).toBeTruthy())
    await user.click(screen.getByTestId("create-issue-submit"))
    await waitFor(() => expect(mockCreateIssue).toHaveBeenCalled())
    expect(localStorage.getItem("issue-create-draft:v1:w1")).toBeNull()
  })
})

describe("CreateIssuePage v3", () => {
  function renderPage(overrides: Partial<CreateIssuePageProps> = {}) {
    const props = baseProps({ issues: ISSUES, ...overrides })
    render(<CreateIssuePage {...props} />)
    return props
  }

  it("streams an AI draft into the description as deltas arrive", async () => {
    const user = userEvent.setup()
    mockBuildUtility.mockReturnValue({
      complete: (...a: unknown[]) => mockComplete(...a),
      stream: async function* () {
        yield "## Sum"
        yield "mary\n\nBody."
      },
    })
    renderPage()
    await user.type(screen.getByTestId("create-issue-title"), "Fix login")
    await user.click(screen.getByTestId("create-ai"))
    await user.click(await screen.findByTestId("create-ai-draft"))
    await waitFor(() =>
      expect(screen.getByTestId("create-issue-description")).toHaveValue("## Summary\n\nBody.")
    )
  })

  it("AI improve exposes an undo action restoring the previous draft", async () => {
    const user = userEvent.setup()
    mockComplete.mockResolvedValue("## Better version")
    renderPage()
    await user.type(screen.getByTestId("create-issue-description"), "original draft")
    await user.click(screen.getByTestId("create-ai"))
    await user.click(await screen.findByTestId("create-ai-improve"))
    await waitFor(() =>
      expect(screen.getByTestId("create-issue-description")).toHaveValue("## Better version")
    )
    const options = mockToastSuccess.mock.calls[0]?.[1] as
      { action?: { label: string; onClick: () => void } } | undefined
    expect(options?.action?.label).toBe("create.ai.undo")
    act(() => options?.action?.onClick())
    await waitFor(() =>
      expect(screen.getByTestId("create-issue-description")).toHaveValue("original draft")
    )
  })

  it("opens the # reference panel and inserts the identifier on click", async () => {
    const user = userEvent.setup()
    renderPage()
    const textarea = screen.getByTestId("create-issue-description")
    await user.type(textarea, "related to #DEM")
    const panel = await screen.findByTestId("issue-ref-panel")
    expect(panel).toBeInTheDocument()
    await user.click(screen.getByTestId("issue-ref-option-i1"))
    expect(textarea).toHaveValue("related to DEMO-1 ")
  })

  it("filters # references by title and inserts on Enter", async () => {
    const user = userEvent.setup()
    renderPage()
    const textarea = screen.getByTestId("create-issue-description")
    await user.type(textarea, "see #dark")
    await screen.findByTestId("issue-ref-panel")
    expect(screen.queryByTestId("issue-ref-option-i1")).not.toBeInTheDocument()
    expect(screen.getByTestId("issue-ref-option-i2")).toBeInTheDocument()
    await user.keyboard("{Enter}")
    expect(textarea).toHaveValue("see DEMO-2 ")
  })

  it("Escape dismisses the # panel without closing the sheet", async () => {
    const user = userEvent.setup()
    renderPage()
    const textarea = screen.getByTestId("create-issue-description")
    await user.type(textarea, "x #D")
    await screen.findByTestId("issue-ref-panel")
    await user.keyboard("{Escape}")
    expect(screen.queryByTestId("issue-ref-panel")).not.toBeInTheDocument()
    expect(screen.getByTestId("create-page")).toBeInTheDocument()
  })

  it("keeps the # panel closed when there are no local issues to reference", async () => {
    const user = userEvent.setup()
    renderPage({ issues: [] })
    const textarea = screen.getByTestId("create-issue-description")
    await user.type(textarea, "tag #x")
    expect(screen.queryByTestId("issue-ref-panel")).not.toBeInTheDocument()
  })

  it("shows the markdown hint under the editor", () => {
    renderPage()
    expect(screen.getByText("create.markdownHint")).toBeInTheDocument()
  })
})

describe("CreateIssuePage polish", () => {
  function renderPage(overrides: Partial<CreateIssuePageProps> = {}) {
    const props = baseProps({ issues: ISSUES, ...overrides })
    render(<CreateIssuePage {...props} />)
    return props
  }

  it("assign-to-me fills a human assignee that lands in the payload", async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByTestId("create-assign-me"))
    expect(screen.queryByTestId("create-assign-me")).not.toBeInTheDocument()
    await user.type(screen.getByTestId("create-issue-title"), "Mine")
    await user.click(screen.getByTestId("create-issue-submit"))
    await waitFor(() =>
      expect(mockCreateIssue).toHaveBeenCalledWith(
        expect.objectContaining({ assignee: expect.objectContaining({ kind: "human" }) })
      )
    )
  })

  it("due-date presets set a dueDate that lands in the payload", async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByTestId("create-field-due"))
    await user.click(await screen.findByTestId("create-due-preset-1"))
    await user.keyboard("{Escape}")
    await user.type(screen.getByTestId("create-issue-title"), "Due soon")
    await user.click(screen.getByTestId("create-issue-submit"))
    await waitFor(() =>
      expect(mockCreateIssue).toHaveBeenCalledWith(
        expect.objectContaining({ dueDate: expect.any(Number) })
      )
    )
  })

  it("estimate presets set and toggle points", async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByTestId("create-estimate-preset-5"))
    expect(screen.getByTestId("create-field-estimate")).toHaveValue(5)
    await user.click(screen.getByTestId("create-estimate-preset-5"))
    expect(screen.getByTestId("create-field-estimate")).toHaveValue(null)
  })

  it("label chips render the label color dot", async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByTestId("create-field-labels"))
    await user.click(await screen.findByTestId("create-field-label-l1"))
    await user.keyboard("{Escape}")
    const chips = screen.getByTestId("create-label-chips")
    expect(chips.querySelector("[style*='#ef4444'], [style*='rgb(239, 68, 68)']")).not.toBeNull()
  })

  it("the description editor is a bordered, focusable container", () => {
    renderPage()
    const editor = screen.getByTestId("create-description-editor")
    expect(editor.className).toContain("rounded-md")
    expect(editor.className).toContain("focus-within:border-ring")
  })
})

describe("borderless inputs", () => {
  it("the page title input paints no dark input box behind the placeholder", () => {
    render(<CreateIssuePage {...baseProps({ issues: ISSUES })} />)
    const title = screen.getByTestId("create-issue-title")
    expect(title.className).toContain("dark:bg-transparent")
    expect(title.className).toContain("rounded-none")
    expect(screen.getByTestId("create-issue-description").className).toContain(
      "dark:bg-transparent"
    )
  })
})

describe("CreateIssuePage v4 — deeper AI", () => {
  function renderPage(overrides: Partial<CreateIssuePageProps> = {}) {
    const props = baseProps({ issues: ISSUES, ...overrides })
    render(<CreateIssuePage {...props} />)
    return props
  }

  it("suggests a title from the description with an undo action", async () => {
    const user = userEvent.setup()
    mockComplete.mockResolvedValue("Fix the login redirect loop.")
    renderPage()
    await user.type(screen.getByTestId("create-issue-description"), "it loops")
    await user.click(screen.getByTestId("create-ai"))
    await user.click(await screen.findByTestId("create-ai-title"))
    await waitFor(() =>
      expect(screen.getByTestId("create-issue-title")).toHaveValue("Fix the login redirect loop")
    )
  })

  it("keeps the title action disabled until a description exists", async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByTestId("create-ai"))
    expect(await screen.findByTestId("create-ai-title")).toHaveAttribute("aria-disabled", "true")
  })

  it("applies suggested relations and surfaces duplicates as a dismissible strip", async () => {
    const user = userEvent.setup()
    mockComplete.mockResolvedValue(
      `{"parent":"${ISSUES[0].identifier}","blockedBy":["${ISSUES[1].identifier}"],"duplicates":["${ISSUES[2].identifier}"]}`
    )
    renderPage()
    await user.type(screen.getByTestId("create-issue-title"), "Same thing again")
    await user.click(screen.getByTestId("create-ai"))
    await user.click(await screen.findByTestId("create-ai-relations"))
    await waitFor(() =>
      expect(screen.getByTestId("create-field-parent")).toHaveTextContent(ISSUES[0].identifier)
    )
    expect(screen.getByTestId(`create-blockedby-chip-${ISSUES[1].sourceId}`)).toBeInTheDocument()
    const dup = screen.getByTestId("create-ai-duplicates")
    expect(dup).toHaveTextContent(ISSUES[2].identifier)
    await user.click(screen.getByTestId("create-duplicates-dismiss"))
    expect(screen.queryByTestId("create-ai-duplicates")).not.toBeInTheDocument()
    // Relations land in the submit payload.
    await user.click(screen.getByTestId("create-issue-submit"))
    await waitFor(() =>
      expect(mockCreateIssue).toHaveBeenCalledWith(
        expect.objectContaining({
          parentId: ISSUES[0].sourceId,
          blockedBy: [ISSUES[1].sourceId],
        })
      )
    )
  })

  it("disables relations when there are no local issues to link", async () => {
    const user = userEvent.setup()
    renderPage({ issues: [] })
    await user.click(screen.getByTestId("create-ai"))
    expect(await screen.findByTestId("create-ai-relations")).toHaveAttribute(
      "aria-disabled",
      "true"
    )
  })

  it("applies a suggested estimate into the payload", async () => {
    const user = userEvent.setup()
    mockComplete.mockResolvedValue('{"priority":null,"labels":[],"estimate":8}')
    renderPage()
    await user.type(screen.getByTestId("create-issue-title"), "Big refactor")
    await user.click(screen.getByTestId("create-ai"))
    await user.click(await screen.findByTestId("create-ai-suggest"))
    await waitFor(() => expect(screen.getByTestId("create-field-estimate")).toHaveValue(8))
    await user.keyboard("{Escape}")
    await user.click(screen.getByTestId("create-issue-submit"))
    await waitFor(() =>
      expect(mockCreateIssue).toHaveBeenCalledWith(expect.objectContaining({ estimate: 8 }))
    )
  })
})
