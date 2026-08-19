import { render, screen } from "@testing-library/react"

import type {
  SiteDeploymentStatus,
  SiteLifecycle,
  SiteOperationEventType,
  SiteOperationStatus,
  SiteResourceKind,
  SiteResourceOwnership,
  SiteResourceStatus,
  SiteVersionStatus,
} from "@/types/sites"
import {
  SITE_DEPLOYMENT_FACE,
  SITE_EVENT_TONE,
  SITE_LIFECYCLE_FACE,
  SITE_OWNERSHIP_CHIP,
  SITE_OWNERSHIP_STRIPE,
  SITE_RESOURCE_FACE,
  SITE_RESOURCE_KIND_ICON,
  SITE_OPERATION_FACE,
  SITE_TONE_PILL,
  SITE_VERSION_FACE,
  SiteOwnershipChip,
  SiteStatusDot,
  SiteStatusPill,
} from "./site-status"

const LIFECYCLES: SiteLifecycle[] = ["active", "taken-down", "deleting", "deleted"]
const VERSION_STATUSES: SiteVersionStatus[] = ["building", "ready", "failed"]
const DEPLOYMENT_STATUSES: SiteDeploymentStatus[] = [
  "pending",
  "deploying",
  "active",
  "failed",
  "superseded",
  "taken-down",
]
const OPERATION_STATUSES: SiteOperationStatus[] = [
  "queued",
  "running",
  "waiting-reconcile",
  "succeeded",
  "failed",
  "cancelled",
]
const EVENT_TYPES: SiteOperationEventType[] = [
  "queued",
  "claimed",
  "waiting-reconcile",
  "succeeded",
  "failed",
  "cancelled",
]
const RESOURCE_STATUSES: SiteResourceStatus[] = ["active", "deleting", "deleted", "orphaned"]
const OWNERSHIPS: SiteResourceOwnership[] = ["managed", "adopted", "shared"]
const RESOURCE_KINDS: SiteResourceKind[] = [
  "worker",
  "worker-version",
  "d1-database",
  "r2-bucket",
  "custom-domain",
  "access-application",
  "access-policy",
  "secret",
]

it("covers every member of every status union", () => {
  for (const value of LIFECYCLES) expect(SITE_LIFECYCLE_FACE[value]).toBeDefined()
  for (const value of VERSION_STATUSES) expect(SITE_VERSION_FACE[value]).toBeDefined()
  for (const value of DEPLOYMENT_STATUSES) expect(SITE_DEPLOYMENT_FACE[value]).toBeDefined()
  for (const value of OPERATION_STATUSES) expect(SITE_OPERATION_FACE[value]).toBeDefined()
  for (const value of EVENT_TYPES) expect(SITE_EVENT_TONE[value]).toBeDefined()
  for (const value of RESOURCE_STATUSES) expect(SITE_RESOURCE_FACE[value]).toBeDefined()
  for (const value of OWNERSHIPS) {
    expect(SITE_OWNERSHIP_STRIPE[value]).toBeDefined()
    expect(SITE_OWNERSHIP_CHIP[value]).toBeDefined()
  }
  for (const value of RESOURCE_KINDS) expect(SITE_RESOURCE_KIND_ICON[value]).toBeDefined()
})

it("reserves the failure colour for failures only", () => {
  const failing = [
    SITE_LIFECYCLE_FACE.deleting.tone,
    SITE_VERSION_FACE.failed.tone,
    SITE_DEPLOYMENT_FACE.failed.tone,
    SITE_OPERATION_FACE.failed.tone,
  ]
  expect(failing.every((tone) => tone === "danger")).toBe(true)
  // Ownership is purge *scope*, not an error, so it must not borrow danger.
  expect(Object.values(SITE_OWNERSHIP_CHIP).some((value) => value.includes("destructive"))).toBe(
    false
  )
  expect(Object.values(SITE_OWNERSHIP_STRIPE).some((value) => value.includes("destructive"))).toBe(
    false
  )
})

it("keeps the running spinner alive under reduced motion", () => {
  render(<SiteStatusPill face={SITE_OPERATION_FACE.running} label="Running" testId="pill" />)
  const icon = screen.getByTestId("pill").querySelector("svg")
  // Bare `animate-spin` is exempted by the reduced-motion tier; a
  // `motion-safe:` prefix would freeze the only progress signal.
  expect(icon).toHaveClass("animate-spin")
  expect(icon?.className.toString()).not.toContain("motion-safe:animate-spin")
})

it("tints by default and fills only when explicitly told to", () => {
  const { rerender } = render(
    <SiteStatusPill face={SITE_DEPLOYMENT_FACE.active} label="Active" testId="pill" />
  )
  expect(screen.getByTestId("pill")).toHaveClass(...SITE_TONE_PILL.success.split(" "))

  rerender(<SiteStatusPill face={SITE_DEPLOYMENT_FACE.active} label="Active" solid testId="pill" />)
  expect(screen.getByTestId("pill")).not.toHaveClass(...SITE_TONE_PILL.success.split(" "))
})

it("labels the ownership chip with its purge consequence", () => {
  render(<SiteOwnershipChip ownership="managed" label="Managed · purge deletes it" />)
  const chip = screen.getByText("Managed · purge deletes it")
  expect(chip).toHaveAttribute("data-ownership", "managed")
})

it("pulses the rail dot only while something is in flight", () => {
  const { rerender, container } = render(<SiteStatusDot tone="info" live />)
  expect(container.firstChild).toHaveClass("animate-pulse")

  rerender(<SiteStatusDot tone="success" />)
  expect(container.firstChild).not.toHaveClass("animate-pulse")
  expect(container.firstChild).toHaveAttribute("data-tone", "success")
})
