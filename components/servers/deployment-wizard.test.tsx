/** @jest-environment jsdom */

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { ProviderCapabilities } from "@/lib/server-ops/client"
import { DeploymentWizard } from "./deployment-wizard"

const capabilities: ProviderCapabilities = {
  topologies: ["compose", "kubernetes"],
  snapshotProviders: ["kubernetes-csi", "none"],
  secretProviders: ["kubernetes"],
  tlsProviders: ["ingress"],
  objectStoreProtocols: ["s3-compatible"],
  requiresProviderCredentials: false,
}

const digest = (name: string) => `ghcr.io/owner/${name}@sha256:${"a".repeat(64)}`

function renderWizard(props: Partial<React.ComponentProps<typeof DeploymentWizard>> = {}) {
  const onSubmit = jest.fn().mockResolvedValue(undefined)
  const onOpenChange = jest.fn()
  const view = render(
    <DeploymentWizard
      open
      onOpenChange={onOpenChange}
      capabilities={capabilities}
      onSubmit={onSubmit}
      {...props}
    />
  )
  return { onSubmit, onOpenChange, ...view }
}

/** Fill in every field the schema requires but the defaults leave blank. */
async function completeForm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Display label"), "Staging")
  await user.type(screen.getByLabelText("Public URL"), "https://server.example.com")
  await user.type(screen.getByLabelText("Controller URL"), "https://ops.example.com")

  await user.click(screen.getByTestId("wizard-step-identity"))
  await user.type(screen.getByLabelText("OIDC issuer"), "https://auth.example.com/oidc")
  await user.type(screen.getByLabelText("OIDC audience"), "https://server.example.com/api")

  await user.click(screen.getByTestId("wizard-step-storage"))
  await user.type(screen.getByLabelText("S3-compatible endpoint"), "https://s3.example.com")

  await user.click(screen.getByTestId("wizard-step-images"))
  await user.type(screen.getByLabelText("Server image digest"), digest("cognia-server"))
  await user.type(screen.getByLabelText("Runner image digest"), digest("cognia-runner"))
  await user.type(
    screen.getByLabelText("Workspace runtime image digest"),
    digest("cognia-workspace-runtime")
  )
}

/** The issue-count badge on a step button, or null when the step shows none. */
function stepIssueCount(step: string): string | null {
  const badge = screen.getByTestId(`wizard-step-${step}`).querySelector('[data-slot="badge"]')
  return badge?.textContent ?? null
}

it("carries the error count on the step that owns each field", async () => {
  const user = userEvent.setup()
  renderWizard()

  // An untouched step stays quiet: a form that opens covered in red trains the
  // reader to ignore it.
  expect(stepIssueCount("identity")).toBeNull()
  expect(stepIssueCount("images")).toBeNull()

  await user.click(screen.getByTestId("wizard-step-identity"))
  await user.click(screen.getByTestId("wizard-step-images"))
  await user.click(screen.getByTestId("wizard-step-review"))

  await waitFor(() => expect(stepIssueCount("identity")).toBe("2"))
  expect(stepIssueCount("images")).toBe("3")
  // The target step was visited first and its own two fields are still blank.
  expect(stepIssueCount("storage")).toBeNull()
})

it("jumps from a review issue to the field that caused it", async () => {
  const user = userEvent.setup()
  renderWizard()

  await user.click(screen.getByTestId("wizard-step-review"))
  await user.click(screen.getByRole("button", { name: "spec.images.server" }))

  // The whole point of the rebuild: a path like `spec.images.server` used to be
  // printed with no way to reach the input it named.
  expect(screen.getByLabelText("Server image digest")).toBeInTheDocument()
})

it("refuses to submit an incomplete target and lands on the first problem", async () => {
  const user = userEvent.setup()
  const { onSubmit } = renderWizard()

  await user.click(screen.getByTestId("wizard-step-review"))
  await user.click(screen.getByRole("button", { name: "Register and deploy" }))

  expect(onSubmit).not.toHaveBeenCalled()
  expect(screen.getByLabelText("Display label")).toBeInTheDocument()
})

it("submits a validated target and previews what will be deployed", async () => {
  const user = userEvent.setup()
  const { onSubmit } = renderWizard()

  await completeForm(user)
  await user.click(screen.getByTestId("wizard-step-review"))

  expect(screen.getByText("Rendered deployment")).toBeInTheDocument()
  expect(screen.getByRole("tab", { name: "kustomization.yaml" })).toBeInTheDocument()

  await user.click(screen.getByRole("button", { name: "Register and deploy" }))
  await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
  expect(onSubmit.mock.calls[0][0]).toMatchObject({
    metadata: { id: "staging", label: "Staging" },
    spec: { topology: "kubernetes" },
  })
})

it("warns about certification without blocking a valid deploy", async () => {
  const user = userEvent.setup()
  const { onSubmit } = renderWizard()

  await completeForm(user)
  // A mutable tag deploys fine and fails certification — the distinction the
  // review step has to make.
  await user.clear(screen.getByLabelText("Server image digest"))
  await user.type(
    screen.getByLabelText("Server image digest"),
    "ghcr.io/owner/cognia-server:latest"
  )

  await user.click(screen.getByTestId("wizard-step-review"))
  expect(screen.getByText("Not production certified")).toBeInTheDocument()
  expect(screen.getByText("images.server must use an immutable sha256 digest")).toBeInTheDocument()

  await user.click(screen.getByRole("button", { name: "Register and deploy" }))
  await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
})

it("swaps the platform step's fields with the topology", async () => {
  const user = userEvent.setup()
  renderWizard()

  await user.click(screen.getByTestId("wizard-step-platform"))
  expect(screen.getByLabelText("Namespace")).toBeInTheDocument()

  await user.click(screen.getByTestId("wizard-step-target"))
  await user.click(screen.getByRole("combobox", { name: "Topology" }))
  await user.click(screen.getByRole("option", { name: "Docker Compose" }))

  await user.click(screen.getByTestId("wizard-step-platform"))
  // The schema rejects a kubernetes block on a compose target outright, so the
  // fields cannot simply both be present.
  expect(screen.queryByLabelText("Namespace")).not.toBeInTheDocument()
  expect(screen.getByLabelText("Compose project name")).toBeInTheDocument()
})

it("hides the reference field for providers that take none", async () => {
  const user = userEvent.setup()
  renderWizard()

  await user.click(screen.getByTestId("wizard-step-storage"))
  expect(screen.getByLabelText("Snapshot class or adapter reference")).toBeInTheDocument()

  await user.click(screen.getByRole("combobox", { name: "Snapshot provider" }))
  await user.click(screen.getByRole("option", { name: "None" }))
  expect(screen.queryByLabelText("Snapshot class or adapter reference")).not.toBeInTheDocument()
})
