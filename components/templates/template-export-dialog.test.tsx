import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { TemplateExportDialog } from "./template-export-dialog"
import type { TemplateDefinitionEnvelope } from "@/lib/templates/contracts"

function release(id: string, name: string, version = "1.2.0"): TemplateDefinitionEnvelope {
  return {
    apiVersion: "cognia.ai/templates/v1",
    id,
    domain: "skill",
    status: "published",
    revision: 1,
    version,
    metadata: { name, description: "d" },
    payload: {},
    inputs: [],
    dependencies: [],
    capabilities: [],
    compatibility: { platforms: ["desktop"] },
    provenance: { source: "user", trust: "unsigned" },
    contentHash: `sha256:${id}`,
    createdAt: 1,
    updatedAt: 1,
  }
}

describe("TemplateExportDialog", () => {
  it("seeds the origin release and bundles the extras that get ticked", () => {
    const origin = release("user.skill.a", "Alpha")
    const onExport = jest.fn()
    render(
      <TemplateExportDialog
        origin={origin}
        releases={[origin, release("user.skill.b", "Beta", "2.0.0")]}
        onOpenChange={jest.fn()}
        onExport={onExport}
      />
    )

    // The origin arrives ticked, which is what the old single-release export
    // always did, so the common case is still one click.
    fireEvent.click(screen.getByLabelText("user.skill.b@2.0.0"))
    fireEvent.change(screen.getByLabelText("packageDescription"), {
      target: { value: "Alpha and its helper" },
    })
    fireEvent.click(screen.getByRole("button", { name: "confirm" }))

    expect(onExport).toHaveBeenCalledWith({
      id: "user.skill.a.package",
      version: "1.2.0",
      name: "Alpha",
      description: "Alpha and its helper",
      definitionIds: [
        { id: "user.skill.a", version: "1.2.0" },
        { id: "user.skill.b", version: "2.0.0" },
      ],
    })
  })

  it("omits an empty description rather than sending a blank field", () => {
    const origin = release("user.skill.a", "Alpha")
    const onExport = jest.fn()
    render(
      <TemplateExportDialog
        origin={{ ...origin, metadata: { name: "Alpha" } }}
        releases={[origin]}
        onOpenChange={jest.fn()}
        onExport={onExport}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "confirm" }))

    expect(onExport).toHaveBeenCalledWith(
      expect.not.objectContaining({ description: expect.anything() })
    )
  })

  it("cannot export an empty package", () => {
    const origin = release("user.skill.a", "Alpha")
    render(
      <TemplateExportDialog
        origin={origin}
        releases={[origin]}
        onOpenChange={jest.fn()}
        onExport={jest.fn()}
      />
    )

    fireEvent.click(screen.getByLabelText("user.skill.a@1.2.0"))
    expect(screen.getByRole("button", { name: "confirm" })).toBeDisabled()
  })
})
