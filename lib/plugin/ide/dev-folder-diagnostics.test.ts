import type { PluginManifest } from "@/types/plugin"

import { diagnoseDevFolderManifest } from "./dev-folder-diagnostics"

const manifest = (ide: unknown): PluginManifest =>
  ({ id: "acme", name: "Acme", version: "1.0.0", type: "frontend", ide }) as PluginManifest

describe("diagnoseDevFolderManifest", () => {
  it("has nothing to say about a plugin without a managed IDE section", () => {
    expect(diagnoseDevFolderManifest(manifest(undefined))).toEqual({
      managedIde: false,
      diagnostics: [],
      warnings: [],
    })
  })

  it("passes a valid section", () => {
    expect(
      diagnoseDevFolderManifest(
        manifest({
          schemaVersion: 1,
          targets: ["pro-ide"],
          providers: [{ id: "hover", kind: "hover", handler: "provideHover" }],
        })
      )
    ).toEqual({ managedIde: true, diagnostics: [], warnings: [] })
  })

  it("reports every schema problem with its field", () => {
    const { diagnostics } = diagnoseDevFolderManifest(
      manifest({
        schemaVersion: 1,
        targets: ["pro-ide"],
        contributions: {
          languageModelTools: [{ name: "has.dot", displayName: "T", modelDescription: "T" }],
        },
      })
    )
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "IDE_MANIFEST_SCHEMA_INVALID",
        field: expect.stringContaining("languageModelTools"),
      }),
    ])
  })

  it("reports a normalization refusal the schema cannot see", () => {
    const { diagnostics } = diagnoseDevFolderManifest(
      manifest({
        schemaVersion: 1,
        targets: ["pro-ide"],
        providers: [
          { id: "same", kind: "hover", handler: "a" },
          { id: "same", kind: "hover", handler: "b" },
        ],
      })
    )
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "IDE_PROVIDER_ID_CONFLICT",
        message: expect.stringContaining("same"),
      }),
    ])
  })
})
