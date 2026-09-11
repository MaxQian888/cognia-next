import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import Ajv2020 from "ajv/dist/2020.js"
import { parse as parseYaml } from "yaml"
import { buildCompanionRequestSchemaContracts } from "./companion-request-schema-contracts.mjs"

test("IM relay admits transcript provenance on both protocol planes", () => {
  const inspected = inspectCommittedContract()
  const schemas = [
    JSON.parse(readFileSync(new URL("../../protocol/companion-request-schemas.json", import.meta.url), "utf8")).commands.connector_enqueue_outbound,
    inspected.desiredHeadlessSpec.paths["/internal/_rpc/connector_enqueue_outbound"].post.requestBody.content["application/json"].schema,
  ]
  const body = {
    adapterId: "adapter", conversationKey: "telegram:adapter:chat", sessionId: "session", clientMessageId: "message",
    request: { conversationRef: { platform: "telegram", adapterId: "adapter" }, segments: [{ type: "text", text: "reply" }], metadata: { idempotencyKey: "once" } },
  }
  const metadata = { replyTo: { messageId: "parent", preview: "earlier", platformMessageId: "remote" }, templateRun: { templateId: "template", version: "1", text: "reply", params: {} } }
  for (const schema of schemas) {
    const validate = new Ajv2020({ strict: false }).compile(schema)
    for (const messageMetadata of [undefined, {}, metadata, { replyTo: metadata.replyTo }, { templateRun: metadata.templateRun }]) {
      assert.equal(validate({ ...body, ...(messageMetadata ? { messageMetadata } : {}) }), true, JSON.stringify(validate.errors))
    }
    for (const messageMetadata of [null, [], { unknown: true }, { replyTo: {} }, { templateRun: {} }]) {
      assert.equal(validate({ ...body, messageMetadata }), false)
    }
  }
})

test("scheduler response contracts admit every persisted task type", () => {
  const source = readFileSync(new URL("../../types/scheduler/index.ts", import.meta.url), "utf8")
  const union = source.split("export type ScheduledTaskType =")[1].split(/\nexport /)[0]
  const types = [...union.matchAll(/^\s*\| "([^"]+)"/gm)].map((match) => match[1])
  const catalog = JSON.parse(
    readFileSync(new URL("../../protocol/companion-response-schemas.json", import.meta.url), "utf8"),
  )
  assert.deepEqual([...catalog.$defs.ScheduledTaskType.enum].sort(), [...types].sort())
  const request = buildCompanionRequestSchemaContracts().get("scheduled_task_create")
  assert.deepEqual([...request.properties.input.properties.type.enum].sort(), [...types].sort())
})

