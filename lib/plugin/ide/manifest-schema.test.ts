import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { runInNewContext } from "node:vm"
import { validateIdeManifestSchema } from "./manifest-schema"

const base = {
  schemaVersion: 1,
  targets: ["pro-ide"],
}

describe("validateIdeManifestSchema", () => {
  it("loads the generated validator in a context that forbids eval and Function", () => {
    const file =
      require.resolve("@/packages/plugin-sdk/contract/ide-manifest-validator.generated.cjs")
    const commonjsModule = { exports: {} }
    runInNewContext(
      readFileSync(file, "utf8"),
      {
        module: commonjsModule,
        exports: commonjsModule.exports,
        require: createRequire(file),
        URL,
      },
      { contextCodeGeneration: { strings: false, wasm: false } }
    )
    const validate = commonjsModule.exports as (value: unknown) => boolean
    expect(validate(base)).toBe(true)
    expect(validate({ ...base, targets: [] })).toBe(false)
  })

  it("validates installed IDE manifests when runtime code generation is forbidden", () => {
    jest.isolateModules(() => {
      const blocked = jest.spyOn(globalThis, "Function").mockImplementation(() => {
        throw new EvalError("Content Security Policy forbids dynamic code generation")
      })
      try {
        const { validateIdeManifestSchema: validate } =
          jest.requireActual<typeof import("./manifest-schema")>("./manifest-schema")
        expect(validate(base)).toEqual([])
        expect(validate({ ...base, targets: [] })).toEqual(
          expect.arrayContaining([expect.objectContaining({ keyword: "minItems" })])
        )
        expect(blocked).not.toHaveBeenCalled()
      } finally {
        blocked.mockRestore()
      }
    })
  })

  it("accepts stable Code 1.128 contribution shapes", () => {
    expect(
      validateIdeManifestSchema({
        ...base,
        contributions: {
          commands: [{ command: "refresh", title: "Refresh" }],
          languages: [{ id: "acme", extensions: [".acme"] }],
          taskDefinitions: [{ type: "acme.build", required: ["target"] }],
          typescriptServerPlugins: [
            {
              name: "typescript-acme-plugin",
              enableForWorkspaceTypeScriptVersions: true,
            },
          ],
        },
      })
    ).toEqual([])
  })

  it("returns field-level diagnostics for malformed contribution metadata", () => {
    const diagnostics = validateIdeManifestSchema({
      ...base,
      contributions: {
        commands: [{ command: "refresh" }],
      },
    })

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "IDE_MANIFEST_SCHEMA_INVALID",
          field: "ide.contributions.commands[0].title",
          keyword: "required",
        }),
      ])
    )
  })

  it("rejects proposed subfields retained in the upstream runtime schema", () => {
    expect(
      validateIdeManifestSchema({
        ...base,
        contributions: {
          chatParticipants: [
            {
              id: "assistant",
              name: "assistant",
              locations: ["panel"],
            },
          ],
        },
      })
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "IDE_MANIFEST_SCHEMA_INVALID",
          field: "ide.contributions.chatParticipants[0]",
          keyword: "not",
        }),
      ])
    )
  })

  it("rejects unclassified contribution points and invalid URIs", () => {
    const unknown = validateIdeManifestSchema({
      ...base,
      contributions: { futureContribution: [] },
    })
    expect(unknown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "ide.contributions.futureContribution",
          keyword: "additionalProperties",
        }),
      ])
    )

    const invalidUri = validateIdeManifestSchema({
      ...base,
      protocols: {
        lsp: [
          {
            id: "server",
            executable: "server",
            transport: "socket",
            endpoint: "not a uri",
          },
        ],
      },
    })
    expect(invalidUri).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "ide.protocols.lsp[0].endpoint",
          keyword: "format",
        }),
      ])
    )
  })

  it("enforces locked regex, URI-reference, and color formats", () => {
    const diagnostics = validateIdeManifestSchema({
      ...base,
      contributions: {
        languageModelTools: [
          {
            name: "inspect",
            modelDescription: "Inspect",
            inputSchema: {
              $id: "http://[",
              $schema: "http://[",
              type: "string",
              pattern: "[",
            },
          },
        ],
        colors: [
          {
            id: "acme.color",
            description: "Acme",
            defaults: { light: "#xyzxyz", dark: "#000000" },
          },
        ],
      },
    })

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "ide.contributions.languageModelTools[0].inputSchema.pattern",
          keyword: "format",
        }),
        expect.objectContaining({
          field: "ide.contributions.languageModelTools[0].inputSchema.$schema",
          keyword: "format",
        }),
        expect.objectContaining({
          field: "ide.contributions.languageModelTools[0].inputSchema.$id",
          keyword: "format",
        }),
        expect.objectContaining({
          field: "ide.contributions.colors[0].defaults.light",
          keyword: "format",
        }),
      ])
    )
  })
})
