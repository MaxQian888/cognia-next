/**
 * AgentTeamTemplatesSection, built-in vs user template UX tests.
 *
 * Asserts:
 *   - Both built-in and user templates render in the same grid.
 *   - Built-in cards show the "Built-in" badge.
 *   - Edit / Delete buttons are disabled on built-ins.
 *   - Duplicate (always enabled) calls addTemplate with isBuiltIn=false.
 *   - Use routes through the template platform, so the Squad it creates gets a
 *     `TemplateInstanceRecord`, and falls back to the direct store writer only
 *     when the catalog does not hold the definition.
 *   - A user row reports its platform status and offers Publish / Export /
 *     Fork. Built-in and plugin rows do not.
 *   - Import goes through `service.inspectPackage` + `service.importPackage`.
 */

import React from "react"
import { fireEvent, render, screen, waitFor, within, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { TemplateCatalog } from "@/lib/templates/catalog"
import { createTemplateDefinition } from "@/lib/templates/contracts"
import type { TemplateRuntime } from "@/lib/templates/runtime"
import { AgentTeamTemplatesSection } from "./agent-team-templates-section"
import type { AgentTeamTemplate } from "@/types/agent/agent-team"

const builtIn: AgentTeamTemplate = {
  id: "parallel-review",
  name: "Parallel Review",
  description: "Built-in template",
  category: "review",
  teammates: [
    { name: "Reviewer A", description: "" },
    { name: "Reviewer B", description: "" },
  ],
  taskTemplates: [
    {
      title: "Review",
      description: "Review the deliverable",
      priority: "high",
      assignedToIndex: 1,
    },
  ],
  isBuiltIn: true,
}
const userTpl: AgentTeamTemplate = {
  id: "user-1",
  name: "My Custom Team",
  description: "User-created",
  category: "general",
  teammates: [{ name: "Helper", description: "" }],
  isBuiltIn: false,
}

const createTeamMock = jest.fn(() => ({ id: "team-new" }))
const addTeammateMock = jest.fn()
const createTaskMock = jest.fn()
const addTemplateMock = jest.fn()
const updateTemplateMock = jest.fn()
const deleteTemplateMock = jest.fn()

jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: (selector: (s: unknown) => unknown) =>
    selector({
      templates: { [builtIn.id]: builtIn, [userTpl.id]: userTpl },
      createTeam: createTeamMock,
      addTeammate: addTeammateMock,
      createTask: createTaskMock,
      addTemplate: addTemplateMock,
      updateTemplate: updateTemplateMock,
      deleteTemplate: deleteTemplateMock,
    }),
}))

const toastError = jest.fn()
const toastSuccess = jest.fn()
jest.mock("@/components/ui/sonner", () => ({
  toast: { error: (m: unknown) => toastError(m), success: (m: unknown) => toastSuccess(m) },
}))

// The mirror is a real module that would otherwise reach the production runtime.
jest.mock("@/lib/agent-team/publish-template-to-platform", () => ({
  platformIdForSquadTemplate: (t: { id: string }) => `legacy.agentTeam.${t.id}`,
  publishSquadTemplateToPlatform: jest.fn(async () => undefined),
}))

const routerPushMock = jest.fn()

