import assert from "node:assert/strict"
import test from "node:test"

import {
  classifyCommands,
  ensureOperationPathParameters,
  extractCommandArgumentSchemas,
  extractRuntimeRoutePaths,
  inspectCommittedContract,
  reconcileRpcPaths,
  validateRouteContract,
} from "./gen-companion-api.mjs"

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

test("reconciles legacy RPC paths into canonical public and isolated internal specs", () => {
  const publicPaths = {
    "/api/v1/_rpc/{name}": { post: { operationId: "rpcDispatch" } },
    "/api/v1/_rpc/public_read": { post: { operationId: "rpcPublicRead" } },
    "/api/v1/_rpc/service_write": { post: { operationId: "rpcServiceWrite" } },
  }
  const internalPaths = {}

  const result = reconcileRpcPaths({
    publicPaths,
    internalPaths,
    manifest,
    remoteNames: new Set(["public_read", "service_write"]),
  })

  assert.deepEqual(Object.keys(result.publicPaths).sort(), [
    "/api/_rpc/public_read",
    "/api/_rpc/{name}",
    "/api/v1/_rpc/{name}",
  ])
  assert.equal(result.publicPaths["/api/v1/_rpc/{name}"].post.deprecated, true)
  assert.deepEqual(Object.keys(result.internalPaths).sort(), [
    "/internal/_rpc/public_read",
    "/internal/_rpc/service_write",
    "/internal/_rpc/{name}",
  ])
  assert.equal(result.internalPaths["/internal/_rpc/service_write"].post.operationId, "rpcServiceWrite")
})

test("extracts literal Axum route paths across multiline registrations", () => {
  const source = `
    Router::new()
      .route("/healthz", get(healthz))
      .route(
        "/internal/_rpc/{name}",
        post(rpc_handler),
      );
  `

  assert.deepEqual([...extractRuntimeRoutePaths(source)].sort(), [
    "/healthz",
    "/internal/_rpc/{name}",
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
    runtimePaths: new Set(["/healthz"]),
    publicPaths: { "/healthz": { get: {} } },
    internalPaths: {},
  })

  assert(errors.some((error) => error.includes("not mounted: /internal/{*tail}")))
  assert(errors.some((error) => error.includes("missing from headless spec: GET /internal/{tail}")))
})
