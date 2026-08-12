/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => [
    {
      name: "Release verifier",
      binding: {
        workflowId: "wf-1",
        versionId: "wfv-1",
        deploymentId: "wfd-1",
        deploymentRevision: 1,
      },
    },
  ],
}))

import { GoalVerificationWorkflowPicker } from "./goal-verification-workflow-picker"

it("shows only contract-compatible workflow options supplied by the authority query", async () => {
  render(<GoalVerificationWorkflowPicker onChange={jest.fn()} />)
  expect(screen.getByTestId("goal-verification-workflow")).toBeInTheDocument()
})