jest.mock("next/navigation", () => ({
  useRouter: () => ({
    push: routerPushMock,
    replace: jest.fn(),
    prefetch: jest.fn(),
    back: jest.fn(),
    pathname: "/",
    query: {},
    asPath: "/",
  }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}))

jest.mock("@cognia/logging", () => ({
  loggers: {
    agent: {
      child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    },
  },
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}))

async function agentTeamDefinition(input: {
  id: string
  version: string | null
  status?: "draft" | "published"
}) {
  return createTemplateDefinition({
    id: input.id,
    domain: "agentTeam",
    status: input.status ?? (input.version ? "published" : "draft"),
    revision: 1,
    version: input.version,
    metadata: { name: input.id },
    payload: { team: { name: input.id } },
    inputs: [],
    dependencies: [],
    capabilities: [],
    compatibility: { platforms: ["desktop", "web", "mobile"] },
    provenance: { source: "user", trust: "unsigned" },
  })
}

interface StubRuntime {
  runtime: TemplateRuntime
  preflight: jest.Mock
  instantiate: jest.Mock
  publish: jest.Mock
  fork: jest.Mock
  exportPackage: jest.Mock
  inspectPackage: jest.Mock
  importPackage: jest.Mock
}

/**
 * A stub rather than the production runtime. `getTemplateRuntime()` opens
 * Dexie, and this suite is about which service calls the panel makes.
 */
function makeRuntime(
  options: {
    catalog?: TemplateCatalog
    drafts?: Record<string, { id: string; revision: number }>
    releases?: Record<string, Awaited<ReturnType<typeof agentTeamDefinition>>[]>
  } = {}
): StubRuntime {
  const drafts = options.drafts ?? {}
  const releases = options.releases ?? {}
  const preflight = jest.fn(async () => ({ status: "ready", issues: [] }))
  const instantiate = jest.fn(async () => ({
    resources: [{ domain: "agentTeam", id: "team-from-platform" }],
    rollbackToken: null,
  }))
  const publish = jest.fn(async () => ({ version: "0.1.0" }))
  const fork = jest.fn(async () => ({ id: "agentTeam.my-custom-team-copy" }))
  const exportPackage = jest.fn(async () => ({ bytes: new Uint8Array([1]) }))
  const inspectPackage = jest.fn(async () => ({
    manifest: { id: "pack", version: "1.0.0", name: "A pack" },
    fingerprint: "abc123",
    trust: "unsigned",
    definitions: [{ id: "one" }],
  }))
  const importPackage = jest.fn(async () => undefined)

  const runtime = {
    catalog: options.catalog ?? new TemplateCatalog(),
    repository: {
      getDraft: async (id: string) => drafts[id],
      listReleases: async (id: string) => releases[id] ?? [],
      listInstances: async () => [],
    } as unknown as TemplateRuntime["repository"],
    service: {
      getDerivation: async () => undefined,
      getPublishSuggestion: async () => ({
        bump: "minor" as const,
        reasons: ["Initial release"],
        currentVersion: null,
        nextVersion: "0.1.0",
      }),
      preflight,
      instantiate,
      publish,
      fork,
      exportPackage,
      inspectPackage,
      importPackage,
    } as unknown as TemplateRuntime["service"],
  } as TemplateRuntime

  return {
    runtime,
    preflight,
    instantiate,
    publish,
    fork,
    exportPackage,
    inspectPackage,
    importPackage,
  }
}

beforeEach(() => {
  createTeamMock.mockClear()
  addTeammateMock.mockClear()
  addTeammateMock.mockReturnValueOnce({ id: "mate-1" }).mockReturnValueOnce({ id: "mate-2" })
  createTaskMock.mockClear()
  addTemplateMock.mockClear()
  updateTemplateMock.mockClear()
  deleteTemplateMock.mockClear()
  routerPushMock.mockClear()
  toastError.mockClear()
  toastSuccess.mockClear()
})

describe("AgentTeamTemplatesSection", () => {
  it("renders both built-in and user templates", () => {
    render(<AgentTeamTemplatesSection runtime={makeRuntime().runtime} />)
    expect(screen.getByTestId(`agent-team-template-row-${builtIn.id}`)).toBeInTheDocument()
    expect(screen.getByTestId(`agent-team-template-row-${userTpl.id}`)).toBeInTheDocument()
  })

  it("shows the Built-in badge only on built-in rows", () => {
    render(<AgentTeamTemplatesSection runtime={makeRuntime().runtime} />)
    const builtRow = screen.getByTestId(`agent-team-template-row-${builtIn.id}`)
    expect(builtRow).toHaveAttribute("data-builtin", "true")
    expect(within(builtRow).getByText("Built-in")).toBeInTheDocument()

    const userRow = screen.getByTestId(`agent-team-template-row-${userTpl.id}`)
    expect(userRow).toHaveAttribute("data-builtin", "false")
    expect(within(userRow).queryByText("Built-in")).not.toBeInTheDocument()
  })

  it("disables Edit and Delete on built-ins, enables them on user rows", () => {
    render(<AgentTeamTemplatesSection runtime={makeRuntime().runtime} />)
    expect(screen.getByTestId(`edit-${builtIn.id}`)).toBeDisabled()
    expect(screen.getByTestId(`delete-${builtIn.id}`)).toBeDisabled()
    expect(screen.getByTestId(`edit-${userTpl.id}`)).not.toBeDisabled()
    expect(screen.getByTestId(`delete-${userTpl.id}`)).not.toBeDisabled()
  })

  it("Duplicate is always enabled and forks to a non-built-in row via addTemplate", async () => {
    const user = userEvent.setup()
    render(<AgentTeamTemplatesSection runtime={makeRuntime().runtime} />)
    const dupBtn = screen.getByTestId(`duplicate-${builtIn.id}`)
    expect(dupBtn).not.toBeDisabled()
    await act(async () => {
      await user.click(dupBtn)
    })
    expect(addTemplateMock).toHaveBeenCalledTimes(1)
    const cloned = addTemplateMock.mock.calls[0]![0] as AgentTeamTemplate
    expect(cloned.isBuiltIn).toBe(false)
    expect(cloned.id).not.toBe(builtIn.id)
    expect(cloned.name).toContain("(copy)")
  })
})

/**
 * Use used to call the store writer directly, so the Squad it made had no
 * `TemplateInstanceRecord` and therefore no lineage. "Update from template" and
 * Detach could never be offered for it.
 */
describe("AgentTeamTemplatesSection use", () => {
  it("preflights and instantiates through the platform, then routes to the new Squad", async () => {
    const catalog = new TemplateCatalog()
    catalog.replaceSource("built-in", [
      await agentTeamDefinition({ id: "builtin.agentTeam.parallel-review", version: "1.0.0" }),
    ])
    const { runtime, preflight, instantiate } = makeRuntime({ catalog })
    const user = userEvent.setup()
    render(<AgentTeamTemplatesSection runtime={runtime} />)

    await act(async () => {
      await user.click(screen.getByTestId(`use-${builtIn.id}`))
    })

    expect(preflight).toHaveBeenCalledWith(
      expect.objectContaining({
        definitionId: "builtin.agentTeam.parallel-review",
        version: "1.0.0",
      })
    )
    expect(instantiate).toHaveBeenCalled()
    // The adapter's port owns the writes, so the panel must not also call them.
    expect(createTeamMock).not.toHaveBeenCalled()
    expect(routerPushMock).toHaveBeenCalledWith("/squads?id=team-from-platform")
  })

  it("falls back to the direct writer when the catalog does not hold the definition", async () => {
    const { runtime, preflight } = makeRuntime()
    const user = userEvent.setup()
    render(<AgentTeamTemplatesSection runtime={runtime} />)

    await act(async () => {
      await user.click(screen.getByTestId(`use-${builtIn.id}`))
    })

    expect(preflight).not.toHaveBeenCalled()
    expect(createTeamMock).toHaveBeenCalledWith(expect.objectContaining({ name: builtIn.name }))
    expect(addTeammateMock).toHaveBeenCalledTimes(2)
    expect(createTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: "team-new", title: "Review", assignedTo: "mate-2" })
    )
    expect(routerPushMock).toHaveBeenCalledWith("/squads?id=team-new")
  })

  it("reports a blocked preflight instead of routing nowhere", async () => {
    const catalog = new TemplateCatalog()
    catalog.replaceSource("built-in", [
      await agentTeamDefinition({ id: "builtin.agentTeam.parallel-review", version: "1.0.0" }),
    ])
    const { runtime, preflight } = makeRuntime({ catalog })
    preflight.mockResolvedValueOnce({
      status: "blocked",
      issues: [{ code: "platform.unsupported", message: "Template is not compatible with web" }],
    })
    const user = userEvent.setup()
    render(<AgentTeamTemplatesSection runtime={runtime} />)

    await act(async () => {
      await user.click(screen.getByTestId(`use-${builtIn.id}`))
    })

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Template is not compatible with web")
    )
    expect(routerPushMock).not.toHaveBeenCalled()
  })
})

