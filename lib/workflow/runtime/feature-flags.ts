/**
 * Emergency rollback for the immutable workflow deployment control plane.
 * Defaults on; Desktop and Headless read the same build/runtime environment.
 */
export function isWorkflowDeploymentControlPlaneEnabled(
  value = process.env.NEXT_PUBLIC_WORKFLOW_VERSIONED_DEPLOYMENTS
): boolean {
  return value !== "0" && value !== "false"
}
