import * as v from "valibot"

import { isHandoffEnvelope, type HandoffEnvelope } from "../handoff-envelope"
import { agentWorkerManifestV1Schema } from "../worker-manifest"

export type JsonRpcId = string | number

export interface JsonRpcRequest {
  jsonrpc: "2.0"
  id: JsonRpcId
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcNotification {
  jsonrpc: "2.0"
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcSuccessResponse {
  jsonrpc: "2.0"
  id: JsonRpcId
  result: unknown
}

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0"
  id: JsonRpcId
  error: JsonRpcError
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse

export const RPC_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  protocolError: -32000,
  sessionBusy: -32001,
  sessionNotFound: -32002,
  sessionLocked: -32003,
  configError: -32004,
  permissionDenied: -32005,
  capabilityError: -32006,
  cancelled: -32007,
  timeout: -32008,
  hostNotFound: -32009,
  incompatibleHost: -32010,
  backpressureExceeded: -32011,
  recoveryRequired: -32012,
  callbackFailed: -32013,
  limitExceeded: -32014,
  versionConflict: -32015,
  schemaMismatch: -32016,
  handlerUnavailable: -32017,
  outputInvalid: -32018,
  assetNotFound: -32019,
} as const

export const RPC_PROTOCOL_VERSION = 2 as const

export const RPC_METHODS = [
  "initialize",
  "initialized",
  "shutdown",
  "runtime/status",
  "runtime/capabilities",
  "model/list",
  "model/refresh",
  "auth/status",
  "session/create",
  "session/open",
  "session/list",
  "session/state",
  "session/messages",
  "session/entries",
  "session/rename",
  "session/tag",
  "session/delete",
  "session/export",
  "session/import",
  "session/fork",
  "session/clone",
  "session/tree",
  "session/forest",
  "session/close",
  "agent/create",
  "agent/get",
  "agent/list",
  "agent/update",
  "agent/archive",
  "agent/restore",
  "agent/versions",
  "turn/run",
  "turn/steer",
  "turn/followUp",
  "turn/abort",
  "turn/wait",
  "session/model/set",
  "session/thinking/set",
  "session/permissionMode/set",
  "session/compact",
  "session/compact/undo",
  "permission/respond",
  "elicitation/respond",
  "externalTool/respond",
  "tool/register",
  "tool/unregister",
  "hook/register",
  "hook/unregister",
  "mcp/configure",
  "mcp/status",
  "plugin/reload",
  "skill/reload",
  "task/list",
  "task/stop",
  "task/background",
  "sandbox/status",
  "sandbox/policy/capture",
  "sandbox/policy/restore",
  "trace/subscribe",
  "trace/unsubscribe",
  "trace/export",
  "audit/query",
  "asset/put",
  "asset/register",
  "asset/stat",
  "asset/delete",
] as const

export type RpcMethod = (typeof RPC_METHODS)[number]

/**
 * Methods the SDK must never re-send on its own after a transport drop.
 *
 * The list is explicit rather than inferred from the presence of a
 * `commandId`, because several mutating methods carry no command id at all
 * (`tool/register`, `mcp/configure`, `trace/subscribe`) and inferring would
 * have quietly made them auto-retryable. Everything absent from this set is a
 * read whose repetition changes nothing.
 */
export const SIDE_EFFECTING_METHODS: ReadonlySet<RpcMethod> = new Set<RpcMethod>([
  "initialize",
  "initialized",
  "shutdown",
  "model/refresh",
  "session/create",
  "session/rename",
  "session/tag",
  "session/delete",
  "session/import",
  "session/fork",
  "session/clone",
  "session/close",
  "turn/run",
  "turn/steer",
  "turn/followUp",
  "turn/abort",
  "session/model/set",
  "session/thinking/set",
  "session/permissionMode/set",
  "session/compact",
  "session/compact/undo",
  "permission/respond",
  "elicitation/respond",
  "externalTool/respond",
  "tool/register",
  "tool/unregister",
  "hook/register",
  "hook/unregister",
  "mcp/configure",
  "plugin/reload",
  "skill/reload",
  "task/stop",
  "task/background",
  "sandbox/policy/capture",
  "sandbox/policy/restore",
  "trace/subscribe",
  "trace/unsubscribe",
  "agent/create",
  "agent/update",
  "agent/archive",
  "agent/restore",
  "asset/put",
  "asset/register",
  "asset/delete",
])

/** A read whose repetition after a reconnect changes nothing host-side. */
export function isRetryableMethod(method: RpcMethod): boolean {
  return !SIDE_EFFECTING_METHODS.has(method)
}

export const HOST_REQUEST_METHODS = ["client/tool/invoke", "client/hook/invoke"] as const
export type HostRequestMethod = (typeof HOST_REQUEST_METHODS)[number]

export const HOST_NOTIFICATION_METHODS = [
  "agent/event",
  "tool/progress",
  "trace/event",
  "runtime/diagnostic",
] as const
export type HostNotificationMethod = (typeof HOST_NOTIFICATION_METHODS)[number]

const nonEmptyString = v.pipe(v.string(), v.minLength(1))
const optionalCommandId = v.optional(nonEmptyString)
const emptyParams = v.object({})
const okResult = v.looseObject({ ok: v.literal(true) })
const sessionParams = v.object({ sessionId: nonEmptyString })
const sessionCommandParams = v.looseObject({
  sessionId: nonEmptyString,
  commandId: optionalCommandId,
})
const sessionResult = v.looseObject({ sessionId: nonEmptyString })
const objectResult = v.record(v.string(), v.unknown())
const arrayResult = v.array(v.unknown())
const assetRefSchema = v.object({
  assetId: nonEmptyString,
  digest: nonEmptyString,
  mediaType: nonEmptyString,
  byteLength: v.pipe(v.number(), v.integer(), v.minValue(0)),
  name: v.optional(v.string()),
})

const inputSchema = v.union([
  nonEmptyString,
  v.looseObject({
    prompt: nonEmptyString,
    /** Legacy shape. Accepted by the schema so it can be refused with a reason. */
    attachments: v.optional(v.array(v.unknown())),
    /**
     * Content-addressed references. Raw bytes and host paths never travel in a
     * turn, so neither ends up in the canonical event log.
     */
    assets: v.optional(v.array(assetRefSchema)),
  }),
])

const handoffEnvelopeSchema = v.custom<HandoffEnvelope>(
  isHandoffEnvelope,
  "handoff must be a valid stable ref-only envelope"
)

const jsonSchemaObject = v.record(v.string(), v.unknown())

const toolReferenceSchema = v.looseObject({
  name: nonEmptyString,
  description: v.string(),
  inputSchema: jsonSchemaObject,
  outputSchema: v.optional(jsonSchemaObject),
  sideEffect: v.picklist(["none", "idempotent", "non-idempotent"]),
  schemaDigest: nonEmptyString,
})

const compositionSelectionSchema = v.looseObject({ presetId: nonEmptyString })

/** What a caller may send; identity, version and digest are the host's to mint. */
const agentDefinitionInputSchema = v.looseObject({
  name: nonEmptyString,
  description: v.optional(v.string()),
  composition: compositionSelectionSchema,
  instructions: v.optional(v.object({ append: v.string() })),
  runtimeBindingRef: v.optional(nonEmptyString),
  toolRefs: v.optional(v.array(toolReferenceSchema)),
  output: v.optional(v.object({ schema: jsonSchemaObject, schemaDigest: nonEmptyString })),
  metadata: v.optional(v.record(v.string(), v.union([v.string(), v.number(), v.boolean()]))),
})

const agentDefinitionResult = v.looseObject({
  schemaVersion: v.literal(1),
  agentId: nonEmptyString,
  version: v.pipe(v.number(), v.integer(), v.minValue(1)),
  name: nonEmptyString,
  definitionDigest: nonEmptyString,
  createdAt: nonEmptyString,
  toolRefs: v.array(toolReferenceSchema),
})

const agentSummaryResult = v.looseObject({
  agentId: nonEmptyString,
  name: nonEmptyString,
  latestVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
  definitionDigest: nonEmptyString,
  createdAt: nonEmptyString,
  archivedAt: v.optional(nonEmptyString),
})

const registrationSchema = v.looseObject({
  handlerId: nonEmptyString,
  name: nonEmptyString,
  description: nonEmptyString,
  inputSchema: objectResult,
  outputSchema: v.optional(objectResult),
  sideEffect: v.picklist(["none", "idempotent", "non-idempotent"]),
  timeoutMs: v.optional(v.pipe(v.number(), v.minValue(1))),
})

const hookRegistrationSchema = v.looseObject({
  handlerId: nonEmptyString,
  name: nonEmptyString,
  event: nonEmptyString,
  timeoutPolicy: v.picklist(["continue", "deny", "fail"]),
  timeoutMs: v.optional(v.pipe(v.number(), v.minValue(1))),
})

export const rpcMethodSchemas = {
  initialize: {
    params: v.looseObject({
      client: v.object({ name: nonEmptyString, version: nonEmptyString }),
      protocolVersions: v.pipe(v.array(v.number()), v.minLength(1)),
      capabilities: v.optional(v.array(nonEmptyString), []),
      limits: v.optional(objectResult, {}),
    }),
    result: v.looseObject({
      protocolVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
      host: v.object({ name: nonEmptyString, version: nonEmptyString }),
      runtimeVersion: nonEmptyString,
      instanceId: nonEmptyString,
      methods: v.array(v.picklist(RPC_METHODS)),
      capabilities: v.array(nonEmptyString),
      limits: objectResult,
      workerManifest: v.optional(agentWorkerManifestV1Schema),
    }),
  },
  initialized: { params: emptyParams, result: okResult },
  shutdown: { params: emptyParams, result: okResult },
  "runtime/status": { params: emptyParams, result: objectResult },
  "runtime/capabilities": {
    params: emptyParams,
    result: v.object({
      methods: v.array(v.picklist(RPC_METHODS)),
      capabilities: v.array(nonEmptyString),
    }),
  },
  "model/list": { params: emptyParams, result: v.object({ models: arrayResult }) },
  "model/refresh": { params: emptyParams, result: v.object({ models: arrayResult }) },
  "auth/status": { params: emptyParams, result: objectResult },
  "session/create": {
    params: v.looseObject({
      commandId: optionalCommandId,
      name: v.optional(nonEmptyString),
      cwd: v.optional(nonEmptyString),
      model: v.optional(nonEmptyString),
      permissionMode: v.optional(nonEmptyString),
      tags: v.optional(v.array(nonEmptyString)),
      handoff: v.optional(handoffEnvelopeSchema),
      /**
       * Resolved once, here. `version` is omitted to mean "latest at creation
       * time"; the exact version is then frozen into the session and never
       * follows a later definition.
       */
      agent: v.optional(
        v.object({
          agentId: nonEmptyString,
          version: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
        })
      ),
    }),
    result: v.looseObject({
      sessionId: nonEmptyString,
      spec: objectResult,
      commandId: v.optional(nonEmptyString),
      /** The frozen binding, present when the session was created from an agent. */
      agentBinding: v.optional(
        v.looseObject({
          agentId: nonEmptyString,
          version: v.pipe(v.number(), v.integer(), v.minValue(1)),
          definitionDigest: nonEmptyString,
        })
      ),
    }),
  },
  "session/open": {
    params: sessionParams,
    result: v.looseObject({ sessionId: nonEmptyString, spec: objectResult }),
  },
  "session/list": { params: emptyParams, result: v.object({ sessions: arrayResult }) },
  "session/state": { params: sessionParams, result: objectResult },
  "session/messages": { params: sessionParams, result: v.object({ messages: arrayResult }) },
  "session/entries": {
    params: v.looseObject({
      sessionId: nonEmptyString,
      afterEventId: v.optional(nonEmptyString),
      limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10_000))),
    }),
    result: v.looseObject({
      entries: arrayResult,
      nextEventId: v.optional(nonEmptyString),
      /**
       * Newest persisted event at the time of the call. Replay pages up to
       * exactly this cursor, so live events buffered from the moment the
       * subscription opened can be flushed afterwards with no gap and no
       * interleaving.
       */
      headEventId: v.optional(nonEmptyString),
    }),
  },
  "session/rename": {
    params: v.looseObject({
      sessionId: nonEmptyString,
      name: nonEmptyString,
      commandId: optionalCommandId,
    }),
    result: objectResult,
  },
  "session/tag": {
    params: v.looseObject({
      sessionId: nonEmptyString,
      tags: v.array(nonEmptyString),
      commandId: optionalCommandId,
    }),
    result: objectResult,
  },
  "session/delete": { params: sessionCommandParams, result: objectResult },
  "session/export": { params: sessionParams, result: objectResult },
  "session/import": { params: v.object({ session: objectResult }), result: sessionResult },
  "session/fork": {
    params: v.looseObject({
      sessionId: nonEmptyString,
      turnId: v.optional(nonEmptyString),
      name: v.optional(nonEmptyString),
      commandId: optionalCommandId,
    }),
    result: v.looseObject({ sessionId: nonEmptyString, spec: objectResult }),
  },
  "session/clone": {
    params: v.looseObject({
      sessionId: nonEmptyString,
      name: v.optional(nonEmptyString),
      commandId: optionalCommandId,
    }),
    result: v.looseObject({ sessionId: nonEmptyString, spec: objectResult }),
  },
  "session/tree": { params: sessionParams, result: objectResult },
  "session/forest": { params: emptyParams, result: objectResult },
  "session/close": { params: sessionCommandParams, result: objectResult },
  "agent/create": {
    params: v.looseObject({
      definition: agentDefinitionInputSchema,
      agentId: v.optional(nonEmptyString),
      commandId: optionalCommandId,
    }),
    result: agentDefinitionResult,
  },
  "agent/get": {
    params: v.looseObject({
      agentId: nonEmptyString,
      version: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
    }),
    result: agentDefinitionResult,
  },
  "agent/list": {
    params: v.looseObject({ includeArchived: v.optional(v.boolean()) }),
    result: v.object({ agents: v.array(agentSummaryResult) }),
  },
  "agent/update": {
    params: v.looseObject({
      agentId: nonEmptyString,
      /** Compare-and-swap: the version the caller believes is current. */
      expectedVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
      changes: agentDefinitionInputSchema,
      commandId: optionalCommandId,
    }),
    result: agentDefinitionResult,
  },
  "agent/archive": {
    params: v.looseObject({ agentId: nonEmptyString, commandId: optionalCommandId }),
    result: agentSummaryResult,
  },
  "agent/restore": {
    params: v.looseObject({ agentId: nonEmptyString, commandId: optionalCommandId }),
    result: agentSummaryResult,
  },
  "agent/versions": {
    params: v.object({ agentId: nonEmptyString }),
    result: v.object({ agentId: nonEmptyString, versions: v.array(v.number()) }),
  },
  "turn/run": {
    params: v.looseObject({
      sessionId: nonEmptyString,
      input: inputSchema,
      commandId: optionalCommandId,
      timeoutMs: v.optional(v.pipe(v.number(), v.minValue(1))),
      idleTimeoutMs: v.optional(v.pipe(v.number(), v.minValue(1))),
      maxSteps: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
      includeDiagnostics: v.optional(v.boolean()),
    }),
    result: objectResult,
  },
  "turn/steer": {
    params: v.looseObject({
      sessionId: nonEmptyString,
      input: inputSchema,
      commandId: optionalCommandId,
    }),
    result: objectResult,
  },
  "turn/followUp": {
    params: v.looseObject({
      sessionId: nonEmptyString,
      input: inputSchema,
      commandId: optionalCommandId,
    }),
    result: objectResult,
  },
  "turn/abort": {
    params: v.looseObject({
      sessionId: nonEmptyString,
      commandId: optionalCommandId,
      /** Recorded on the abort receipt and in the audit log. */
      reason: v.optional(v.string()),
    }),
    result: objectResult,
  },
  "turn/wait": {
    params: v.looseObject({
      sessionId: nonEmptyString,
      timeoutMs: v.optional(v.pipe(v.number(), v.minValue(1))),
    }),
    result: objectResult,
  },
  "session/model/set": {
    params: v.looseObject({
      sessionId: nonEmptyString,
      model: nonEmptyString,
      commandId: optionalCommandId,
    }),
    result: objectResult,
  },
  "session/thinking/set": {
    params: v.looseObject({
      sessionId: nonEmptyString,
      level: nonEmptyString,
      commandId: optionalCommandId,
    }),
    result: objectResult,
  },
  "session/permissionMode/set": {
    params: v.looseObject({
      sessionId: nonEmptyString,
      mode: nonEmptyString,
      commandId: optionalCommandId,
    }),
    result: objectResult,
  },
  "session/compact": {
    params: v.looseObject({
      sessionId: nonEmptyString,
      instructions: v.optional(v.string()),
      commandId: optionalCommandId,
    }),
    result: objectResult,
  },
  "session/compact/undo": {
    params: v.looseObject({
      sessionId: nonEmptyString,
      boundaryId: nonEmptyString,
      commandId: optionalCommandId,
    }),
    result: objectResult,
  },
  "permission/respond": {
    params: v.looseObject({
      sessionId: nonEmptyString,
      requestId: nonEmptyString,
      decision: objectResult,
      commandId: optionalCommandId,
    }),
    result: objectResult,
  },
  "elicitation/respond": {
    params: v.looseObject({
      sessionId: nonEmptyString,
      requestId: nonEmptyString,
      response: objectResult,
      commandId: optionalCommandId,
    }),
    result: objectResult,
  },
  "externalTool/respond": {
    params: v.looseObject({
      sessionId: nonEmptyString,
      requestId: nonEmptyString,
      response: objectResult,
      commandId: optionalCommandId,
    }),
    result: objectResult,
  },
  "tool/register": { params: registrationSchema, result: okResult },
  "tool/unregister": { params: v.object({ handlerId: nonEmptyString }), result: okResult },
  "hook/register": { params: hookRegistrationSchema, result: okResult },
  "hook/unregister": { params: v.object({ handlerId: nonEmptyString }), result: okResult },
  "mcp/configure": { params: v.object({ servers: v.array(objectResult) }), result: objectResult },
  "mcp/status": { params: emptyParams, result: objectResult },
  "plugin/reload": {
    params: v.looseObject({ pluginId: v.optional(nonEmptyString) }),
    result: objectResult,
  },
  "skill/reload": {
    params: v.looseObject({ skillId: v.optional(nonEmptyString) }),
    result: objectResult,
  },
  "task/list": {
    params: v.looseObject({ sessionId: v.optional(nonEmptyString) }),
    result: v.object({ tasks: arrayResult }),
  },
  "task/stop": {
    params: v.looseObject({ taskId: nonEmptyString, commandId: optionalCommandId }),
    result: objectResult,
  },
  "task/background": {
    params: v.looseObject({ taskId: nonEmptyString, commandId: optionalCommandId }),
    result: objectResult,
  },
  "sandbox/status": { params: sessionParams, result: objectResult },
  /**
   * Capture the sandbox *resource policy* in force. Deliberately not called a
   * snapshot: no workspace content is captured, and naming it one led callers
   * to expect a filesystem checkpoint that this method has never provided.
   */
  "sandbox/policy/capture": { params: sessionCommandParams, result: objectResult },
  "sandbox/policy/restore": {
    params: v.looseObject({
      sessionId: nonEmptyString,
      policyRecordId: nonEmptyString,
      commandId: optionalCommandId,
    }),
    result: objectResult,
  },
  "trace/subscribe": {
    params: v.looseObject({ sessionId: v.optional(nonEmptyString) }),
    result: objectResult,
  },
  "trace/unsubscribe": {
    params: v.object({ subscriptionId: nonEmptyString }),
    result: okResult,
  },
  "trace/export": {
    params: v.looseObject({
      sessionId: v.optional(nonEmptyString),
      format: v.optional(nonEmptyString),
    }),
    result: objectResult,
  },
  "audit/query": {
    params: v.looseObject({
      sessionId: v.optional(nonEmptyString),
      cursor: v.optional(nonEmptyString),
      limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
    }),
    result: objectResult,
  },
  "asset/put": {
    params: v.looseObject({
      /** Base64 payload. Bounded by the negotiated `maxAssetBytes`. */
      data: nonEmptyString,
      mediaType: nonEmptyString,
      name: v.optional(v.string()),
      commandId: optionalCommandId,
    }),
    result: v.looseObject({
      assetId: nonEmptyString,
      digest: nonEmptyString,
      mediaType: nonEmptyString,
      byteLength: v.pipe(v.number(), v.integer(), v.minValue(0)),
    }),
  },
  "asset/register": {
    params: v.looseObject({
      /** A host-visible path. The host reads it; the client never sends bytes. */
      path: nonEmptyString,
      mediaType: v.optional(nonEmptyString),
      commandId: optionalCommandId,
    }),
    result: v.looseObject({
      assetId: nonEmptyString,
      digest: nonEmptyString,
      mediaType: nonEmptyString,
      byteLength: v.pipe(v.number(), v.integer(), v.minValue(0)),
    }),
  },
  "asset/stat": {
    params: v.object({ assetId: nonEmptyString }),
    result: v.looseObject({
      assetId: nonEmptyString,
      digest: nonEmptyString,
      mediaType: nonEmptyString,
      byteLength: v.pipe(v.number(), v.integer(), v.minValue(0)),
    }),
  },
  "asset/delete": {
    params: v.looseObject({ assetId: nonEmptyString, commandId: optionalCommandId }),
    result: okResult,
  },
} satisfies Record<RpcMethod, { params: v.GenericSchema; result: v.GenericSchema }>

