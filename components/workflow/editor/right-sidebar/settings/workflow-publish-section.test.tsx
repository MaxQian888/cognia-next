/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { useState } from "react"
import enMessages from "@/i18n/messages/en.json"
import type { WorkflowPublication } from "@/types/workflow/visual"

jest.mock("dexie-react-hooks", () => {
  const React = jest.requireActual<typeof import("react")>("react")
  const { act } =
    jest.requireActual<typeof import("@testing-library/react")>("@testing-library/react")
  return {
    useLiveQuery: <T,>(query: () => Promise<T>, dependencies: unknown[]) => {
      const [value, setValue] = React.useState<T>()
      React.useEffect(() => {
        let active = true
        void query().then((next) => {
          if (active) act(() => setValue(next))
        })
        return () => {
          active = false
        }
        // The production hook uses the caller-supplied dependency list.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, dependencies)
      return value
    },
  }
})

const publishWorkflow = jest.fn()
const unpublishWorkflow = jest.fn()
const rollbackWorkflow = jest.fn()
const getWorkflowDeployment = jest.fn()
const listWorkflowVersions = jest.fn()
jest.mock("@/lib/workflow/publish/publish-workflow", () => ({
  publishWorkflow: (...a: unknown[]) => publishWorkflow(...a),
  unpublishWorkflow: (...a: unknown[]) => unpublishWorkflow(...a),
  rollbackWorkflow: (...a: unknown[]) => rollbackWorkflow(...a),
}))
jest.mock("@/lib/db/workflow-deployments", () => ({
  getWorkflowDeployment: (...a: unknown[]) => getWorkflowDeployment(...a),
  listWorkflowVersions: (...a: unknown[]) => listWorkflowVersions(...a),
}))

import { WorkflowPublishSection } from "./workflow-publish-section"

function wrap(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

function ControlledPublishSection({
  initialPublished,
}: {
  initialPublished?: WorkflowPublication
}) {
  const [published, setPublished] = useState(initialPublished)
  return (
    <WorkflowPublishSection
      workflowId="wf1"
      published={published}
      onPublicationChange={setPublished}
    />
  )
}

beforeEach(() => {
  publishWorkflow.mockReset()
  unpublishWorkflow.mockReset()
  rollbackWorkflow.mockReset()
  getWorkflowDeployment.mockResolvedValue(undefined)
  listWorkflowVersions.mockResolvedValue([])
})

describe("WorkflowPublishSection", () => {
  it("publishes and shows the resulting tool name", async () => {
    publishWorkflow.mockResolvedValue({
      toolName: "wf_demo",
      workflowInterface: {},
      created: true,
      skillId: "s1",
    })
    wrap(<ControlledPublishSection />)
    fireEvent.click(screen.getByTestId("workflow-publish-button"))
    await waitFor(() => expect(screen.getByText("wf_demo")).toBeInTheDocument())
    expect(publishWorkflow).toHaveBeenCalledWith("wf1", expect.any(Number))
  })

  it("shows the published state up front and can unpublish", async () => {
    unpublishWorkflow.mockResolvedValue(undefined)
    wrap(<ControlledPublishSection initialPublished={{ at: 1, toolName: "wf_demo" }} />)
    expect(screen.getByText("wf_demo")).toBeInTheDocument()
    fireEvent.click(screen.getByText("Unpublish"))
    await waitFor(() => expect(unpublishWorkflow).toHaveBeenCalledWith("wf1"))
    await waitFor(() => expect(screen.getByTestId("workflow-publish-button")).toBeInTheDocument())
  })

  it("surfaces a publish error", async () => {
    publishWorkflow.mockRejectedValue(new Error("workflow not found"))
    wrap(<WorkflowPublishSection workflowId="wf1" onPublicationChange={() => undefined} />)
    fireEvent.click(screen.getByTestId("workflow-publish-button"))
    await waitFor(() => expect(screen.getByText("workflow not found")).toBeInTheDocument())
  })

  it("surfaces an unpublish error (non-Error rejection)", async () => {
    unpublishWorkflow.mockRejectedValue("boom")
    wrap(
      <WorkflowPublishSection
        workflowId="wf1"
        published={{ at: 1, toolName: "wf_demo" }}
        onPublicationChange={() => undefined}
      />
    )
    fireEvent.click(screen.getByText("Unpublish"))
    await waitFor(() => expect(screen.getByText("boom")).toBeInTheDocument())
  })

  it("re-publishes from the published state", async () => {
    publishWorkflow.mockResolvedValue({
      toolName: "wf_demo2",
      workflowInterface: {},
      created: false,
      skillId: "s1",
    })
    wrap(<ControlledPublishSection initialPublished={{ at: 1, toolName: "wf_demo" }} />)
    fireEvent.click(screen.getByText("Re-publish"))
    await waitFor(() => expect(screen.getByText("wf_demo2")).toBeInTheDocument())
  })

  it("follows publication prop changes instead of retaining stale local state", () => {
    const view = wrap(
      <WorkflowPublishSection
        workflowId="wf1"
        published={{ at: 1, toolName: "wf_demo" }}
        onPublicationChange={() => undefined}
      />
    )
    expect(screen.getByText("wf_demo")).toBeInTheDocument()

    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <WorkflowPublishSection workflowId="wf1" onPublicationChange={() => undefined} />
      </NextIntlClientProvider>
    )

    expect(screen.getByTestId("workflow-publish-button")).toBeInTheDocument()
    expect(screen.queryByText("wf_demo")).not.toBeInTheDocument()
  })

  it("shows production revision history and rolls back through the existing API", async () => {
    getWorkflowDeployment.mockResolvedValue({
      id: "deployment_1",
      workflowId: "wf1",
      versionId: "version_2",
      revision: 4,
      status: "active",
    })
    listWorkflowVersions.mockResolvedValue([
      { id: "version_1", workflowId: "wf1", sequence: 1, createdAt: 1 },
      { id: "version_2", workflowId: "wf1", sequence: 2, createdAt: 2 },
    ])
    rollbackWorkflow.mockResolvedValue({
      toolName: "wf_demo",
      workflowInterface: {},
      versionId: "version_1",
      deploymentId: "deployment_1",
      deploymentRevision: 5,
    })

    wrap(<ControlledPublishSection initialPublished={{ at: 1, toolName: "wf_demo" }} />)
    expect(await screen.findByTestId("deployment-summary")).toHaveTextContent(
      "Production v2 · revision 4 · active"
    )
    fireEvent.click(screen.getByText("Roll back"))
    await waitFor(() =>
      expect(rollbackWorkflow).toHaveBeenCalledWith("wf1", "version_1", expect.any(Number))
    )
  })
})
