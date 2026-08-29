import assert from "node:assert/strict"
import test from "node:test"
import Ajv2020 from "ajv/dist/2020.js"
import { parse as parseYaml } from "yaml"

import {
  buildHostCommandCatalog,
  classifyHostCommand,
  extractKnownCommands,
  hostResourceForCommand,
  classifyCommands,
  collectRuntimeRoutes,
  ensureOperationPathParameters,
  extractCommandArgumentSchemas,
  extractRuntimeRoutes,
  inspectCommittedContract,
  reconcileRpcPaths,
  validateCommandCoverage,
  validateRouteContract,
} from "./gen-companion-api.mjs"

test("rejects duplicate dispatcher catalog entries", () => {
  assert.throws(
    () =>
      extractKnownCommands(`
const KNOWN_COMMANDS: &[&str] = &[
  "session_list",
  "session_list",
];`),
    /duplicate KNOWN_COMMANDS entries: session_list/,
  )
})

test("classifies host commands into one stable domain", () => {
  assert.equal(classifyHostCommand("session_list"), "sessions")
  assert.equal(classifyHostCommand("agent_task_start"), "agents")
  assert.equal(classifyHostCommand("task_workspace_get"), "tasks")
  assert.equal(classifyHostCommand("workflow_create"), "automation")
  assert.equal(classifyHostCommand("connectors_health"), "connectors")
  assert.equal(classifyHostCommand("plugin_list"), "extensions")
  assert.equal(classifyHostCommand("memory_search"), "knowledge")
  assert.equal(classifyHostCommand("git_status"), "development")
  assert.equal(classifyHostCommand("host_capabilities"), "system")
  assert.throws(() => classifyHostCommand("unclassified_future_command"), /exactly one/)
})

test("derives stable resources without copying the RPC tree", () => {
  assert.equal(hostResourceForCommand("task_workspace_get"), "task-workspaces")
  assert.equal(hostResourceForCommand("plugin_python_call"), "plugin-python")
  assert.equal(hostResourceForCommand("provider_catalog_search"), "provider-catalog")
  assert.equal(hostResourceForCommand("git_status"), "git")
  assert.equal(hostResourceForCommand("fs_list_workspace_dir"), "workspace-files")
  assert.equal(hostResourceForCommand("remote_notification_publish"), "notifications")
  assert.equal(hostResourceForCommand("project_environment_execute"), "project-environments")
})