export const hostRequestSchemas = {
  "client/tool/invoke": {
    params: v.looseObject({
      handlerId: nonEmptyString,
      toolCallId: nonEmptyString,
      sessionId: nonEmptyString,
      runId: nonEmptyString,
      attemptId: nonEmptyString,
      idempotencyKey: nonEmptyString,
      input: v.unknown(),
    }),
    result: v.looseObject({
      ok: v.boolean(),
      output: v.optional(v.unknown()),
      error: v.optional(objectResult),
    }),
  },
  "client/hook/invoke": {
    params: v.looseObject({
      handlerId: nonEmptyString,
      invocationId: nonEmptyString,
      sessionId: nonEmptyString,
      runId: nonEmptyString,
      attemptId: nonEmptyString,
      payload: v.unknown(),
    }),
    result: v.looseObject({
      ok: v.boolean(),
      output: v.optional(v.unknown()),
      error: v.optional(objectResult),
    }),
  },
} satisfies Record<HostRequestMethod, { params: v.GenericSchema; result: v.GenericSchema }>

export type RpcMethodMap = {
  [Method in RpcMethod]: {
    params: v.InferOutput<(typeof rpcMethodSchemas)[Method]["params"]>
    result: v.InferOutput<(typeof rpcMethodSchemas)[Method]["result"]>
  }
}

