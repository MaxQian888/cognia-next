import { render, screen, fireEvent } from "@testing-library/react"

const record = jest.fn()
function body(name: string) {
  return function Body(props: Record<string, unknown>) {
    record(name, props)
    return (
      <button
        data-testid={name}
        onClick={() => (props.onSelect as ((id: string) => void) | undefined)?.("bot-2")}
      />
    )
  }
}

jest.mock("@/hooks/ui/use-compact-layout", () => ({
  useCompactLayout: () => {
    throw new Error("Mobile build must not select a desktop body by viewport")
  },
}))
jest.mock("@/hooks/ui/use-mobile", () => ({
  useIsMobile: () => {
    throw new Error("Mobile build must not select a desktop body by viewport")
  },
}))
jest.mock("@/components/mobile/bots/bots-mobile-body", () => ({ BotsMobileBody: body("bots") }))
jest.mock("@/components/mobile/issues/issues-mobile-body", () => ({
  IssuesMobileBody: body("issues"),
}))
jest.mock("@/components/mobile/issues/cycles-mobile-body", () => ({
  CyclesMobileBody: body("cycles"),
}))
jest.mock("@/components/mobile/issues/projects-mobile-body", () => ({
  ProjectsMobileBody: body("projects"),
}))
jest.mock("@/components/mobile/memory/memory-mobile-body", () => ({
  MemoryMobileBody: body("memory"),
}))
jest.mock("@/components/mobile/source-control/source-control-mobile-body", () => ({
  SourceControlMobileBody: body("git"),
}))
jest.mock("@/components/mobile/squads/squads-mobile-body", () => ({
  SquadsMobileBody: body("squads"),
}))
jest.mock("@/components/mobile/workflow/editor/mobile-workflow-editor", () => ({
  MobileWorkflowEditor: body("editor"),
}))
jest.mock("@/components/mobile/workflow/mobile-runs-list", () => ({ MobileRunsList: body("runs") }))
jest.mock("@/components/mobile/servers/server-detail-mobile-body", () => ({
  ServerDetailMobileBody: body("server"),
}))
jest.mock("@/components/mobile/inbox/mobile-inbox-body", () => ({
  MobileInboxBody: body("inbox"),
}))

import Bots from "@/app/bots/route-body.mobile"
import Issues from "@/app/issues/route-body.mobile"
import Projects from "@/app/projects/route-body.mobile"
import Memory from "@/app/memory/route-body.mobile"
import Git from "@/app/source-control/route-body.mobile"
import Squads from "@/app/squads/route-body.mobile"
import Editor from "@/app/workflows/editor/route-body.mobile"
import Runs from "@/app/workflows/runs/route-body.mobile"
import Server from "@/app/servers/detail/route-body.mobile"
import AllInbox from "@/app/inbox/all/route-body.mobile"
import DraftsInbox from "@/app/inbox/drafts/route-body.mobile"
import type { RouteBodyProps as SquadProps } from "@/app/squads/route-body"
import type { RouteBodyProps as EditorProps } from "@/app/workflows/editor/route-body"
import type { RouteBodyProps as ServerProps } from "@/app/servers/detail/route-body"

beforeEach(() => record.mockClear())

it.each([
  ["messages", AllInbox],
  ["drafts", DraftsInbox],
] as const)("opens the %s inbox tab", (initialTab, Inbox) => {
  render(<Inbox />)
  expect(record).toHaveBeenCalledWith("inbox", { initialTab })
})

it("preserves bot selection callbacks and the installation deep link", () => {
  const onSelect = jest.fn()
  const onDeselect = jest.fn()
  render(<Bots selectedId="bot-1" installParam="1" onSelect={onSelect} onDeselect={onDeselect} />)
  expect(record).toHaveBeenCalledWith(
    "bots",
    expect.objectContaining({ selectedId: "bot-1", installParam: "1", onDeselect })
  )
  fireEvent.click(screen.getByTestId("bots"))
  expect(onSelect).toHaveBeenCalledWith("bot-2")
})

it("preserves issue selection and the project cycles tab", () => {
  render(<Issues initialSelectedId="issue-1" />)
  expect(record).toHaveBeenCalledWith("issues", { initialSelectedId: "issue-1" })
  const view = render(<Projects tab="projects" initialSelectedId="project-1" />)
  expect(record).toHaveBeenCalledWith("projects", { initialSelectedId: "project-1" })
  view.rerender(<Projects tab="cycles" initialSelectedId="project-1" />)
  expect(screen.getByTestId("cycles")).toBeInTheDocument()
  expect(screen.queryByTestId("projects")).not.toBeInTheDocument()
})

it("maps the memory workspace filter and preserves a deep-linked git drawer", () => {
  render(<Memory initialSelectedId="memory-1" initialProjectId="workspace-1" />)
  expect(record).toHaveBeenCalledWith("memory", {
    initialSelectedId: "memory-1",
    projectId: "workspace-1",
  })
  render(<Git initialDiffOpen />)
  expect(record).toHaveBeenCalledWith("git", { initialDiffOpen: true })
})

it("forwards the same squad route and workflow instances without copying controller state", () => {
  const route = { selectedId: "squad-1" } as SquadProps["route"]
  const workflow = { id: "workflow-1" } as EditorProps["workflow"]
  render(<Squads route={route} />)
  render(<Editor workflow={workflow} initialTemplateId="template-1" />)
  render(<Runs workflowId="workflow-1" />)
  expect(record).toHaveBeenCalledWith("squads", { route })
  expect(record.mock.calls.find(([name]) => name === "editor")?.[1].workflow).toBe(workflow)
  expect(record).toHaveBeenCalledWith("runs", { workflowId: "workflow-1" })
})

it("preserves every server action supplied by the shared route controller", () => {
  const actions = {
    onBackup: jest.fn(),
    onRollback: jest.fn(),
    onRestore: jest.fn(),
  } as unknown as ServerProps["actions"]
  const server = { id: "server-1" } as ServerProps["server"]
  const props = {
    server,
    actions,
    backups: [],
    logs: [],
    loadingDetail: false,
    backToFleet: null,
    controllerUrl: "https://controller.test",
    enrollOpen: false,
    setEnrollOpen: jest.fn(),
    inspected: null,
    setInspected: jest.fn(),
  }
  render(<Server {...props} />)
  const actual = record.mock.calls.find(([name]) => name === "server")?.[1]
  expect(actual.actions).toBe(actions)
  expect(actual.server).toBe(server)
})