test("publishes the concrete raw result contract in OpenAPI and the host catalog", () => {
  const inspected = inspectCommittedContract()
  const command = inspected.desiredHostCommandCatalog.commands.find(
    (entry) => entry.name === "session_list",
  )
  const responseSchema =
    inspected.desiredHeadlessSpec.paths["/internal/_rpc/session_list"].post.responses[200].content[
      "application/json"
    ].schema

  assert.equal(command.outputTyped, true)
  assert.equal(command.outputSchemaSource, "contract")
  assert.deepEqual(responseSchema, command.outputSchema)

  const validate = new Ajv2020().compile(command.outputSchema)
  assert.equal(
    validate({
      rows: [
        { id: "direct", title: "Direct", kind: "direct", createdAt: 1, updatedAt: 2 },
      ],
      total: 1,
    }),
    true,
  )
  assert.equal(
    validate({
      rows: [
        {
          id: "bridge",
          title: "Legacy bridge row",
          projectId: "project-a",
          lastMessagePreview: "Hello",
          lastMessageAt: 2,
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      next_offset: 1,
      has_more: true,
    }),
    true,
  )
})

test("merges compatible closed-object allOf request schemas", () => {
  const { desiredHeadlessSpec } = inspectCommittedContract()

  assert.deepEqual(
    desiredHeadlessSpec.paths["/internal/_rpc/agent_task_comment"].post.requestBody.content[
      "application/json"
    ].schema,
    {
      type: "object",
      required: ["agentId", "taskId", "text"],
      properties: {
        agentId: { type: "string", minLength: 1 },
        taskId: { type: "string", minLength: 1 },
        text: { type: "string", minLength: 1, maxLength: 4000 },
      },
      additionalProperties: false,
    },
  )
})

test("builds a deterministic host catalog from the generated Headless command set", () => {
  const inspected = inspectCommittedContract()
  const first = buildHostCommandCatalog(
    inspected.manifest,
    inspected.remoteNames,
    inspected.desiredHeadlessSpec,
  )
  const second = buildHostCommandCatalog(
    inspected.manifest,
    inspected.remoteNames,
    inspected.desiredHeadlessSpec,
  )
  const rpcNames = Object.keys(inspected.desiredHeadlessSpec.paths)
    .filter((path) => path.startsWith("/internal/_rpc/") && path !== "/internal/_rpc/{name}")
    .map((path) => path.slice("/internal/_rpc/".length))
    .sort()

  assert.deepEqual(
    first.commands.map((command) => command.name),
    rpcNames,
  )
  assert.deepEqual(first, second)
  assert.match(first.catalogHash, /^[a-f0-9]{64}$/)
  assert.equal(first.categories.length, 9)
  assert.equal(first.resources.length > first.categories.length, true)
  assert.equal(new Set(first.resources.map((resource) => resource.id)).size, first.resources.length)
  assert.equal(
    first.resources.find((resource) => resource.id === "plugin-vscode")?.title,
    "Plugin VS Code",
  )
  assert.equal(new Set(first.categories.map((category) => category.id)).size, 9)
  assert.equal(new Set(first.categories.map((category) => category.skill)).size, 9)
  const categoryIds = new Set(first.categories.map((category) => category.id))
  assert.equal(first.commands.every((command) => categoryIds.has(command.category)), true)
  const resourceIds = new Set(first.resources.map((resource) => resource.id))
  assert.equal(first.commands.every((command) => resourceIds.has(command.resource)), true)
  const resourceCategories = new Map(
    first.resources.map((resource) => [resource.id, resource.category]),
  )
  assert.equal(
    first.commands.every(
      (command) => resourceCategories.get(command.resource) === command.category,
    ),
    true,
  )
  assert.equal(first.commands.find((command) => command.name === "session_list")?.outputTyped, true)
  assert.equal(
    first.commands.every(
      (command) =>
        command.outputTyped === true &&
        command.outputSchema !== null &&
        command.outputSchemaSource === "contract",
    ),
    true,
  )
})

test("generates one drift-free identity for HTTP, WebSocket, CLI, and bridge consumers", () => {
  const inspected = inspectCommittedContract()
  const catalog = inspected.desiredHostCommandCatalog
  const asyncApi = parseYaml(inspected.desiredHeadlessAsyncApiSource)

  assert.equal(asyncApi.asyncapi, "3.0.0")
  assert.equal(asyncApi.info["x-cognia-catalog-hash"], catalog.catalogHash)
  assert.equal(asyncApi.info.version, String(catalog.schemaVersion))
  assert.equal(asyncApi.channels.headlessEvents.address, "/internal/events")
  assert.equal(asyncApi.channels.headlessBridge.address, "/internal/bridge")
  assert.match(inspected.desiredHeadlessContractIdentitySource, new RegExp(catalog.catalogHash))
  assert.match(
    inspected.desiredHeadlessContractIdentitySource,
    new RegExp(`HEADLESS_CONTRACT_VERSION = ${catalog.schemaVersion}`),
  )
  const bridgeFixture = JSON.parse(inspected.desiredBridgeFixtureSource)
  for (const name of ["hello", "helloAck"]) {
    assert.equal(bridgeFixture.frames[name].catalogHash, catalog.catalogHash)
    assert.equal(bridgeFixture.frames[name].contractVersion, catalog.schemaVersion)
  }
  assert.equal(inspected.headlessAsyncApiDrift, false)
  assert.equal(inspected.hostCommandCatalogDrift, false)
  assert.equal(inspected.headlessContractIdentityDrift, false)
  assert.equal(inspected.bridgeFixtureDrift, false)
})

test("publishes promoted request contracts and the durable Headless control routes", () => {
  const inspected = inspectCommittedContract()
  const generated = inspected.desiredHeadlessSpec["x-cognia-generated"]

  assert.equal(generated.genericRequestSchemaCount, 0)
  assert.equal(inspected.requestSchemaCatalogDrift, false)
  assert.ok(inspected.desiredHeadlessSpec.paths["/internal/operations/{operation_id}"].get)
  assert.ok(inspected.desiredHeadlessSpec.paths["/integrations/mcp/oauth/callback"].get)

  const unownedOpaque = inspected.desiredHostCommandCatalog.commands.filter(
    (command) =>
      JSON.stringify(command.outputSchema).includes("x-cognia-opaque-reason") &&
      typeof command.outputSchema?.["x-cognia-schema-owner"] !== "string",
  )
  assert.deepEqual(unownedOpaque, [])
})

test("compiles every generated Headless input as Draft 2020-12 JSON Schema", () => {
  const { desiredHeadlessSpec } = inspectCommittedContract()
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false })

  for (const [path, item] of Object.entries(desiredHeadlessSpec.paths)) {
    if (!path.startsWith("/internal/_rpc/") || path === "/internal/_rpc/{name}") continue
    assert.doesNotThrow(
      () => ajv.compile(item.post.requestBody.content["application/json"].schema),
      path,
    )
  }
})

