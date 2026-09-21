import { render, screen, within } from "@testing-library/react"

import { ProjectEnvironmentRuntimeTrace } from "./project-environment-runtime-trace"
import type { SandboxPlacementOutcome } from "@/lib/sandbox/environment-placement"
import type { EnvironmentCatalogView } from "@/types/sandbox/environment-catalog"
import type { EnvironmentSpec } from "@/types/sandbox/environment-spec"
import en from "@/i18n/messages/en/projectEnvironment.json"

const DIGEST = `sha256:${"a".repeat(64)}`

function spec(over: Partial<EnvironmentSpec> = {}): EnvironmentSpec {
  return {
    version: 1,
    specDigest: "b".repeat(64),
    projectId: "prj1",
    source: { kind: "deployment-default", catalogEntryId: "default" },
    image: { registry: "ghcr.io", repository: "acme/dev", digest: DIGEST },
    bundle: { digest: DIGEST, releaseTag: "v1", pinned: false },
    isolation: { minimum: "gvisor" },
    sizeClassId: "small",
    lifecycle: "persistent",
    user: {},
    containerEnv: {},
    lifecycleCommands: {},
    forwardPorts: [],
    egress: { tier: "allowlist", presetIds: [], approvedDomains: [] },
    browserSidecar: false,
    explain: {
      steps: [
        { layer: "repo-declaration", outcome: "skipped", code: "environment_approval_pending" },
        { layer: "deployment-default", outcome: "chosen", code: "deployment_default_selected" },
        { layer: "size-class", outcome: "chosen", code: "size_class_from_the_future" },
      ],
    },
    ...over,
  }
}

const catalog = {
  sizeClasses: [
    {
      id: "small",
      label: "Small box",
      cpuMillis: 1000,
      memoryMib: 1024,
      ephemeralStorageMib: 1,
      volumeMib: 1,
    },
  ],
} as unknown as EnvironmentCatalogView

function placed(over: Partial<EnvironmentSpec> = {}): SandboxPlacementOutcome {
  return {
    kind: "placed",
    placement: { kind: "container", spec: spec(over), isolationMandatory: false },
    notices: [],
  }
}

describe("ProjectEnvironmentRuntimeTrace", () => {
  it("renders nothing before there is a preview", () => {
    const { container } = render(
      <ProjectEnvironmentRuntimeTrace preview={undefined} catalog={undefined} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it("says a project that opted out runs on the standard path", () => {
    render(<ProjectEnvironmentRuntimeTrace preview={{ kind: "off" }} catalog={undefined} />)
    expect(screen.getByText(en.runtime.preview.off)).toBeInTheDocument()
  })

  it("names the pinned image, the size and the tier as a request", () => {
    render(<ProjectEnvironmentRuntimeTrace preview={placed()} catalog={catalog} />)

    expect(screen.getByText(/ghcr\.io\/acme\/dev@sha256:a{64}/)).toBeInTheDocument()
    expect(screen.getByText("Size: Small box")).toBeInTheDocument()
    expect(screen.getByText("Requested isolation: at least gVisor")).toBeInTheDocument()
    // The tier and user are what was ASKED for; the card says so.
    expect(screen.getByText(en.runtime.preview.actualNote)).toBeInTheDocument()
    expect(screen.getByText(en.runtime.preview.tierDefaultUser)).toBeInTheDocument()
  })

  it("walks the resolver's own trace, marking what it skipped", () => {
    render(<ProjectEnvironmentRuntimeTrace preview={placed()} catalog={catalog} />)
    const steps = within(screen.getByTestId("runtime-trace-steps")).getAllByRole("listitem")

    expect(steps.map((step) => step.textContent)).toEqual([
      en.runtime.trace.step.environment_approval_pending,
      en.runtime.trace.step.deployment_default_selected,
      // A newer resolver's step prints its code rather than disappearing.
      "size_class_from_the_future",
    ])
    expect(steps[0]).toHaveAttribute("data-outcome", "skipped")
  })

  it("names a declared user, and one declared only by uid", () => {
    const { rerender } = render(
      <ProjectEnvironmentRuntimeTrace
        preview={placed({ user: { declared: { name: "vscode", from: "remoteUser" } } })}
        catalog={catalog}
      />
    )
    expect(screen.getByText("Runs as the declared user vscode")).toBeInTheDocument()

    rerender(
      <ProjectEnvironmentRuntimeTrace
        preview={placed({ user: { declared: { uid: 1000, from: "image" } } })}
        catalog={catalog}
      />
    )
    expect(screen.getByText("Runs as the image's user 1000")).toBeInTheDocument()
  })

  it("explains a fallback in the person's language", () => {
    render(
      <ProjectEnvironmentRuntimeTrace
        preview={{ kind: "fallback", code: "sandbox_fallback_pool_disabled", notices: [] }}
        catalog={undefined}
      />
    )
    expect(screen.getByRole("status")).toHaveTextContent(en.outcome.fallback.poolDisabled)
  })

  it("explains a refusal as an alert, with the notices that led to it", () => {
    render(
      <ProjectEnvironmentRuntimeTrace
        preview={{
          kind: "refused",
          code: "local_container_unavailable",
          notices: [{ code: "environment_declaration_restricted" }],
        }}
        catalog={undefined}
      />
    )
    expect(screen.getByRole("alert")).toHaveTextContent(
      en.outcome.refused.localContainerUnavailable
    )
    expect(screen.getByTestId("runtime-trace-notices")).toHaveTextContent(
      en.outcome.notice.declarationRestricted
    )
  })
})

it("shows a built Docker image identity without fabricating a registry reference", () => {
  render(
    <ProjectEnvironmentRuntimeTrace
      preview={placed({ image: { kind: "build", buildKey: "b".repeat(64), imageId: DIGEST } })}
      catalog={catalog}
    />
  )
  expect(screen.getByText(new RegExp(DIGEST))).toBeInTheDocument()
  expect(screen.queryByText(/undefined/)).not.toBeInTheDocument()
})
