import {
  readCatalog,
  renderPythonContract,
  renderRustContract,
  validateAgainstSchema,
  validatePluginPointCatalog,
} from "./generate-contract.mjs"
import { describe, test } from "node:test"
import assert from "node:assert/strict"

describe("plugin contract generator", () => {
  const catalog = readCatalog()

  test("projects every canonical plugin point into the authoring catalog", () => {
    assert.equal(catalog.pluginPointSchemaVersion, 1)
    assert.equal(catalog.pluginPoints.length, 275)
    assert.equal(
      new Set(catalog.pluginPoints.map((point) => `${point.kind}:${point.id}`)).size,
      catalog.pluginPoints.length
    )
    assert.deepEqual(
      catalog.pluginPoints.find((point) => point.id === "chat.input.actions"),
      {
        id: "chat.input.actions",
        kind: "ui-slot",
        stability: "stable",
        status: "implemented",
        introducedIn: "0.1.0",
        permission: "extension:ui",
        formFactor: "row",
      }
    )
    assert.equal(
      catalog.pluginPoints.find((point) => point.id === "onAgentTool:*")?.replacementId,
      "onTool:*"
    )
    assert.equal(
      catalog.pluginPoints.find((point) => point.id === "provider.routing-strategy")?.permission,
      "network:fetch"
    )
  })

  test("renders the newly added contract values into both language mirrors", () => {
    const rust = renderRustContract(catalog)
    const python = renderPythonContract(catalog)

    assert.match(rust, /"context-panel"/)
    assert.match(rust, /"artifact:read"/)
    assert.match(rust, /"ipc:call"/)
    assert.match(rust, /"vscodeGrammars\[\]\.path"/)
    assert.match(rust, /\("context-panel", &\["contextPanels"\]\)/)
    assert.match(rust, /CAPABILITY_MINIMUM_HOST_VERSIONS/)
    assert.match(rust, /MANIFEST_CONTRIBUTIONS/)
    assert.match(rust, /RUNTIME_ENTRY_CONTRACTS/)
    assert.match(rust, /AUTHORING_CATALOG_JSON/)
    assert.match(rust, /chat\.input\.actions/)
    assert.match(rust, /vscodeExtension\.contributes\.chatInstructions/)
    assert.match(python, /"context-panel"/)
    assert.match(python, /"sessionImporters\[\]\.entry"/)
    assert.match(python, /"vscodeSnippets\[\]\.path"/)
    assert.match(python, /CAPABILITY_MINIMUM_HOST_VERSIONS/)
    assert.match(python, /MANIFEST_CONTRIBUTIONS/)
    assert.match(python, /RUNTIME_ENTRY_CONTRACTS/)
    assert.match(python, /PLUGIN_POINT_CONTRACTS/)
    assert.match(python, /"formFactor": "row"/)
    assert.match(python, /"javascriptEntry": None/)
    assert.doesNotMatch(python, /:\s*(?:null|true|false)\b/)
  })

  test("is deterministic", () => {
    assert.equal(renderRustContract(catalog), renderRustContract(catalog))
    assert.equal(renderPythonContract(catalog), renderPythonContract(catalog))
  })

  test("embeds future catalog entries without a second hand-maintained list", () => {
    const extended = structuredClone(catalog)
    extended.capabilities.push({
      id: "future-authoring-capability",
      support: "experimental",
      manifestFields: ["futureAuthoringEntries"],
      introducedIn: "9.9.9",
      minimumHostVersion: "9.9.9",
    })
    extended.manifestContributions.push({
      field: "futureAuthoringEntries",
      capabilities: ["future-authoring-capability"],
      execution: "host",
    })
    extended.pluginPoints.push({
      id: "future.authoring-point",
      kind: "runtime",
      stability: "experimental",
      status: "implemented",
      introducedIn: "9.9.9",
      permission: "future:permission",
    })

    const rust = renderRustContract(extended)
    assert.match(rust, /AUTHORING_CATALOG_JSON/)
    assert.match(rust, /future-authoring-capability/)
    assert.match(rust, /futureAuthoringEntries/)
    assert.match(rust, /future\.authoring-point/)
  })

  test("rejects schema-invalid catalogs before rendering", () => {
    const schema = {
      type: "object",
      required: ["requiredValue"],
      properties: { requiredValue: { type: "string" } },
      additionalProperties: false,
    }
    assert.throws(
      () => validateAgainstSchema({ requiredValue: 1 }, schema),
      /requiredValue must be string/
    )
    assert.throws(
      () => validateAgainstSchema({ requiredValue: "ok", unexpected: true }, schema),
      /unexpected is not allowed/
    )
  })

  test("rejects ambiguous, malformed, or undeclared plugin point records", () => {
    const point = {
      id: "chat.input.actions",
      kind: "ui-slot",
      stability: "stable",
      status: "implemented",
      introducedIn: "0.1.0",
      permission: "extension:ui",
      formFactor: "row",
    }
    assert.throws(
      () =>
        validatePluginPointCatalog({ schemaVersion: 1, pluginPoints: [point, { ...point }] }, [
          "extension:ui",
        ]),
      /duplicate plugin point/
    )
    assert.throws(
      () =>
        validatePluginPointCatalog(
          { schemaVersion: 1, pluginPoints: [{ ...point, formFactor: undefined }] },
          ["extension:ui"]
        ),
      /formFactor/
    )
    assert.throws(
      () =>
        validatePluginPointCatalog(
          { schemaVersion: 1, pluginPoints: [{ ...point, permission: "missing:permission" }] },
          ["extension:ui"]
        ),
      /unknown permission/
    )
  })
})