test("publishes a compilable output contract for every Headless command", () => {
  const { desiredHostCommandCatalog } = inspectCommittedContract()
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false })

  assert.equal(desiredHostCommandCatalog.commands.length >= 440, true)
  for (const command of desiredHostCommandCatalog.commands) {
    assert.equal(command.outputTyped, true, command.name)
    assert.equal(command.outputSchemaSource, "contract", command.name)
    assert.ok(command.outputSchema, command.name)
    assert.notDeepEqual(command.outputSchema, {}, command.name)
    assert.doesNotThrow(() => ajv.compile(command.outputSchema), command.name)
  }
})

test("marks fallible args.get reads as required request fields", () => {
  const schemas = extractCommandArgumentSchemas(`
pub(super) async fn dispatch() {
  match name {
        "provider_profiles_import" => {
            let payload = args
                .get("payload")
                .cloned()
                .ok_or_else(|| RpcError::malformed("missing payload".to_string()))?;
            Ok(payload)
        }
        unknown => Err(RpcError::unknown_command(unknown)),
  }
}
`)

  assert.deepEqual(schemas.get("provider_profiles_import"), {
    type: "object",
    required: ["payload"],
    properties: { payload: {} },
    additionalProperties: false,
  })
})

test("generates Apifox-ready parameters for the session_list request body", () => {
  const { desiredHeadlessSpec } = inspectCommittedContract()
  const operation = desiredHeadlessSpec.paths["/internal/_rpc/session_list"].post
  const schema = operation.requestBody.content["application/json"].schema

  assert.equal(operation["x-cognia-request-schema-source"], "contract")
  assert.deepEqual(schema.required, ["limit", "offset"])
  assert.deepEqual(schema.properties.limit, {
    type: "integer",
    minimum: 0,
  })
  assert.deepEqual(schema.properties.offset, {
    type: "integer",
    minimum: 0,
  })
  assert.deepEqual(schema.properties.before, {
    type: "integer",
    description: "Optional ms-epoch upper bound (updatedAt <).",
  })
  assert.equal(schema.additionalProperties, false)
})

test("generates nested array item schemas without generic Apifox placeholders", () => {
  const { desiredHeadlessSpec } = inspectCommittedContract()
  const operation = desiredHeadlessSpec.paths["/internal/_rpc/connector_send"].post
  const schema = operation.requestBody.content["application/json"].schema

  assert.equal(desiredHeadlessSpec["x-cognia-generated"].genericRequestSchemaCount, 0)
  assert.deepEqual(schema.required, ["sessionId", "segments"])
  assert.equal(schema.additionalProperties, false)
  assert.equal(schema.properties.segments.type, "array")
  assert.deepEqual(schema.properties.segments.items, {
    type: "object",
    properties: {
      type: { type: "string" },
      text: { type: "string" },
    },
    additionalProperties: false,
  })
})