/**
 * A saved template mirrors a platform DRAFT, and a draft cannot be packaged or
 * handed to anyone. The row says which state it is in and offers the actions
 * that change it.
 */
describe("AgentTeamTemplatesSection platform actions", () => {
  it("shows draft status and offers Publish, but not Export, on a user row", async () => {
    const { runtime, publish } = makeRuntime({
      drafts: { "legacy.agentTeam.user-1": { id: "legacy.agentTeam.user-1", revision: 3 } },
    })
    const user = userEvent.setup()
    render(<AgentTeamTemplatesSection runtime={runtime} />)

    const badge = await screen.findByTestId(`platform-status-${userTpl.id}`)
    expect(badge).toHaveAttribute("data-state", "draft")
    expect(screen.getByTestId(`export-${userTpl.id}`)).toBeDisabled()

    await act(async () => {
      await user.click(screen.getByTestId(`publish-${userTpl.id}`))
    })
    await waitFor(() =>
      expect(publish).toHaveBeenCalledWith("legacy.agentTeam.user-1", {
        expectedRevision: 3,
        confirmedBump: "minor",
      })
    )
  })

  it("offers Export once a version is published", async () => {
    const release = await agentTeamDefinition({ id: "legacy.agentTeam.user-1", version: "1.0.0" })
    const { runtime, exportPackage } = makeRuntime({
      releases: { "legacy.agentTeam.user-1": [release] },
    })
    const user = userEvent.setup()
    render(<AgentTeamTemplatesSection runtime={runtime} />)

    const badge = await screen.findByTestId(`platform-status-${userTpl.id}`)
    expect(badge).toHaveAttribute("data-state", "published")
    // Publish is the action that is now unavailable, and it says so rather
    // than vanishing.
    expect(screen.getByTestId(`publish-${userTpl.id}`)).toBeDisabled()

    await act(async () => {
      await user.click(screen.getByTestId(`export-${userTpl.id}`))
    })
    const dialog = await screen.findByTestId("template-export-dialog")
    await act(async () => {
      await user.click(within(dialog).getByRole("button", { name: /export|confirm/i }))
    })
    await waitFor(() => expect(exportPackage).toHaveBeenCalled())
  })

  it("forks through the service and says where the fork went", async () => {
    const release = await agentTeamDefinition({ id: "legacy.agentTeam.user-1", version: "1.0.0" })
    const { runtime, fork } = makeRuntime({
      releases: { "legacy.agentTeam.user-1": [release] },
    })
    const user = userEvent.setup()
    render(<AgentTeamTemplatesSection runtime={runtime} />)
    await screen.findByTestId(`platform-status-${userTpl.id}`)

    await act(async () => {
      await user.click(screen.getByTestId(`fork-${userTpl.id}`))
    })
    await waitFor(() =>
      expect(fork).toHaveBeenCalledWith(
        "legacy.agentTeam.user-1",
        expect.objectContaining({ version: "1.0.0" })
      )
    )
    expect(toastSuccess).toHaveBeenCalledWith(expect.stringContaining("agentTeam.my-custom-team"))
  })

  it("offers no platform actions on a built-in row", async () => {
    const { runtime } = makeRuntime()
    render(<AgentTeamTemplatesSection runtime={runtime} />)
    await waitFor(() => expect(screen.queryByTestId(`publish-${userTpl.id}`)).toBeInTheDocument())
    expect(screen.queryByTestId(`publish-${builtIn.id}`)).not.toBeInTheDocument()
    expect(screen.queryByTestId(`export-${builtIn.id}`)).not.toBeInTheDocument()
    expect(screen.queryByTestId(`fork-${builtIn.id}`)).not.toBeInTheDocument()
    // A built-in is a per-boot overlay, so there is no release of the user's to
    // hand anyone: no share control at all, rather than a disabled one.
    expect(screen.queryByTestId(`share-${builtIn.id}`)).not.toBeInTheDocument()
  })

  it("shares the published release as a link", async () => {
    const release = await agentTeamDefinition({ id: "legacy.agentTeam.user-1", version: "1.0.0" })
    const { runtime } = makeRuntime({ releases: { "legacy.agentTeam.user-1": [release] } })
    render(<AgentTeamTemplatesSection runtime={runtime} />)

    const share = await screen.findByTestId(`share-${userTpl.id}`)
    expect(share).toHaveAttribute("data-state", "published")
    expect(within(share).getByTestId("template-share-button")).not.toBeDisabled()
    expect(within(share).queryByTestId("template-share-refusal")).not.toBeInTheDocument()
  })

  it("disables the share link on a draft-only row and says why", async () => {
    const { runtime } = makeRuntime({
      drafts: { "legacy.agentTeam.user-1": { id: "legacy.agentTeam.user-1", revision: 1 } },
    })
    render(<AgentTeamTemplatesSection runtime={runtime} />)

    const share = await screen.findByTestId(`share-${userTpl.id}`)
    expect(share).toHaveAttribute("data-state", "draft")
    const button = within(share).getByTestId("template-share-button")
    expect(button).toBeDisabled()
    // The refusal comes from the share layer itself, so a draft reads the same
    // here as it does in the Studio inspector and in Discover.
    expect(button).toHaveAttribute("data-refusal", "unpublished")
    expect(within(share).getByTestId("template-share-refusal")).toBeInTheDocument()
  })

  it("explains an absent row rather than offering a link to nothing", async () => {
    const { runtime } = makeRuntime()
    render(<AgentTeamTemplatesSection runtime={runtime} />)

    const share = await screen.findByTestId(`share-${userTpl.id}`)
    expect(share).toHaveAttribute("data-state", "absent")
    expect(within(share).getByRole("button")).toBeDisabled()
    expect(within(share).getByTestId(`share-unavailable-${userTpl.id}`)).toBeInTheDocument()
  })
})

