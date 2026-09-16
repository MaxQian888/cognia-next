import { fireEvent, render, screen, within } from "@testing-library/react"

import { ProjectEnvironmentRuntimeDeclaration } from "./project-environment-runtime-declaration"
import type { ApprovalRecord } from "@/lib/project-environment/environment-client"
import type { EnvironmentDeclarationVerdict } from "@/lib/project-environment/read-environment-declaration"
import { parseDevcontainer } from "@/lib/project-environment/devcontainer"
import en from "@/i18n/messages/en/projectEnvironment.json"

const DIGEST = "d".repeat(64)

function declared(): EnvironmentDeclarationVerdict {
  const parsed = parseDevcontainer(
    JSON.stringify({
      image: "python:3.12-slim",
      containerEnv: { PIP_INDEX_URL: "https://mirror.example/simple" },
      forwardPorts: [8000],
      postCreateCommand: "pip install -e .",
      remoteUser: "vscode",
    }),
    ".devcontainer.json"
  )
  if (!parsed.ok) throw new Error("fixture does not parse")
  return { kind: "declared", declaration: parsed.declaration, digest: DIGEST, notices: [] }
}

function approval(over: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    id: "apr1",
    projectId: "prj1",
    normalizedRemote: "github.com/acme/app",
    path: ".devcontainer.json",
    declarationDigest: DIGEST,
    resolvedImage: {
      registry: "docker.io",
      repository: "library/python",
      digest: `sha256:${"a".repeat(64)}`,
    },
    runtimeFieldsDigest: "r".repeat(64),
    approverUserId: "usr_alice",
    via: "workspaceMaintainer",
    approvedAt: 1,
    ...over,
  }
}

function renderCard(
  over: Partial<Parameters<typeof ProjectEnvironmentRuntimeDeclaration>[0]> = {}
) {
  const props = {
    files: { files: [], searched: [".cognia/workspace.json", ".devcontainer.json"] },
    declaration: { kind: "absent" } as EnvironmentDeclarationVerdict,
    approvals: [],
    canApprove: true,
    busy: false,
    onApprove: jest.fn(),
    onRevoke: jest.fn(),
    ...over,
  }
  render(<ProjectEnvironmentRuntimeDeclaration {...props} />)
  return props
}

describe("ProjectEnvironmentRuntimeDeclaration", () => {
  // The boring verdict is still a verdict: silence would be indistinguishable
  // from the feature not existing.
  it("says a repository declares nothing, and where it looked", () => {
    renderCard()
    expect(screen.getByText(en.runtime.declaration.none)).toBeInTheDocument()
    expect(screen.getByText(/\.cognia\/workspace\.json, \.devcontainer\.json/)).toBeInTheDocument()
  })

  it("does not read an untrusted workspace", () => {
    renderCard({ declaration: { kind: "restricted" } })
    expect(screen.getByText(en.runtime.declaration.restricted)).toBeInTheDocument()
    expect(screen.queryByTestId("runtime-declaration-approve")).not.toBeInTheDocument()
  })

  it("lists each refused field by its path and code", () => {
    renderCard({
      declaration: {
        kind: "invalid",
        path: ".devcontainer.json",
        problems: [
          { code: "devcontainer_field_refused", field: "privileged" },
          { code: "declaration_field_unknown", field: "hostRequirements" },
        ],
        notices: [],
      },
    })
    const problems = within(screen.getByTestId("runtime-declaration-problems"))
    expect(problems.getByText(/2 problems/)).toBeInTheDocument()
    expect(problems.getByText("privileged: devcontainer_field_refused")).toBeInTheDocument()
  })

  // "Approve" is meaningless next to a filename; what is being asked for is
  // shown first.
  it("shows what a declaration asks for before offering to approve it", () => {
    const props = renderCard({ declaration: declared() })

    expect(
      screen.getByText(/\.devcontainer\.json asks for docker\.io\/library\/python:3\.12-slim/)
    ).toBeInTheDocument()
    // The test double for next-intl renders the `other` plural branch; the
    // counts are what this card is responsible for.
    expect(
      screen.getByText(/^1 variables? · 1 ports? · 1 lifecycle commands?$/)
    ).toBeInTheDocument()
    expect(screen.getByText("Runs as vscode")).toBeInTheDocument()
    expect(screen.getByText(en.runtime.declaration.pending)).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("runtime-declaration-approve"))
    expect(props.onApprove).toHaveBeenCalled()
  })

  // With no pool there is no ledger to write to; offering the button would
  // only produce `sandbox_pool_disabled`.
  it("offers no approval on a deployment without a pool", () => {
    renderCard({ declaration: declared(), canApprove: false })
    expect(screen.queryByTestId("runtime-declaration-approve")).not.toBeInTheDocument()
  })

  it("reads as approved, by whom, once the ledger matches this exact declaration", () => {
    renderCard({ declaration: declared(), approvals: [approval()] })
    expect(screen.getByTestId("project-environment-runtime-declaration")).toHaveAttribute(
      "data-state",
      "approved"
    )
    expect(screen.getByText("Approved by usr_alice")).toBeInTheDocument()
    expect(screen.queryByTestId("runtime-declaration-approve")).not.toBeInTheDocument()
  })

  // Same path, different digest: the file changed after someone said yes.
  // That is a different sentence from "never approved".
  it("tells an edited declaration from one never approved", () => {
    renderCard({
      declaration: declared(),
      approvals: [approval({ declarationDigest: "e".repeat(64) })],
    })
    expect(screen.getByTestId("project-environment-runtime-declaration")).toHaveAttribute(
      "data-state",
      "changed"
    )
    expect(screen.getByText(en.runtime.declaration.changed)).toBeInTheDocument()
    expect(screen.getByTestId("runtime-declaration-approve")).toBeInTheDocument()
  })

  it("ignores a revoked approval", () => {
    renderCard({ declaration: declared(), approvals: [approval({ revokedAt: 5 })] })
    expect(screen.queryByTestId("runtime-declaration-approvals")).not.toBeInTheDocument()
    expect(screen.getByText(en.runtime.declaration.pending)).toBeInTheDocument()
  })

  it("revokes an approval by id, with a label that names what it revokes", () => {
    const props = renderCard({ declaration: declared(), approvals: [approval()] })
    fireEvent.click(
      screen.getByRole("button", { name: "Revoke the approval for .devcontainer.json" })
    )
    expect(props.onRevoke).toHaveBeenCalledWith("apr1")
  })

  it("disables its actions while a request is in flight", () => {
    renderCard({ declaration: declared(), busy: true })
    expect(screen.getByTestId("runtime-declaration-approve")).toBeDisabled()
  })
})