test("removes released pairing and remote-control components from the public contract", () => {
  const { desiredPublicSpec } = inspectCommittedContract()

  for (const name of ["IssueResponse", "PairRequest", "PairResponse"]) {
    assert.equal(desiredPublicSpec.components.schemas[name], undefined)
  }
  for (const name of ["PayloadTooLarge", "RemoteControlForbidden", "ServiceTokenRequired"]) {
    assert.equal(desiredPublicSpec.components.responses[name], undefined)
  }
  assert.equal(desiredPublicSpec.components.responses.JwtRejected, undefined)
  const serialized = JSON.stringify(desiredPublicSpec)
  assert.doesNotMatch(serialized, /device JWT|pair JWT|\?token=<jwt>|JwtRejected/)
  assert.doesNotMatch(serialized, /\/(?:api|ws)\/v\d+\//)
  assert.ok(
    desiredPublicSpec.paths["/api/auth/device/challenge"].post.responses[429],
    "pre-auth throttling must be documented",
  )
})

test("documents workflow application routes with their application-scoped bearer authority", () => {
  const { desiredPublicSpec } = inspectCommittedContract()

  assert.deepEqual(desiredPublicSpec.paths["/api/portal/bootstrap"].get.security, [])
  assert.deepEqual(desiredPublicSpec.paths["/api/apps/{app_slug}/embed-token"].get.security, [])
  assert.deepEqual(desiredPublicSpec.paths["/api/apps/{app_slug}/runs"].post.security, [
    { workflowAppBearer: [] },
  ])
  assert.deepEqual(desiredPublicSpec.paths["/v1/workflows/run"].post.security, [
    { workflowAppBearer: [] },
  ])
  assert.deepEqual(desiredPublicSpec.components.securitySchemes.workflowAppBearer, {
    type: "http",
    scheme: "bearer",
    description:
      "Published workflow application session or application API key, depending on the endpoint.",
  })
})

test("browser socket tickets require a session-bound canonical request", () => {
  const { desiredPublicSpec } = inspectCommittedContract()
  const schema = desiredPublicSpec.components.schemas.SocketTicketRequest

  assert.deepEqual(schema.oneOf[0].required, ["channel", "sessionId"])
  assert.equal(schema.oneOf[0].properties.channel.const, "browser")
  assert.equal(schema.oneOf[0].properties.sessionId.minLength, 1)
  assert.deepEqual(schema.oneOf[1].properties.channel.enum, ["events", "terminal", "acp"])
  assert.equal(desiredPublicSpec.paths["/api/_rpc/browser_stream_ticket_issue"], undefined)
})

test("ACP WebSocket documents only the canonical socket-ticket authority", () => {
  const { desiredPublicSpec } = inspectCommittedContract()
  const operation = desiredPublicSpec.paths["/ws/acp"].get

  assert.deepEqual(operation.security, [])
  assert.equal(operation.parameters[0].name, "ticket")
  assert.equal(operation.parameters[0].required, true)
  assert.match(operation.description, /bearer tokens are never accepted/i)
})

test("keeps every concrete RPC request Apifox-generatable", () => {
  const { desiredHeadlessSpec } = inspectCommittedContract()
  const failures = []

  const inspectSchema = (schema, location) => {
    if (Array.isArray(schema)) {
      schema.forEach((value, index) => inspectSchema(value, `${location}/${index}`))
      return
    }
    if (!schema || typeof schema !== "object") return
    if (schema.type === "array" && (!schema.items || Object.keys(schema.items).length === 0)) {
      failures.push(`${location}: array has no item schema`)
    }
    if (schema.additionalProperties === true) {
      failures.push(`${location}: arbitrary properties can create property1/property2`)
    }
    for (const [key, value] of Object.entries(schema)) {
      inspectSchema(value, `${location}/${key}`)
    }
  }

  for (const [path, item] of Object.entries(desiredHeadlessSpec.paths)) {
    const operation = item.post
    if (!operation || !path.startsWith("/internal/_rpc/")) continue
    if (operation["x-cognia-request-schema-source"] === "generic-fallback") {
      failures.push(`${path}: generic request fallback`)
    }
    const schema = operation.requestBody?.content?.["application/json"]?.schema
    inspectSchema(schema, path)
  }

  assert.deepEqual(failures, [])
})

const manifest = {
  schemaVersion: 2,
  commands: [
    {
      name: "public_read",
      target: "execution",
      operation: "read",
      capability: "host.observe",
      risk: "low",
      approval: "none",
      idempotency: "structural",
      transports: ["http", "websocket"],
      inputSchema: "#/components/schemas/RpcArgs",
      outputSchema: "#/components/schemas/RpcResult",
    },
    {
      name: "service_write",
      target: "service",
      operation: "write",
      capability: "service.internal",
      risk: "high",
      approval: "signed-policy",
      idempotency: "required",
      transports: ["internal"],
      inputSchema: "#/components/schemas/RpcArgs",
      outputSchema: "#/components/schemas/RpcResult",
    },
    {
      name: "client_only",
      target: "client",
      operation: "read",
      capability: "client.read",
      risk: "low",
      approval: "none",
      idempotency: "structural",
      transports: ["internal"],
      inputSchema: "#/components/schemas/RpcArgs",
      outputSchema: "#/components/schemas/RpcResult",
    },
  ],
}

test("classifies device HTTP and headless commands without leaking internal targets", () => {
  const result = classifyCommands(manifest, new Set(["public_read", "service_write"]))

  assert.deepEqual(result.publicNames, ["public_read"])
  assert.deepEqual(result.internalNames, ["public_read", "service_write"])
})

test("command coverage rejects missing dispatch, descriptors, and non-durable mutations", () => {
  const invalid = structuredClone(manifest)
  invalid.commands[1].idempotency = "forbidden"
  invalid.commands[1].transports = ["internal", "http"]

  const errors = validateCommandCoverage(invalid, new Set(["public_read", "unknown_dispatch"]))

  assert(errors.includes("mutation must use durable idempotency: service_write"))
  assert(errors.includes("service command must be internal-only: service_write"))
  assert(errors.includes("remote command has no canonical dispatch arm: service_write"))
  assert(errors.includes("dispatch arm has no command descriptor: unknown_dispatch"))
})

test("classifies every client-only command outside the Headless surface", () => {
  const { manifest, headlessDispositions } = inspectCommittedContract()
  const clientNames = manifest.commands
    .filter((command) => command.target === "client")
    .map((command) => command.name)
    .sort()

  assert.deepEqual([...headlessDispositions.keys()].sort(), clientNames)
  assert.equal(
    [...headlessDispositions.values()].every((entry) =>
      [
        "local-only",
        "brain-owned-bridged",
        "covered-by-headless",
        "runtime-internal",
        "separate-design-required",
        "unexposed-gap",
        "in-progress",
      ].includes(entry.disposition),
    ),
    true,
  )
  assert.equal(headlessDispositions.has("mcp_oauth_authenticate"), false)
  assert.equal(headlessDispositions.get("scheduler_create_task").disposition, "covered-by-headless")
})

test("rejects versioned committed RPC paths instead of silently migrating them", () => {
  const publicPaths = {
    "/api/v1/_rpc/{name}": { post: { operationId: "rpcDispatch" } },
    "/api/v1/_rpc/public_read": { post: { operationId: "rpcPublicRead" } },
    "/api/v1/_rpc/service_write": { post: { operationId: "rpcServiceWrite" } },
  }

  assert.throws(
    () =>
      reconcileRpcPaths({
        publicPaths,
        internalPaths: {},
        manifest,
        remoteNames: new Set(["public_read", "service_write"]),
      }),
    /versioned public paths are forbidden/,
  )
})

test("reconciles canonical public RPC paths into the isolated internal spec", () => {
  const result = reconcileRpcPaths({
    publicPaths: {
      "/api/_rpc/{name}": { post: { operationId: "rpcDispatch" } },
      "/api/_rpc/public_read": { post: { operationId: "rpcPublicRead" } },
    },
    internalPaths: {},
    manifest,
    remoteNames: new Set(["public_read", "service_write"]),
  })

  assert.deepEqual(Object.keys(result.publicPaths).sort(), [
    "/api/_rpc/public_read",
    "/api/_rpc/{name}",
  ])
  assert.deepEqual(Object.keys(result.internalPaths).sort(), [
    "/internal/_rpc/public_read",
    "/internal/_rpc/service_write",
    "/internal/_rpc/{name}",
  ])
  assert.equal(
    result.internalPaths["/internal/_rpc/service_write"].post.operationId,
    "internalRpcServiceWrite",
  )
})

test("extracts Axum route methods and paths across multiline registrations", () => {
  const source = `
    Router::new()
      .route("/healthz", get(healthz))
      .route("/api/policies", get(list_policies).post(create_policy))
      .route("/ws/events", any(events_handler))
      .route(
        "/internal/_rpc/{name}",
        post(rpc_handler),
      );
  `

  assert.deepEqual([...extractRuntimeRoutes(source)].sort(), [
    "* /ws/events",
    "GET /api/policies",
    "GET /healthz",
    "POST /api/policies",
    "POST /internal/_rpc/{name}",
  ])
})

test("runtime route collection ignores test routers and rejects duplicate registrations", () => {
  const first = `
    Router::new().route("/healthz", get(healthz));

    #[cfg(test)]
    mod tests {
      fn router() { Router::new().route("/test-only", post(handler)); }
    }
  `
  const second = `Router::new().route("/healthz", get(other_healthz));`
  const result = collectRuntimeRoutes([
    ["first.rs", first],
    ["second.rs", second],
  ])

  assert.deepEqual([...result.routes], ["GET /healthz"])
  assert.deepEqual(result.errors, [
    "duplicate runtime route registration: GET /healthz (second.rs)",
  ])
})

test("repairs required OpenAPI parameters for templated runtime routes", () => {
  const operation = {
    parameters: [{ in: "query", name: "format", schema: { type: "string" } }],
  }

  ensureOperationPathParameters(operation, "/api/sessions/{session_id}/media/{hash}")

  assert.deepEqual(operation.parameters, [
    { in: "query", name: "format", schema: { type: "string" } },
    {
      in: "path",
      name: "session_id",
      required: true,
      schema: { type: "string" },
    },
    {
      in: "path",
      name: "hash",
      required: true,
      schema: { type: "string" },
    },
  ])
})

test("route contract rejects undocumented or unmounted routes", () => {
  const contract = {
    schemaVersion: 1,
    routes: [
      { path: "/healthz", method: "get", document: "public" },
      {
        path: "/internal/{tail}",
        runtimePath: "/internal/{*tail}",
        method: "get",
        document: "headless",
      },
    ],
  }
  const errors = validateRouteContract({
    contract,
    runtimeRoutes: new Set(["GET /healthz"]),
    publicPaths: { "/healthz": { get: {} } },
    internalPaths: {},
  })

  assert(errors.some((error) => error.includes("not mounted: GET /internal/{*tail}")))
  assert(errors.some((error) => error.includes("missing from headless spec: GET /internal/{tail}")))
})

test("route contract rejects method mismatches, undeclared routes, and versioned routes", () => {
  const errors = validateRouteContract({
    contract: {
      schemaVersion: 1,
      routes: [{ path: "/healthz", method: "get", document: "public" }],
    },
    runtimeRoutes: new Set([
      "POST /healthz",
      "GET /api/private",
      "* /ws/v2/events",
    ]),
    publicPaths: { "/healthz": { get: {} } },
    internalPaths: {},
  })

  assert(errors.includes("not mounted: GET /healthz"))
  assert(errors.includes("not declared: POST /healthz"))
  assert(errors.includes("not declared: GET /api/private"))
  assert(errors.includes("not declared: * /ws/v2/events"))
  assert(errors.includes("versioned runtime path is forbidden: /ws/v2/events"))
})

test("an Axum any route satisfies the declared websocket GET contract", () => {
  const errors = validateRouteContract({
    contract: {
      schemaVersion: 1,
      routes: [{ path: "/ws/events", method: "get", document: "public" }],
    },
    runtimeRoutes: new Set(["* /ws/events"]),
    publicPaths: { "/ws/events": { get: {} } },
    internalPaths: {},
  })

  assert.deepEqual(errors, [])
})

test("documents the canonical RPC completion and running envelopes", () => {
  const { desiredPublicSpec, desiredHeadlessSpec } = inspectCommittedContract()
  const genericResponses = desiredPublicSpec.paths["/api/_rpc/{name}"].post.responses
  const concretePath = Object.keys(desiredPublicSpec.paths).find(
    (path) => path.startsWith("/api/_rpc/") && path !== "/api/_rpc/{name}"
  )
  assert.ok(concretePath)
  const concreteResponses = desiredPublicSpec.paths[concretePath].post.responses

  assert.equal(
    genericResponses[200].content["application/json"].schema.$ref,
    "#/components/schemas/RpcCompletedResponse"
  )
  assert.equal(
    genericResponses[202].content["application/json"].schema.$ref,
    "#/components/schemas/RpcRunningResponse"
  )
  assert.equal(genericResponses[415].$ref, "#/components/responses/PublicApiError")
  assert.equal(
    concreteResponses[422].content["application/json"].schema.$ref,
    "#/components/schemas/RpcError"
  )
  assert.deepEqual(concreteResponses[200].content["application/json"].schema.required, [
    "requestId",
    "result",
  ])
  assert.equal(
    concreteResponses[202].content["application/json"].schema.$ref,
    "#/components/schemas/RpcRunningResponse"
  )
  assert.equal(
    desiredHeadlessSpec.paths["/internal/_rpc/{name}"].post.responses[202].content[
      "application/json"
    ].schema.$ref,
    "#/components/schemas/InternalRpcRunningResponse"
  )
})

test("documents canonical identity and owner-management response shapes", () => {
  const { desiredPublicSpec } = inspectCommittedContract()
  const schemas = desiredPublicSpec.components.schemas

  assert.deepEqual(schemas.WhoamiResponse.required, [
    "deviceId",
    "accountId",
    "serverVersion",
    "tlsFingerprint",
  ])
  assert.equal(schemas.WhoamiResponse.properties.device_id, undefined)
  assert.equal(
    desiredPublicSpec.paths["/api/devices"].get.responses[200].content["application/json"].schema
      .$ref,
    "#/components/schemas/DevicesResponse"
  )
  assert.equal(
    desiredPublicSpec.paths["/api/invitations"].post.requestBody.content["application/json"].schema
      .$ref,
    "#/components/schemas/InvitationRequest"
  )
  assert.equal(
    desiredPublicSpec.paths["/api/operations/{operation_id}"].get.responses[200].content[
      "application/json"
    ].schema.$ref,
    "#/components/schemas/OperationSummary"
  )
})

test("documents discovery, media, browser, and A2A wire interfaces", () => {
  const { desiredPublicSpec } = inspectCommittedContract()
  const paths = desiredPublicSpec.paths

  assert.equal(
    paths["/.well-known/agent-card.json"].get.responses[200].content["application/json"].schema
      .$ref,
    "#/components/schemas/A2aAgentCard",
  )
  assert.equal(paths["/.well-known/agent-card.json"].get.responses[401], undefined)

  const media = paths["/api/sessions/{session_id}/media/{hash}"].get
  assert.equal(media.responses[200].content["application/octet-stream"].schema.format, "binary")
  assert.deepEqual(
    media.parameters.find((parameter) => parameter.name === "variant").schema.enum,
    ["thumbnail", "canonical", "original"],
  )
  for (const status of [400, 401, 404, 413, 503]) assert.ok(media.responses[status])

  const browser = paths["/ws/browser/{session_id}"].get
  assert.ok(browser.responses[101])
  assert.equal(
    browser.responses[200].content["application/json"].schema.$ref,
    "#/components/schemas/BrowserSocketTextFrame",
  )
  assert.ok(browser["x-websocket"].inboundFrames)
  assert.ok(browser["x-websocket"].outboundFrames)

  const a2a = paths["/a2a"].post
  assert.equal(
    a2a.requestBody.content["application/json"].schema.$ref,
    "#/components/schemas/A2aJsonRpcRequest",
  )
  assert.equal(
    a2a.responses[200].content["application/json"].schema.$ref,
    "#/components/schemas/A2aJsonRpcResponse",
  )
  assert.ok(a2a.responses[401])
  assert.ok(a2a.responses[422])
})