export type HostRequestMethodMap = {
  [Method in HostRequestMethod]: {
    params: v.InferOutput<(typeof hostRequestSchemas)[Method]["params"]>
    result: v.InferOutput<(typeof hostRequestSchemas)[Method]["result"]>
  }
}

export class RpcValidationError extends Error {
  readonly issues: readonly v.BaseIssue<unknown>[]

  constructor(context: string, issues: readonly v.BaseIssue<unknown>[]) {
    const detail = issues
      .map((issue) => {
        const path = issue.path?.map((item) => String(item.key)).join(".")
        return path ? `${path}: ${issue.message}` : issue.message
      })
      .join("; ")
    super(`${context}: ${detail}`)
    this.name = "RpcValidationError"
    this.issues = issues
  }
}

function parseSchema<TSchema extends v.GenericSchema>(
  context: string,
  schema: TSchema,
  value: unknown
): v.InferOutput<TSchema> {
  const parsed = v.safeParse(schema, value)
  if (!parsed.success) throw new RpcValidationError(context, parsed.issues)
  return parsed.output
}

export function parseRpcMethodParams<Method extends RpcMethod>(
  method: Method,
  params: unknown
): RpcMethodMap[Method]["params"] {
  return parseSchema(`${method} params`, rpcMethodSchemas[method].params, params)
}

