/** @jest-environment jsdom */
jest.mock("@tauri-apps/plugin-dialog", () => ({ open: jest.fn(async () => null) }))
jest.mock("@/lib/native/utils", () => ({ canUseTauriInvoke: () => true }))

const mockProgress = jest.fn(() => null as unknown)
jest.mock("dexie-react-hooks", () => ({
  // The live query is a thin Dexie subscription; the component's job is to
  // render whatever progress it yields, so the hook itself is stubbed.
  useLiveQuery: () => mockProgress(),
}))

import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import { CreatorWorkbench } from "./creator-workbench"
import creatorMessages from "@/i18n/messages/en/creator.json"
import { CREATOR_RUN_ID_PREFIX } from "@/lib/creator/run-log"
import { useCreatorStore } from "@/stores/creator/creator-store"

function renderWorkbench(props: React.ComponentProps<typeof CreatorWorkbench> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ creator: creatorMessages }}>
      <CreatorWorkbench {...props} />
    </NextIntlClientProvider>
  )
}

function grantRoot() {
  useCreatorStore.setState({
    authoringRoot: {
      path: "/work/authoring",
      label: "authoring",
      origin: "selected",
      grantedAt: 0,
    },
  })
}

beforeEach(() => {
  mockProgress.mockReturnValue(null)
  useCreatorStore.setState({
    authoringRoot: null,
    activeRunId: null,
    artifactKind: "plugin",
    approvedAdditions: [],
  })
})

const startButton = () => screen.getByRole("button", { name: creatorMessages.run.start })

describe("CreatorWorkbench", () => {
  it("refuses to start a run without an authoring root", () => {
    renderWorkbench()
    expect(startButton()).toBeDisabled()
    expect(screen.getByText(creatorMessages.run.needsRoot)).toBeInTheDocument()
  })

  it("starts a run once a root is granted", () => {
    grantRoot()
    renderWorkbench()
    fireEvent.click(startButton())
    expect(useCreatorStore.getState().activeRunId).toMatch(new RegExp(`^${CREATOR_RUN_ID_PREFIX}`))
  })

  it("renders the nine-step rail", () => {
    renderWorkbench()
    expect(screen.getAllByRole("listitem")).toHaveLength(9)
  })

  it("states that writes are blocked before the permission gate passes", () => {
    renderWorkbench()
    expect(screen.getAllByText(creatorMessages.permissions.writesBlocked).length).toBeGreaterThan(0)
  })

  // The property the component exists to preserve: the durable log decides
  // whether writes are unlocked, not local React state.
  it("stops warning about blocked writes once the log says the gate passed", () => {
    mockProgress.mockReturnValue({
      completed: ["approve-permissions"],
      failed: [],
      approvals: ["permission-widening"],
    })
    renderWorkbench({ currentCapabilities: [], proposedCapabilities: [] })
    expect(screen.queryByText(creatorMessages.permissions.writesBlocked)).not.toBeInTheDocument()
  })

  it("derives the permission diff from the supplied capabilities", () => {
    renderWorkbench({
      currentCapabilities: ["fs.read"],
      proposedCapabilities: ["fs.read", "fs.write"],
    })
    expect(screen.getByText("fs.write")).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: creatorMessages.permissions.approve })
    ).toBeInTheDocument()
  })

  it("records an approval against the store", () => {
    grantRoot()
    renderWorkbench({ currentCapabilities: [], proposedCapabilities: ["fs.write"] })
    fireEvent.click(startButton())
    fireEvent.click(screen.getByRole("button", { name: creatorMessages.permissions.approve }))
    expect(useCreatorStore.getState().approvedAdditions).toEqual(["fs.write"])
  })

  it("blocks approval until a run is active", () => {
    grantRoot()
    renderWorkbench({ currentCapabilities: [], proposedCapabilities: ["fs.write"] })
    expect(screen.getByRole("button", { name: creatorMessages.permissions.approve })).toBeDisabled()
  })

  it("shows the active run and lets the user end it", () => {
    grantRoot()
    useCreatorStore.setState({ activeRunId: "creator_x" })
    renderWorkbench()
    expect(screen.getByText(/creator_x/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: creatorMessages.run.end }))
    expect(useCreatorStore.getState().activeRunId).toBeNull()
  })

  it("renders the reviewer verdict when one exists", () => {
    renderWorkbench({
      verdict: { approved: true, findings: [], reviewerAuthority: "plan" },
    })
    expect(screen.getByRole("status")).toHaveTextContent(creatorMessages.review.approved)
  })

  it("shows the authoring root card", () => {
    renderWorkbench()
    expect(screen.getByText(creatorMessages.root.title)).toBeInTheDocument()
  })
})
