/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"

import enCaps from "@/i18n/messages/en/collabCapabilities.json"
import zhCaps from "@/i18n/messages/zh-CN/collabCapabilities.json"
import enWorkspace from "@/i18n/messages/en/workspace.json"
import zhWorkspace from "@/i18n/messages/zh-CN/workspace.json"
import {
  COLLAB_ACTIONS,
  COLLAB_FEATURE_KEYS,
  COLLAB_FEATURE_REASONS,
  COLLAB_FEATURE_STATES,
  parseOrgCapabilities,
} from "@/lib/collab/capabilities"

jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) =>
    `${namespace}.${key}${values ? `:${Object.values(values).join(",")}` : ""}`,
}))

let view: Record<string, unknown> = { status: "loading" }
const refresh = jest.fn()
jest.mock("@/hooks/collab/use-org-capabilities", () => ({
  useOrgCapabilities: (workspaceId: string | null) => ({ ...view, workspaceId, refresh }),
}))

import { WorkspaceAccessSummary } from "./workspace-access-summary"

function readyView() {
  return {
    status: "ready",
    capabilities: parseOrgCapabilities(
      {
        schemaVersion: 1,
        orgId: "org_a",
        workspaceId: "ws_1",
        standing: { orgRole: "admin", workspaceRole: "maintainer", via: "org-admin", guest: false },
        actions: ["workspace.read", "org.members.manage"],
        features: [
          { key: "shared-chat", state: "available", reason: null, policyRevision: 1 },
          {
            key: "shared-chat-execution",
            state: "existing-only",
            reason: "feature_paused",
            policyRevision: 3,
          },
        ],
        evaluatedAt: 1,
      },
      { orgId: "org_a", workspaceId: "ws_1" }
    ),
  }
}

beforeEach(() => {
  view = { status: "loading" }
  refresh.mockReset()
})

describe("WorkspaceAccessSummary", () => {
  it("renders nothing without a workspace or without a collaboration plane", () => {
    const { container, rerender } = render(<WorkspaceAccessSummary workspaceId={null} />)
    expect(container).toBeEmptyDOMElement()

    view = { status: "unavailable", reason: "not-configured" }
    rerender(<WorkspaceAccessSummary workspaceId="ws_1" />)
    expect(container).toBeEmptyDOMElement()
  })

  it("shows a loading state while the server is asked", () => {
    render(<WorkspaceAccessSummary workspaceId="ws_1" />)
    expect(screen.getByTestId("workspace-access-loading")).toHaveAttribute("aria-busy", "true")
  })

  it("names both roles, the org-admin route, the granted actions in contract order, and every feature", () => {
    view = readyView()
    render(<WorkspaceAccessSummary workspaceId="ws_1" />)

    expect(screen.getByTestId("workspace-access-org-role")).toHaveTextContent(
      "account.identity.roleName.admin"
    )
    expect(screen.getByTestId("workspace-access-workspace-role")).toHaveTextContent(
      "workspace.members.role.maintainer"
    )
    expect(screen.getByTestId("workspace-access-workspace-role")).toHaveTextContent(
      "workspace.access.viaOrgAdmin"
    )
    const actions = screen.getByTestId("workspace-access-actions").textContent ?? ""
    expect(actions.indexOf("org.members.manage")).toBeLessThan(actions.indexOf("workspace.read"))

    for (const key of COLLAB_FEATURE_KEYS) {
      expect(screen.getByTestId(`workspace-access-feature-${key}`)).toBeInTheDocument()
    }
    const paused = screen.getByTestId("workspace-access-feature-shared-chat-execution")
    expect(paused).toHaveAttribute("data-state", "existing-only")
    expect(paused).toHaveTextContent("collabCapabilities.reason.feature_paused")
    // An available feature carries no reason line.
    expect(screen.getByTestId("workspace-access-feature-shared-chat")).not.toHaveTextContent(
      "collabCapabilities.reason"
    )
  })

  it("says a guest is a guest when they hold no org role", () => {
    const ready = readyView()
    ready.capabilities = {
      ...ready.capabilities,
      standing: { orgRole: null, workspaceRole: "member", via: "membership", guest: true },
      actions: new Set(),
    }
    view = ready
    render(<WorkspaceAccessSummary workspaceId="ws_1" />)
    expect(screen.getByTestId("workspace-access-org-role")).toHaveTextContent(
      "workspace.access.guest"
    )
    expect(screen.getByTestId("workspace-access-no-actions")).toBeInTheDocument()
  })

  it.each([
    [{ status: "unsupported" }, "workspace-access-unsupported", "unavailable.unsupported"],
    [{ status: "hidden" }, "workspace-access-hidden", "unavailable.hidden"],
    [
      { status: "unavailable", reason: "not-signed-in" },
      "workspace-access-unavailable",
      "unavailable.not-signed-in",
    ],
    [{ status: "error", message: "boom" }, "workspace-access-error", "unavailable.error:boom"],
  ])("explains the %o state", (next, testId, key) => {
    view = next
    render(<WorkspaceAccessSummary workspaceId="ws_1" />)
    expect(screen.getByTestId(testId)).toHaveTextContent(`workspace.access.${key}`)
  })

  it("refreshes on request", () => {
    view = readyView()
    render(<WorkspaceAccessSummary workspaceId="ws_1" />)
    fireEvent.click(screen.getByTestId("workspace-access-refresh"))
    expect(refresh).toHaveBeenCalled()
  })
})

describe("collabCapabilities catalogue", () => {
  type Catalogue = {
    feature: Record<string, string>
    state: Record<string, string>
    reason: Record<string, string>
    action: Record<string, unknown>
  }
  const catalogues: Record<string, Catalogue> = {
    en: enCaps as Catalogue,
    "zh-CN": zhCaps as Catalogue,
  }

  it.each(Object.keys(catalogues))("%s labels every contract entry", (locale) => {
    const catalogue = catalogues[locale]!
    expect(COLLAB_FEATURE_KEYS.filter((key) => !catalogue.feature[key])).toEqual([])
    expect(COLLAB_FEATURE_STATES.filter((key) => !catalogue.state[key])).toEqual([])
    expect(COLLAB_FEATURE_REASONS.filter((key) => !catalogue.reason[key])).toEqual([])
    for (const action of COLLAB_ACTIONS) {
      expect(catalogue.action).toHaveProperty(action, expect.stringMatching(/\S/))
    }
  })

  it("has the same access-card keys in both locales", () => {
    const keys = (value: unknown, prefix = ""): string[] =>
      typeof value === "object" && value !== null
        ? Object.entries(value).flatMap(([key, child]) => keys(child, `${prefix}${key}.`))
        : [prefix]
    const en = (enWorkspace as { access: unknown }).access
    const zh = (zhWorkspace as { access: unknown }).access
    expect(keys(zh).sort()).toEqual(keys(en).sort())
  })
})