export function parseRpcMethodResult<Method extends RpcMethod>(
  method: Method,
  result: unknown
): RpcMethodMap[Method]["result"] {
  return parseSchema(`${method} result`, rpcMethodSchemas[method].result, result)
}

export function parseHostRequestParams<Method extends HostRequestMethod>(
  method: Method,
  params: unknown
): HostRequestMethodMap[Method]["params"] {
  return parseSchema(`${method} params`, hostRequestSchemas[method].params, params)
}

export function parseHostRequestResult<Method extends HostRequestMethod>(
  method: Method,
  result: unknown
): HostRequestMethodMap[Method]["result"] {
  return parseSchema(`${method} result`, hostRequestSchemas[method].result, result)
}

export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (!value || typeof value !== "object") return false
  const obj = value as Record<string, unknown>
  return (
    obj.jsonrpc === "2.0" &&
    (typeof obj.id === "string" || typeof obj.id === "number") &&
    typeof obj.method === "string"
  )
}

export function isJsonRpcNotification(value: unknown): value is JsonRpcNotification {
  if (!value || typeof value !== "object") return false
  const obj = value as Record<string, unknown>
  return obj.jsonrpc === "2.0" && typeof obj.method === "string" && obj.id === undefined
}

export function makeSuccessResponse(id: JsonRpcId, result: unknown): JsonRpcSuccessResponse {
  return { jsonrpc: "2.0", id, result }
}

export function makeErrorResponse(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown
): JsonRpcErrorResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } }
}

export function makeNotification(
  method: string,
  params?: Record<string, unknown>
): JsonRpcNotification {
  return { jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) }
}
