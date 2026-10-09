/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"

const mockOptions = {
  options: [
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
  failed: false,
}
// Where the catalog comes from (this host, or the paired desktop) is the
// hook's business and has its own suite.
jest.mock("@/hooks/goal/use-goal-verifier-options", () => ({
  useGoalVerifierOptions: () => mockOptions,
}))

import { GoalVerificationWorkflowPicker } from "./goal-verification-workflow-picker"

beforeEach(() => {
  mockOptions.failed = false
})

it("shows only contract-compatible workflow options supplied by the authority query", async () => {
  render(<GoalVerificationWorkflowPicker onChange={jest.fn()} />)
  expect(screen.getByTestId("goal-verification-workflow")).toBeInTheDocument()
  expect(screen.queryByTestId("goal-verification-options-failed")).toBeNull()
})

it("says when the desktop's verifier catalog could not be read", () => {
  mockOptions.failed = true
  render(<GoalVerificationWorkflowPicker onChange={jest.fn()} />)
  expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load the desktop's verifiers.")
})

it("stays disabled when the form is read-only", () => {
  render(<GoalVerificationWorkflowPicker onChange={jest.fn()} disabled />)
  expect(screen.getByTestId("goal-verification-workflow")).toBeDisabled()
})
