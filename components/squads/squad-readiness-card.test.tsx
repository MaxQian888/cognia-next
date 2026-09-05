/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string, values?: Record<string, unknown>) =>
    values ? `${ns}.${key}:${JSON.stringify(values)}` : `${ns}.${key}`,
}))
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

let readiness: {
  ready: boolean
  loading: boolean
  blockers: Array<{ code: string; action?: string; detail?: Record<string, unknown> }>
  evaluatedAt: number
} = { ready: true, loading: false, blockers: [], evaluatedAt: 1 }
jest.mock("@/hooks/squads/use-squad-readiness", () => ({
  useSquadReadiness: () => readiness,
}))

let environments: Array<{ id: string; name: string; isEnabled: boolean; policy?: unknown }> = []
const listProjectEnvironments = jest.fn(async () => environments)
const listProjectEnvironmentVersions = jest.fn(async (_id: string) => [] as unknown[])
const createProjectEnvironmentVersion = jest.fn(async (env: { id: string }) => ({
  id: `${env.id}:v1`,
  environmentId: env.id,
  name: "Default",
}))
const putProjectEnvironment = jest.fn(async () => undefined)
jest.mock("@/lib/db/project-environments", () => ({
  listProjectEnvironments: (...a: unknown[]) => listProjectEnvironments(...(a as [])),
  listProjectEnvironmentVersions: (id: string) => listProjectEnvironmentVersions(id),
  createProjectEnvironmentVersion: (...a: unknown[]) =>
    createProjectEnvironmentVersion(...(a as [{ id: string }])),
  putProjectEnvironment: (...a: unknown[]) => putProjectEnvironment(...(a as [])),
}))
jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: (query: () => Promise<unknown>, deps: unknown[], initial: unknown) => {
    const React = jest.requireActual("react") as typeof import("react")
    const [value, setValue] = React.useState<unknown>(initial)
    React.useEffect(() => {
      let live = true
      void Promise.resolve(query()).then((next) => {
        if (live) setValue(next)
      })
      return () => {
        live = false
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps)
    return value
  },
}))

import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { useProjectStore } from "@/stores/project/project-store"
import type { AgentTeam } from "@/types/agent/agent-team"
import { SquadReadinessCard } from "./squad-readiness-card"

const team = {
  id: "t1",
  projectId: "ws-1",
  name: "T",
  description: "",
  task: "",
  status: "idle",
  config: {},
  leadId: "lead",
  teammateIds: ["lead"],
  taskIds: [],
  messageIds: [],
  progress: 0,
  totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  createdAt: new Date(),
} as unknown as AgentTeam

beforeEach(() => {
  useAgentTeamStore.getState().reset()
  useAgentTeamStore.getState().upsertTeam(team)
  useProjectStore.setState({
    activeProjectId: "ws-1",
    projects: [{ id: "ws-1", name: "Work", rootDir: "/repo" }],
  } as never)
  environments = []
  jest.clearAllMocks()
})

