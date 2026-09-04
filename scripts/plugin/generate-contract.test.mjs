import {
  readCatalog,
  renderPythonContract,
  renderApiReference,
  renderRustContract,
  renderTypeScriptContract,
  validateAgainstSchema,
  validateApiSurfaceCompatibility,
  validatePluginPointCatalog,
  validateInterfaceCatalog,
  parseArgs,
} from "./generate-contract.mjs"
import { describe, test } from "node:test"
import assert from "node:assert/strict"

describe("plugin contract generator", () => {
  const catalog = readCatalog()

  test("parseArgs supports check mode and rejects unknown options", () => {
    assert.deepEqual(parseArgs([]), { check: false })
    assert.deepEqual(parseArgs(["--check"]), { check: true })
    assert.throws(() => parseArgs(["--unknown"]), /unknown option/i)
  })

  test("projects every canonical plugin point into the authoring catalog", () => {
    assert.equal(catalog.pluginPointSchemaVersion, 1)
    assert.equal(catalog.pluginPoints.length, 276)
    assert.equal(
      new Set(catalog.pluginPoints.map((point) => point.id)).size,
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
    const typescript = renderTypeScriptContract(catalog)

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
    assert.match(rust, /PROTOCOL_VERSION/)
    assert.match(rust, /GATEWAY_CLIENT_VERSION/)
    assert.match(python, /API_NAMESPACE_CONTRACTS/)
    assert.match(python, /MINIMUM_GATEWAY_CLIENT_VERSION/)
    assert.match(typescript, /CanonicalPluginPermission/)
    assert.match(typescript, /PLUGIN_GATEWAY_CLIENT_VERSION/)
    assert.doesNotMatch(python, /:\s*(?:null|true|false)\b/)
  })

  test("projects every callable API into generated author documentation", () => {
    const docs = renderApiReference(catalog)
    const methods = catalog.apiNamespaces.flatMap((namespace) => namespace.methods)
    assert.equal(catalog.apiNamespaces.length, 77)
    assert.equal(methods.length, 764)
    assert.match(docs, /`ctx\.session`/)
    assert.match(docs, /`session\.listSessions`/)
    assert.match(docs, /`templates\.instantiate`/)
    assert.match(docs, /`media\.video\.export`/)
    assert.doesNotMatch(docs, /ctx\.api\./)
  })

  test("requires canonical lifecycle ownership metadata for every API method", () => {
    const methods = new Map(
      catalog.apiNamespaces
        .flatMap((namespace) => namespace.methods)
        .map((method) => [method.id, method.resourceEffect])
    )

    assert.equal(methods.size, 764)
    assert.deepEqual(methods.get("webview.create"), {
      kind: "returned-handle",
      disposeMethod: "dispose",
    })
    assert.deepEqual(methods.get("events.on"), { kind: "returned-disposer" })
    assert.deepEqual(methods.get("lifecycle.onDispose"), { kind: "host-owned" })

    const invalid = structuredClone(catalog)
    invalid.apiNamespaces[0].methods[0].resourceEffect = {
      kind: "returned-handle",
    }
    assert.throws(() => validateInterfaceCatalog(invalid), /requires disposeMethod/)
  })

  test("pins representative sensitive API governance", () => {
    const methods = new Map(
      catalog.apiNamespaces
        .flatMap((namespace) => namespace.methods)
        .map((method) => [method.id, method])
    )
    assert.deepEqual(methods.get("auth.registerProvider")?.requiredPermissions, ["auth:provide"])
    assert.deepEqual(methods.get("templates.instantiate")?.requiredPermissions, [
      "templates:instantiate",
    ])
    assert.equal(methods.get("templates.instantiate")?.consentTier, "confirm")
    assert.deepEqual(methods.get("media.video.export")?.requiredPermissions, ["media:video:export"])
    assert.equal(methods.get("media.ai.generateImage")?.risk, "high")
  })

  test("rejects duplicate methods and permissions outside the canonical catalog", () => {
    const invalidPermission = structuredClone(catalog)
    invalidPermission.apiNamespaces[0].methods[0].requiredPermissions = ["not:declared"]
    assert.throws(() => validateInterfaceCatalog(invalidPermission), /unknown permission/)

    const duplicate = structuredClone(catalog)
    duplicate.apiNamespaces[0].methods.push(duplicate.apiNamespaces[0].methods[0])
    assert.throws(() => validateInterfaceCatalog(duplicate), /duplicate API method/)

    const empty = structuredClone(catalog)
    empty.apiNamespaces.find((namespace) => namespace.id === "templates").methods = []
    assert.throws(() => validateInterfaceCatalog(empty), /must declare its methods/)
  })

  test("allows additive API changes but rejects removals and runtime support shrinkage", () => {
    const baseline = {
      namespaces: [
        {
          id: "session",
          authorPath: "ctx.session",
          runtimes: ["frontend"],
          platforms: ["desktop"],
          methods: ["session.listSessions"],
        },
      ],
    }
    const additive = structuredClone(catalog)
    additive.apiNamespaces
      .find((namespace) => namespace.id === "session")
      .methods.push({
        id: "session.futureMethod",
        name: "futureMethod",
        requiredPermissions: [],
        consentTier: "none",
        risk: "low",
        idempotent: true,
        cancellable: false,
      })
    assert.doesNotThrow(() => validateApiSurfaceCompatibility(additive, baseline))

    const removed = structuredClone(catalog)
    removed.apiNamespaces.find((namespace) => namespace.id === "session").methods = []
    assert.throws(() => validateApiSurfaceCompatibility(removed, baseline), /removed method/)

    const shrunk = structuredClone(catalog)
    shrunk.apiNamespaces.find((namespace) => namespace.id === "session").runtimes = []
    assert.throws(() => validateApiSurfaceCompatibility(shrunk, baseline), /removed runtime/)
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