import {
  buildHeadlessAsyncApi,
  buildHostCommandCatalog,
  classifyHostCommand,
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

test("classifies host commands into one stable domain", () => {
  assert.equal(classifyHostCommand("session_list"), "sessions")
  assert.equal(classifyHostCommand("agent_task_start"), "agents")
  assert.equal(classifyHostCommand("task_workspace_get"), "tasks")
  assert.equal(classifyHostCommand("issue_apply_action"), "tasks")
  assert.equal(classifyHostCommand("workflow_create"), "automation")
  assert.equal(classifyHostCommand("connectors_health"), "connectors")
  assert.equal(classifyHostCommand("plugin_list"), "extensions")
  assert.equal(classifyHostCommand("memory_search"), "knowledge")
  assert.equal(classifyHostCommand("git_status"), "development")
  assert.equal(classifyHostCommand("host_capabilities"), "system")
  assert.equal(classifyHostCommand("video_analyze"), "development")
  assert.equal(classifyHostCommand("plugin_media_export_video"), "development")
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
  assert.equal(hostResourceForCommand("video_get_info"), "media")
  assert.equal(hostResourceForCommand("plugin_media_read_chunk"), "media")
})

test("media requests preserve the native contract and bound binary transfer chunks", () => {
  const schemas = buildCompanionRequestSchemaContracts()
  const ajv = new Ajv2020()
  const frame = ajv.compile(schemas.get("plugin_media_get_video_frame"))
  for (const format of [undefined, "rgba", "png"]) {
    assert.equal(frame({ sourceToken: "source", time: 0, ...(format ? { format } : {}) }), true)
  }
  assert.equal(frame({ sourceToken: "source", time: 0, format: "jpeg" }), false)
  const analysisFrame = ajv.compile(schemas.get("plugin_media_read_analysis_frame"))
  assert.equal(analysisFrame({ outputDirectory: "/owned/analysis", path: "/owned/analysis/frame.png" }), true)
  assert.equal(analysisFrame({ path: "/owned/analysis/frame.png" }), false)
  assert.equal(analysisFrame({ outputDirectory: "/owned/analysis", path: "" }), false)
  const chunk = ajv.compile(schemas.get("plugin_media_read_chunk"))
  assert.equal(chunk({ transferId: "owned-transfer", offset: 0 }), true)
  assert.equal(chunk({ transferId: "owned-transfer", offset: 65_536, length: 65_536 }), true)
  assert.equal(chunk({ transferId: "owned-transfer", offset: 0, length: 65_536, encoding: "base64" }), true)
  assert.equal(chunk({ transferId: "owned-transfer", offset: 0, encoding: "hex" }), false)
  for (const invalid of [
    { transferId: "", offset: 0 },
    { transferId: "owned-transfer", offset: -1 },
    { transferId: "owned-transfer", offset: 0, length: 65_537 },
    { transferId: "owned-transfer", offset: 0, length: 0 },
  ]) assert.equal(chunk(invalid), false)
  const clip = { sourceToken: "source", startTime: 0, endTime: 1, volume: 1, playbackSpeed: 1 }
  const render = ajv.compile(schemas.get("plugin_media_export_video"))
  const request = {
    clips: [clip],
    options: { format: "mp4", resolution: "720p", fps: 30, quality: "high" },
    destinationPath: "/workspace/output.mp4",
    overwrite: false,
  }
  assert.equal(render(request), true)
  assert.equal(render({ ...request, clips: [] }), false)
  assert.equal(render({ ...request, clips: Array.from({ length: 65 }, () => clip) }), false)
  assert.equal(render({ ...request, arbitraryPath: "/outside" }), false)
})

test("media publishes bounded binary handles and chunk responses rather than oversized JSON", () => {
  const catalog = JSON.parse(readFileSync(
    new URL("../../protocol/companion-response-schemas.json", import.meta.url), "utf8",
  ))
  const ajv = new Ajv2020()
  for (const name of ["plugin_media_get_video_frame", "plugin_media_export_video", "plugin_media_read_analysis_frame"]) {
    const validate = ajv.compile({ ...catalog.commands[name], $defs: catalog.$defs })
    assert.equal(validate({ transferId: "owned-transfer", byteLength: 128 * 1024 * 1024 }), true)
    assert.equal(validate({ transferId: "owned-transfer", byteLength: 3, chunkEncoding: "base64" }), true)
    assert.equal(validate({ transferId: "owned-transfer", byteLength: 128 * 1024 * 1024 + 1 }), false)
    assert.equal(validate([0, 1, 2]), false)
  }
  const chunk = ajv.compile(catalog.commands.plugin_media_read_chunk)
  assert.equal(chunk([0, 255]), true)
  assert.equal(chunk([256]), false)
  assert.equal(chunk(Array(65_537).fill(0)), false)
  assert.equal(chunk("AQID"), true)
  assert.equal(chunk("!@#$"), false)
  assert.equal(chunk(Buffer.alloc(65_537).toString("base64") + "AAAA"), false)
})

test("media grants distinguish observation from confined processing without administrative leases", () => {
  const catalog = JSON.parse(readFileSync(
    new URL("../../protocol/companion-commands.json", import.meta.url), "utf8",
  ))
  const writes = new Set([
    "plugin_media_concatenate_videos", "plugin_media_export_video", "video_analyze",
    "video_trim", "video_cleanup_analysis",
  ])
  const commands = catalog.commands.filter(({ name }) => name.startsWith("plugin_media_") || name.startsWith("video_"))
  assert.equal(commands.length, 12)
  for (const command of commands) {
    assert.equal(command.target, "execution")
    assert.deepEqual(command.transports, ["http", "websocket", "webrtc"])
    assert.equal(command.capability, writes.has(command.name) ? "workspace.write" : "host.observe")
    assert.equal(command.risk, writes.has(command.name) ? "high" : "low")
    // Rendering only processes authorized tokens and confines destination paths;
    // it is a workspace operation, not a host-administration step-up.
    assert.equal(command.approval, "none")
    assert.equal(command.idempotency, writes.has(command.name) ? "required" : "structural")
  }
})

test("generated sync requests and responses preserve optional bounded opaque cursors", () => {
  const inspected = inspectCommittedContract()
  const command = inspected.desiredHostCommandCatalog.commands.find((entry) => entry.name === "sync_pull")
  assert.ok(command)
  const ajv = new Ajv2020({ validateFormats: false })
  ajv.addKeyword("x-cognia-wire-source")
  const request = ajv.compile(command.inputSchema)
  for (const cursor of [undefined, "", "opaque-position", "x".repeat(4096)]) {
    assert.equal(request({ table: "messages", since: 0, ...(cursor === undefined ? {} : { cursor }) }), true)
  }
  for (const cursor of [null, 42, "x".repeat(4097)]) {
    assert.equal(request({ table: "messages", since: 0, cursor }), false)
  }
  const response = ajv.compile(command.outputSchema)
  const delta = { rows: [], deleted_ids: [], next_since: 12 }
  assert.equal(response(delta), true)
  assert.equal(response({ ...delta, next_cursor: "", has_more: false }), true)
  assert.equal(response({ ...delta, next_cursor: "x".repeat(4096), has_more: true }), true)
  for (const next_cursor of [null, 42, "x".repeat(4097)]) {
    assert.equal(response({ ...delta, next_cursor }), false)
  }
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

  // Both data planes answer the one page envelope (ADR-0175 B3): the direct
  // store adds `total`, the bridge does not, and neither leaks its offset.
  const validate = new Ajv2020().compile(command.outputSchema)
  assert.equal(
    validate({
      items: [
        { id: "direct", title: "Direct", kind: "direct", createdAt: 1, updatedAt: 2 },
      ],
      nextPageToken: "bzoyMA",
      total: 1,
    }),
    true,
  )
  assert.equal(
    validate({
      items: [
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
    }),
    true,
  )
  assert.equal(validate({ rows: [], next_offset: 1, has_more: true }), false)
})

test("declares every request schema instead of reading one back out of a match arm", () => {
  const inspected = inspectCommittedContract()

  // ADR-0175 B4. A shape recovered by parsing `required(&args, "x")` calls is
  // whatever the arm happened to compile to, not a contract anybody reviewed,
  // and it silently changes shape when the arm is refactored. The generator
  // refuses one now, so this asserts the refusal is not merely available but
  // currently satisfied.
  const inferred = inspected.errors.filter((error) =>
    error.includes("inferred from the dispatch arm"),
  )
  assert.deepEqual(inferred, [])

  const sources = new Set()
  for (const path of Object.values(inspected.desiredHeadlessSpec.paths)) {
    for (const operation of Object.values(path)) {
      const source = operation?.["x-cognia-request-schema-source"]
      if (source) sources.add(source)
    }
  }
  assert.deepEqual([...sources].sort(), ["contract", "zod-contract"])
})

test("gives the service plane its own request shape only where the planes differ", () => {
  const catalog = JSON.parse(
    readFileSync(new URL("../../protocol/companion-request-schemas.json", import.meta.url), "utf8"),
  )
  const servicePlane = catalog.servicePlaneCommands ?? {}
  const inspected = inspectCommittedContract()

  // The device plane confines a git command to a workspace: `repoPath` and the
  // other absolute host paths are replaced by `workspaceId` plus a path
  // relative to it. The loopback brain runs on the host and names the path
  // directly, so its shape is not the device one with fields added — it is the
  // one the confinement was applied to. Any command whose planes agree must
  // NOT be listed here, or the entry silently becomes the only definition.
  for (const [name, schema] of Object.entries(servicePlane)) {
    const device = catalog.commands[name]
    assert.ok(device, `service-plane shape without a device shape: ${name}`)
    assert.notDeepEqual(
      schema,
      device,
      `${name} lists a service-plane shape identical to its device shape`,
    )
    assert.ok(
      inspected.desiredHeadlessSpec.paths[`/internal/_rpc/${name}`],
      `service-plane shape for a command the service plane does not serve: ${name}`,
    )
  }
  assert.deepEqual(
    Object.keys(servicePlane).filter((name) => !name.startsWith("git_")),
    [],
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

test("refuses to emit an AsyncAPI that does not cover every bridge frame", () => {
  const inspected = inspectCommittedContract()
  const fixture = JSON.parse(inspected.desiredBridgeFixtureSource)

  // A frame type nobody documented is exactly the shape the worker frames had.
  fixture.frames.somethingNew = { v: 3, type: "worker_reset" }
  assert.throws(
    () =>
      buildHeadlessAsyncApi(inspected.contract, inspected.desiredHostCommandCatalog, fixture),
    /undocumented: worker_reset/,
  )

  // And the reverse: a documented message the fixture never carries is a claim
  // about a wire nobody speaks.
  const withoutWorkers = JSON.parse(inspected.desiredBridgeFixtureSource)
  delete withoutWorkers.frames.workerAttach
  assert.throws(
    () =>
      buildHeadlessAsyncApi(
        inspected.contract,
        inspected.desiredHostCommandCatalog,
        withoutWorkers,
      ),
    /no golden fixture frame: worker_attach/,
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

  // Every frame the two languages already agree on must be documented. The
  // spec listed seven of ten for a long time: `worker_attach`, `worker_frame`
  // and `worker_detach` were live in protocol.ts, in ws_bridge.rs and in this
  // very fixture, and the only assertion here read two entries to check a hash.
  const documentedFrameTypes = new Set(
    Object.values(asyncApi.channels.headlessBridge.messages).map(
      (ref) => asyncApi.components.messages[ref.$ref.split("/").pop()].payload.properties.type.const,
    ),
  )
  const fixtureFrameTypes = new Set(
    Object.values(bridgeFixture.frames).map((frame) => frame.type),
  )
  assert.deepEqual(
    [...fixtureFrameTypes].sort(),
    [...documentedFrameTypes].sort(),
    "the AsyncAPI bridge channel must document exactly the fixture's frame types",
  )
  assert.ok(fixtureFrameTypes.size >= 10, `expected all ten frame types, saw ${fixtureFrameTypes.size}`)

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
  // Paging is pageSize/pageToken (ADR-0175 B3), both optional, and the old
  // names are gone from the contract rather than merely deprecated.
  assert.equal(schema.required, undefined)
  assert.deepEqual(Object.keys(schema.properties).sort(), ["pageSize", "pageToken", "updatedBefore"])
  assert.equal(schema.properties.pageSize.type, "integer")
  assert.equal(schema.properties.pageSize.minimum, 1)
  assert.equal(schema.properties.pageSize.maximum, 1000)
  assert.equal(schema.properties.pageToken.type, "string")
  assert.equal(schema.properties.pageToken.minLength, 1)
  assert.equal(schema.properties.updatedBefore.type, "integer")
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
  contractVersion: 3,
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

  // `has(arm)` is all the coverage check asks of the dispatch sources. A Set
  // answers it for a fixture. The reverse direction (an arm with no
  // descriptor) is no longer reported: with the allowlist rendered from the
  // contract such an arm is unreachable, not a defect.
  const errors = validateCommandCoverage(invalid, new Set(["public_read"]))

  assert(errors.includes("mutation must use durable idempotency: service_write"))
  assert(errors.includes("service command must be internal-only: service_write"))
  assert(errors.includes("remote command has no canonical dispatch arm: service_write"))
  assert(!errors.some((error) => error.includes("dispatch arm has no command descriptor")))
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

test("a nested router's routes are collected under the prefix the listener mounts them at", () => {
  // Seventeen live routes were invisible to the contract because their routers
  // are merged after `with_state` from files the scan never opened, and their
  // paths are relative to a `nest()` prefix.
  const nested = `
    Router::new()
      .route("/health", get(health))
      .route("/webhook/{adapter_type}/{adapter_id}", any(webhook));
  `

  assert.deepEqual([...extractRuntimeRoutes(nested, "/connectors")].sort(), [
    "* /connectors/webhook/{adapter_type}/{adapter_id}",
    "GET /connectors/health",
  ])

  // A root-mounted router is unchanged.
  assert.deepEqual([...extractRuntimeRoutes(nested)].sort(), [
    "* /webhook/{adapter_type}/{adapter_id}",
    "GET /health",
  ])
})

test("a declared mount that the server never nests is reported, not silently trusted", () => {
  const nested = `Router::new().route("/health", get(health));`
  const server = `Router::new().nest("/connectors", connectors::router());`

  assert.deepEqual(
    collectRuntimeRoutes([["connectors.rs", nested, "/connectors"]], server).errors,
    [],
  )

  // A scan describing a surface nobody serves reads exactly like coverage.
  assert.deepEqual(
    collectRuntimeRoutes([["connectors.rs", nested, "/typo"]], server).errors,
    ["declared route mount is never nested in server.rs: /typo (connectors.rs)"],
  )
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
  // A still-running command answers with the Operation document (ADR-0175 B3).
  assert.equal(
    genericResponses[202].content["application/json"].schema.$ref,
    "#/components/schemas/Operation"
  )
  assert.equal(genericResponses[415].$ref, "#/components/responses/PublicApiError")
  assert.equal(genericResponses[410].$ref, "#/components/responses/PublicApiError")
  // Every refusal is one RFC 9457 document (ADR-0175), served as problem+json.
  for (const status of [400, 401, 403, 404, 409, 410, 415, 422, 428, 429, 500, 503]) {
    const response = concreteResponses[status]
    assert.ok(response, `concrete RPC documents ${status}`)
    assert.equal(
      response.content["application/problem+json"].schema.$ref,
      "#/components/schemas/Problem",
      `${status} is a problem document`
    )
    assert.equal(response.content["application/json"], undefined, `${status} has no legacy body`)
    assert.ok(response.headers["x-request-id"], `${status} mirrors the request id`)
  }
  assert.deepEqual(concreteResponses[200].content["application/json"].schema.required, [
    "requestId",
    "result",
  ])
  assert.equal(
    concreteResponses[202].content["application/json"].schema.$ref,
    "#/components/schemas/Operation"
  )
  assert.equal(
    desiredHeadlessSpec.paths["/internal/_rpc/{name}"].post.responses[202].content[
      "application/json"
    ].schema.$ref,
    "#/components/schemas/Operation"
  )
})

test("documents one Operation document on both planes and keeps the old names as aliases", () => {
  const { desiredPublicSpec, desiredHeadlessSpec } = inspectCommittedContract()
  for (const spec of [desiredPublicSpec, desiredHeadlessSpec]) {
    const operation = spec.components.schemas.Operation
    assert.deepEqual(operation.required, ["id", "done", "status", "metadata"])
    assert.equal(operation.additionalProperties, false)
    assert.equal(operation.properties.error.$ref, "#/components/schemas/Problem")
    assert.deepEqual(operation.properties.metadata.required, ["createdAt", "updatedAt"])
    assert.ok(operation.properties.status.enum.includes("running"))
    assert.ok(operation.properties.status.enum.includes("succeeded"))
  }
  const publicSchemas = desiredPublicSpec.components.schemas
  assert.deepEqual(publicSchemas.RpcRunningResponse, { $ref: "#/components/schemas/Operation" })
  assert.deepEqual(publicSchemas.OperationSummary, { $ref: "#/components/schemas/Operation" })
  const internalSchemas = desiredHeadlessSpec.components.schemas
  assert.deepEqual(internalSchemas.InternalRpcRunningResponse, {
    $ref: "#/components/schemas/Operation",
  })
  assert.deepEqual(internalSchemas.InternalOperationSummary, {
    $ref: "#/components/schemas/Operation",
  })
  assert.equal(
    desiredHeadlessSpec.paths["/internal/operations/{operation_id}"].get.responses[200].content[
      "application/json"
    ].schema.$ref,
    "#/components/schemas/Operation"
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
    "contractVersion",
    "catalogHash",
    "catalogUrl",
  ])
  assert.equal(schemas.WhoamiResponse.properties.device_id, undefined)
  // The token is the device handshake, so it names the contract too.
  assert.deepEqual(schemas.DeviceTokenResponse.required, [
    "accessToken",
    "tokenType",
    "expiresIn",
    "contractVersion",
    "catalogHash",
  ])
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
    "#/components/schemas/Operation"
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

test("one error document, one discovery shape, on both planes (ADR-0175)", () => {
  const { desiredPublicSpec, desiredHeadlessSpec, manifest } = inspectCommittedContract()
  for (const [label, spec] of [
    ["public", desiredPublicSpec],
    ["headless", desiredHeadlessSpec],
  ]) {
    const problem = spec.components.schemas.Problem
    assert.ok(problem, `${label}: Problem component`)
    assert.deepEqual(problem.required, [
      "type",
      "title",
      "status",
      "detail",
      "code",
      "requestId",
      "retryable",
      "details",
    ])
    assert.equal(problem.additionalProperties, false)
    // The old name survives only as an alias, so nothing can document the
    // legacy flat or nested envelope again.
    assert.deepEqual(spec.components.schemas.RpcError, { $ref: "#/components/schemas/Problem" })
    assert.equal(spec.components.schemas.CanonicalApiError, undefined)
    assert.equal(spec.components.schemas.ServiceTokenError, undefined)
    for (const response of Object.values(spec.components.responses)) {
      if (!response.content) continue
      const media = Object.keys(response.content)
      if (media.includes("application/problem+json")) {
        assert.equal(response.content["application/problem+json"].schema.$ref, "#/components/schemas/Problem")
        assert.ok(response.headers?.["x-request-id"])
      }
    }
    assert.equal(
      spec.components.schemas.CommandCatalog.properties.commands.items.$ref,
      "#/components/schemas/CommandDescriptor"
    )
    assert.deepEqual(
      Object.keys(spec.components.schemas.CommandDescriptor.properties).sort(),
      Object.keys(manifest.commands[0]).sort(),
      `${label}: the descriptor schema names exactly the contract's fields`
    )
  }
  for (const [name, content] of [
    ["PublicApiError", desiredPublicSpec.components.responses.PublicApiError.content],
    ["AuthenticationRejected", desiredPublicSpec.components.responses.AuthenticationRejected.content],
    ["HeadlessRpcError", desiredHeadlessSpec.components.responses.HeadlessRpcError.content],
    ["ServiceTokenRejected", desiredHeadlessSpec.components.responses.ServiceTokenRejected.content],
  ]) {
    assert.deepEqual(Object.keys(content), ["application/problem+json"], name)
  }

  const device = desiredPublicSpec.paths["/api/catalog"].get
  const service = desiredHeadlessSpec.paths["/internal/catalog"].get
  for (const [label, operation] of [
    ["device", device],
    ["service", service],
  ]) {
    assert.ok(operation, `${label} catalog route`)
    assert.equal(
      operation.responses[200].content["application/json"].schema.$ref,
      "#/components/schemas/CommandCatalog"
    )
    assert.ok(operation.responses[200].headers.ETag, `${label}: ETag`)
    assert.ok(operation.responses[304], `${label}: 304`)
    assert.ok(operation.parameters.some((parameter) => parameter.name === "If-None-Match"))
  }
  assert.deepEqual(device.security, [{ dpopAccess: [] }])
  assert.equal(device.responses[401].$ref, "#/components/responses/AuthenticationRejected")
  assert.equal(service.responses[401].$ref, "#/components/responses/ServiceTokenRejected")
  assert.equal(
    desiredPublicSpec.components.schemas.WhoamiResponse.properties.catalogUrl.type,
    "string"
  )
})

test("the host catalog and the Rust table carry the manifest's contract version", () => {
  const inspected = inspectCommittedContract()
  assert.equal(inspected.desiredHostCommandCatalog.schemaVersion, inspected.manifest.contractVersion)
  assert.match(
    inspected.desiredKnownCommandsRustSource,
    new RegExp(`^pub const CONTRACT_VERSION: u32 = ${inspected.manifest.contractVersion};$`, "m")
  )
  assert.match(
    inspected.desiredKnownCommandsRustSource,
    new RegExp(`CATALOG_HASH: &str = "${inspected.desiredHostCommandCatalog.catalogHash}"`)
  )
  const rows = inspected.desiredKnownCommandsRustSource.match(/^\s+WireCommand \{ name: "/gm).length
  assert.equal(rows, inspected.manifest.commands.length)
  // The remote set is a fact of the contract: every non-client descriptor.
  assert.equal(
    inspected.remoteNames.size,
    inspected.manifest.commands.filter((command) => command.target !== "client").length
  )
})


test("gateway task deletion is granted as agent control and validates task identity on both API planes", () => {
  const inspected = inspectCommittedContract()
  const name = "external_agent_delete_gateway_task"
  const command = inspected.manifest.commands.find((entry) => entry.name === name)
  assert.equal(command.capability, "process.spawn")
  assert.equal(command.idempotency, "required")
  assert.equal(command.target, "execution")
  assert.ok(inspected.remoteNames.has(name))
  for (const [spec, prefix] of [[inspected.desiredPublicSpec, "/api/_rpc/"], [inspected.desiredHeadlessSpec, "/internal/_rpc/"]]) {
    const operation = spec.paths[`${prefix}${name}`].post
    assert.ok(operation)
    const validate = new Ajv2020({ strict: false }).compile(operation.requestBody.content["application/json"].schema)
    assert.equal(validate({ task_id: "task-a_1" }), true, JSON.stringify(validate.errors))
    assert.equal(validate({ taskId: "task-a_1" }), true, JSON.stringify(validate.errors))
    for (const body of [{}, { task_id: "../other" }, { task_id: "" }, { task_id: "task", path: "/tmp" }]) {
      assert.equal(validate(body), false)
    }
  }
  const responses = JSON.parse(readFileSync(new URL("../../protocol/companion-response-schemas.json", import.meta.url), "utf8"))
  assert.equal(responses.commands[name].$ref, "#/$defs/NullResult")
})