describe("SquadReadinessCard", () => {
  it("says a ready Squad is ready and names its bindings", async () => {
    readiness = { ready: true, loading: false, blockers: [], evaluatedAt: 1 }
    useAgentTeamStore.getState().updateTeam("t1", {
      config: {
        repositories: [{ id: "primary", role: "primary", path: "/repo", writable: true }],
        environmentRef: { environmentId: "env-1", versionId: "env-1:v1" },
      } as never,
    })
    listProjectEnvironmentVersions.mockResolvedValueOnce([{ id: "env-1:v1", name: "Dev" }])
    render(<SquadReadinessCard squadId="t1" />)
    expect(screen.getByTestId("squad-readiness")).toHaveAttribute("data-ready", "true")
    expect(screen.getByTestId("squad-readiness-ready")).toBeInTheDocument()
    expect(screen.getByText(/bound.repository:.*\/repo/)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText(/bound.environment:.*Dev/)).toBeInTheDocument())
  })

  it("renders every blocker through i18n with its detail, never raw codes as copy", () => {
    readiness = {
      ready: false,
      loading: false,
      blockers: [
        { code: "no_teammates", action: "add_teammate" },
        {
          code: "environment_unenforceable",
          action: "configure_environment",
          detail: { missingCapabilities: ["sandbox", "network_policy"] },
        },
        { code: "host_unavailable", action: "open_on_host" },
      ],
      evaluatedAt: 1,
    }
    render(<SquadReadinessCard squadId="t1" />)
    expect(screen.getByTestId("squad-readiness")).toHaveAttribute("data-ready", "false")
    expect(screen.getByTestId("squad-readiness-blocked")).toHaveTextContent('"count":3')
    expect(screen.getByText(/blockers.no_teammates/)).toBeInTheDocument()
    expect(
      screen.getByText(/blockers.environment_unenforceable:.*sandbox, network_policy/)
    ).toBeInTheDocument()
    expect(screen.getByTestId("squad-readiness-add-teammate")).toHaveAttribute(
      "href",
      expect.stringContaining("section=squads")
    )
    expect(screen.getByTestId("squad-readiness-open-on-host")).toBeInTheDocument()
  })

  it("binds the active workspace root as the primary repository in one click", () => {
    readiness = {
      ready: false,
      loading: false,
      blockers: [{ code: "missing_primary_repository", action: "configure_repository" }],
      evaluatedAt: 1,
    }
    render(<SquadReadinessCard squadId="t1" />)
    fireEvent.click(screen.getByTestId("squad-readiness-bind-repository"))
    expect(useAgentTeamStore.getState().teams.t1?.config.repositories).toEqual([
      { id: "primary", role: "primary", path: "/repo", writable: true },
    ])
  })

  it("binds an existing environment's latest version", async () => {
    readiness = {
      ready: false,
      loading: false,
      blockers: [{ code: "missing_environment_ref", action: "configure_environment" }],
      evaluatedAt: 1,
    }
    environments = [{ id: "env-1", name: "Dev", isEnabled: true }]
    listProjectEnvironmentVersions.mockResolvedValue([{ id: "env-1:v3", name: "Dev" }])
    render(<SquadReadinessCard squadId="t1" />)
    await waitFor(() => screen.getByTestId("squad-readiness-bind-environment"))
    fireEvent.click(screen.getByTestId("squad-readiness-bind-environment"))
    await waitFor(() =>
      expect(useAgentTeamStore.getState().teams.t1?.config.environmentRef).toEqual({
        environmentId: "env-1",
        versionId: "env-1:v3",
      })
    )
    expect(createProjectEnvironmentVersion).not.toHaveBeenCalled()
  })

  it("creates a default environment when the workspace has none, then binds it", async () => {
    readiness = {
      ready: false,
      loading: false,
      blockers: [{ code: "missing_environment_ref", action: "configure_environment" }],
      evaluatedAt: 1,
    }
    render(<SquadReadinessCard squadId="t1" />)
    fireEvent.click(screen.getByTestId("squad-readiness-create-environment"))
    await waitFor(() => expect(putProjectEnvironment).toHaveBeenCalledTimes(1))
    const created = (putProjectEnvironment.mock.calls as unknown[][])[0]![0] as {
      projectId: string
      policy: { requiredRuntimeCapabilities: string[] }
    }
    expect(created.projectId).toBe("ws-1")
    expect(created.policy).toEqual({ requiredRuntimeCapabilities: [] })
    await waitFor(() =>
      expect(useAgentTeamStore.getState().teams.t1?.config.environmentRef?.environmentId).toMatch(
        /^env_/
      )
    )
    expect(screen.getByTestId("squad-readiness-open-environments")).toHaveAttribute(
      "href",
      "/workspace?tab=environments"
    )
  })

  it("renders nothing for an unknown Squad", () => {
    const { container } = render(<SquadReadinessCard squadId="nope" />)
    expect(container).toBeEmptyDOMElement()
  })
})
