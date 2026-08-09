import { isWorkflowDeploymentControlPlaneEnabled } from "./feature-flags"

describe("workflow deployment control-plane flag", () => {
  it("defaults on and supports an explicit legacy rollback", () => {
    expect(isWorkflowDeploymentControlPlaneEnabled(undefined)).toBe(true)
    expect(isWorkflowDeploymentControlPlaneEnabled("1")).toBe(true)
    expect(isWorkflowDeploymentControlPlaneEnabled("true")).toBe(true)
    expect(isWorkflowDeploymentControlPlaneEnabled("0")).toBe(false)
    expect(isWorkflowDeploymentControlPlaneEnabled("false")).toBe(false)
  })
})