describe("AgentTeamTemplatesSection import", () => {
  it("inspects the package, shows its trust, and imports on confirm", async () => {
    const { runtime, inspectPackage, importPackage } = makeRuntime()
    const user = userEvent.setup()
    render(<AgentTeamTemplatesSection runtime={runtime} />)

    // `fireEvent`, not `user.upload`: the input is `hidden` (the visible
    // affordance is the button that clicks it), and userEvent refuses to type
    // into an element a person could not reach.
    const input = screen.getByTestId("agent-team-template-import-input") as HTMLInputElement
    const file = new File([new Uint8Array([1, 2, 3])], "pack.cognia-template")
    // jsdom in this repo ships no `Blob.arrayBuffer`, which every browser has.
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => new Uint8Array([1, 2, 3]).buffer,
      configurable: true,
    })
    // jsdom's `files` is read-only, so it is defined on the element rather than
    // passed through `fireEvent`'s `target` shorthand.
    Object.defineProperty(input, "files", { value: [file], configurable: true })
    await act(async () => {
      fireEvent.change(input)
    })

    await waitFor(() => expect(inspectPackage).toHaveBeenCalled())
    const trust = await screen.findByTestId("agent-team-template-import-trust")
    // An unsigned package is one of the two the app cannot vouch for.
    expect(trust).toHaveAttribute("data-trust", "unsigned")

    await act(async () => {
      await user.click(screen.getByTestId("agent-team-template-import-confirm"))
    })
    await waitFor(() =>
      expect(importPackage).toHaveBeenCalledWith(expect.anything(), {
        source: "file",
        confirmed: true,
      })
    )
  })
})
