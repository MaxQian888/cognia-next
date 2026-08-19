/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"

import {
  buildDeploymentTarget,
  INITIAL_DEPLOYMENT_FORM,
  type DeploymentFormState,
} from "@/lib/server-ops/deployment-form"
import { parseDeploymentTarget, type DeploymentTarget } from "@/lib/server-ops/deployment-target"
import { DeploymentPreview } from "./deployment-preview"

const digest = (name: string) => `ghcr.io/owner/${name}@sha256:${"a".repeat(64)}`

const complete: DeploymentFormState = {
  ...INITIAL_DEPLOYMENT_FORM,
  label: "Staging",
  controllerUrl: "https://ops.example.com",
  publicUrl: "https://server.example.com",
  oidcIssuer: "https://auth.example.com/oidc",
  oidcAudience: "https://server.example.com/api",
  objectStoreEndpoint: "https://s3.example.com",
  serverImage: digest("cognia-server"),
  runnerImage: digest("cognia-runner"),
  workspaceRuntimeImage: digest("cognia-workspace-runtime"),
}

const targetFor = (overrides: Partial<DeploymentFormState> = {}) =>
  parseDeploymentTarget(buildDeploymentTarget({ ...complete, ...overrides }))

it("renders the Compose environment the agent will write", () => {
  render(<DeploymentPreview target={targetFor({ topology: "compose" })} />)

  expect(screen.getByText("cognia")).toBeInTheDocument()
  expect(screen.getByText("/opt/cognia")).toBeInTheDocument()
  expect(screen.getByText(/COGNIA_SERVER_IMAGE=/)).toBeInTheDocument()
  expect(screen.getByText(/COGNIA_PUBLIC_URL=/)).toBeInTheDocument()
})

it("renders each Kubernetes manifest on its own tab", () => {
  render(<DeploymentPreview target={targetFor()} />)

  expect(screen.getByRole("tab", { name: "namespace.yaml" })).toBeInTheDocument()
  expect(screen.getByRole("tab", { name: "kustomization.yaml" })).toBeInTheDocument()
  expect(screen.getByText(/cognia-staging/)).toBeInTheDocument()
})

it("says the preview is local rather than what the agent consumes", () => {
  // The agent renders its own copy from the registered target; treating this
  // as the source of truth is exactly the misunderstanding to head off.
  render(<DeploymentPreview target={targetFor()} />)
  expect(screen.getByText(/Rendered locally for review/)).toBeInTheDocument()
})

it("surfaces the renderer's own message when a target cannot be rendered", () => {
  // A hand-edited target that passed the schema but lost its topology block —
  // the renderer names the missing piece, which a generic message would not.
  const broken = {
    ...targetFor(),
    spec: { ...targetFor().spec, kubernetes: undefined },
  } as DeploymentTarget

  render(<DeploymentPreview target={broken} />)
  expect(screen.getByText("This target cannot be rendered yet")).toBeInTheDocument()
  expect(screen.getByText(/kubernetes configuration is required/)).toBeInTheDocument()
})
