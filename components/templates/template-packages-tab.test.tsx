import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { TemplatePackagesTab } from "./template-packages-tab"
import type { StoredTemplatePackage } from "@/lib/templates/repository"

function storedPackage(overrides: Partial<StoredTemplatePackage> = {}): StoredTemplatePackage {
  return {
    key: "com.example.pack@1.0.0",
    manifest: {
      schemaVersion: 1,
      apiVersion: "cognia.ai/templates/v1",
      id: "com.example.pack",
      version: "1.0.0",
      name: "Example pack",
      entrypoints: ["skill.a"],
      definitions: [
        {
          path: "definitions/skill.a.json",
          sha256: "a".repeat(64),
          id: "skill.a",
          version: "1.0.0",
        },
      ],
      assets: [],
    },
    fingerprint: "fp",
    trust: "unsigned",
    importedAt: 1,
    source: "file",
    ...overrides,
  }
}

function renderTab(overrides: Partial<React.ComponentProps<typeof TemplatePackagesTab>> = {}) {
  const handlers = {
    onVerify: jest.fn(),
    onYank: jest.fn(),
    onRemove: jest.fn(),
    onReexport: jest.fn(),
    onRollbackMigration: jest.fn(),
  }
  render(
    <TemplatePackagesTab packages={[storedPackage()]} reports={{}} {...handlers} {...overrides} />
  )
  return handlers
}

describe("TemplatePackagesTab", () => {
  it("verifies and re-exports a package", () => {
    const handlers = renderTab()

    fireEvent.click(screen.getByRole("button", { name: /packages.verify/ }))
    fireEvent.click(screen.getByRole("button", { name: /packages.reexport/ }))

    expect(handlers.onVerify).toHaveBeenCalledWith("com.example.pack@1.0.0")
    expect(handlers.onReexport).toHaveBeenCalledWith("com.example.pack@1.0.0")
  })

  it("toggles the yank mark the record type has always carried", () => {
    const handlers = renderTab()
    fireEvent.click(screen.getByTestId("template-package-yank"))
    expect(handlers.onYank).toHaveBeenCalledWith("com.example.pack@1.0.0", true)

    const yanked = renderTab({ packages: [storedPackage({ yankedAt: 42 })] })
    expect(screen.getAllByTestId("template-package-yanked").length).toBe(1)
    fireEvent.click(screen.getAllByTestId("template-package-yank")[1])
    expect(yanked.onYank).toHaveBeenCalledWith("com.example.pack@1.0.0", false)
  })

  it("asks before uninstalling a package", () => {
    const handlers = renderTab()

    fireEvent.click(screen.getByTestId("template-package-remove"))
    expect(handlers.onRemove).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "packages.remove" }))
    expect(handlers.onRemove).toHaveBeenCalledWith("com.example.pack@1.0.0")
  })

  it("renders a verification report per release", () => {
    renderTab({
      reports: {
        "com.example.pack@1.0.0": {
          key: "com.example.pack@1.0.0",
          trust: "unsigned",
          signed: false,
          definitions: [{ id: "skill.a", version: "1.0.0", state: "hash-mismatch" }],
        },
      },
    })

    expect(screen.getByTestId("template-package-report")).toHaveTextContent(
      "packages.state.hash-mismatch"
    )
    expect(screen.getByText("packages.unsignedManifest")).toBeInTheDocument()
  })

  it("asks before rolling a domain migration back", () => {
    const handlers = renderTab()

    fireEvent.click(screen.getByTestId("template-rollback-migration"))
    expect(handlers.onRollbackMigration).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "packages.rollback" }))
    expect(handlers.onRollbackMigration).toHaveBeenCalledWith("skill")
  })
})
