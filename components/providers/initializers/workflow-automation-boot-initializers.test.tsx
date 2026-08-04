import { render } from "@testing-library/react"

jest.mock("./code-adoption-tracker-initializer", () => ({
  CodeAdoptionTrackerInitializer: () => <span data-boot="code-adoption" />,
}))
jest.mock("./background-task-initializer", () => ({
  BackgroundTaskInitializer: () => <span data-boot="background" />,
}))
jest.mock("./automation-policy-initializer", () => ({
  AutomationPolicyInitializer: () => <span data-boot="automation-policy" />,
}))
jest.mock("./auto-mode-initializer", () => ({
  AutoModeInitializer: () => <span data-boot="auto-mode" />,
}))
jest.mock("./a2ui-surface-persistence-initializer", () => ({
  A2UISurfacePersistenceInitializer: () => <span data-boot="a2ui" />,
}))
jest.mock("@/components/scheduler/scheduler-initializer", () => ({
  SchedulerInitializer: () => <span data-boot="scheduler" />,
}))
jest.mock("@/components/providers/workflow-runtime-provider", () => ({
  WorkflowRuntimeProvider: () => <span data-boot="workflow" />,
}))
const mockMarkReady = jest.fn()
jest.mock("@/lib/boot/capabilities", () => ({
  markBootCapabilityReady: (...args: unknown[]) => mockMarkReady(...args),
}))

import { WorkflowAutomationBootInitializers } from "./workflow-automation-boot-initializers"

it("mounts workflow automation in deterministic order and reports readiness", () => {
  const { container } = render(<WorkflowAutomationBootInitializers />)
  expect(
    Array.from(container.querySelectorAll("[data-boot]")).map((node) =>
      node.getAttribute("data-boot")
    )
  ).toEqual([
    "background",
    "automation-policy",
    "auto-mode",
    "code-adoption",
    "a2ui",
    "scheduler",
    "workflow",
  ])
  expect(mockMarkReady).toHaveBeenCalledWith("workflow-automation")
})
