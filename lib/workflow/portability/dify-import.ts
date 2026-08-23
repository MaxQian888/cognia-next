import { parse as parseYaml } from "yaml"

import { getModelConfig } from "@cognia/provider-types/provider"
import { getDb } from "@/lib/db/schema"
import { validateWorkflow } from "@/lib/workflow/definition/validate"
import type {
  DifyImportIssue,
  DifyImportPreflight,
  DifyImportResolver,
  DifyImportWarning,
} from "@/types/workflow/dify-import"
import {
  DEFAULT_WORKFLOW_SETTINGS,
  type VisualWorkflow,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowNodeErrorHandling,
} from "@/types/workflow/visual"

const PROFILE = "dify-1.16" as const
const CURRENT_DSL_VERSION = [0, 7, 0] as const
const SYNTHETIC_START_TYPES = new Set(["iteration-start", "loop-start"])

type JsonRecord = Record<string, unknown>

interface ParsedDifyDsl {
  version: string
  app: JsonRecord
  workflow: JsonRecord
  graph: JsonRecord
  dependencies: JsonRecord[]
}

interface ImportContext {
  startNodeIds: Set<string>
  blockers: DifyImportIssue[]
  warnings: DifyImportWarning[]
  resolver: DifyImportResolver
  questionRoutes: Map<string, string>
  ifElseIds: Set<string>
}

const asRecord = (value: unknown): JsonRecord | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : undefined

const asRecords = (value: unknown): JsonRecord[] =>
  Array.isArray(value) ? value.map(asRecord).filter((item): item is JsonRecord => !!item) : []

const stringValue = (value: unknown): string => (typeof value === "string" ? value : "")

function blocker(code: DifyImportIssue["code"], path: string, message: string): DifyImportIssue {
  return { code, path, message }
}

function parseVersion(value: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined
}

function compareVersion(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return 0
}

function parseDifyDsl(source: string): ParsedDifyDsl {
  let value: unknown
  try {
    value = parseYaml(source, { uniqueKeys: true })
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "Dify DSL YAML is invalid")
  }
  const envelope = asRecord(value)
  const app = asRecord(envelope?.app)
  const workflow = asRecord(envelope?.workflow)
  const graph = asRecord(workflow?.graph)
  if (
    !envelope ||
    envelope.kind !== "app" ||
    typeof envelope.version !== "string" ||
    !app ||
    !workflow ||
    !graph ||
    !Array.isArray(graph.nodes) ||
    !Array.isArray(graph.edges)
  ) {
    throw new Error("Dify DSL must contain kind=app, app, and workflow.graph nodes/edges")
  }
  return {
    version: envelope.version,
    app,
    workflow,
    graph,
    dependencies: asRecords(envelope.dependencies),
  }
}

async function sha256(value: string): Promise<string> {
  const result = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function exactPluginIdentity(uniqueIdentifier: string): { id: string; version?: string } {
  const withoutDigest = uniqueIdentifier.split("@")[0]
  const separator = withoutDigest.lastIndexOf(":")
  if (separator <= 0) return { id: withoutDigest }
  return { id: withoutDigest.slice(0, separator), version: withoutDigest.slice(separator + 1) }
}

export const defaultDifyImportResolver: DifyImportResolver = {
  async resolvePlugin({ uniqueIdentifier, currentIdentifier }) {
    const candidates = [currentIdentifier, uniqueIdentifier].filter(
      (value): value is string => typeof value === "string" && value.length > 0
    )
    for (const candidate of candidates) {
      const identity = exactPluginIdentity(candidate)
      const plugin = await getDb().plugins.get(identity.id)
      if (
        plugin?.enabled &&
        (!identity.version || identity.version === plugin.version) &&
        plugin.status === "enabled"
      ) {
        return plugin.id
      }
    }
    return undefined
  },
  async resolveModel({ provider, model }) {
    if (getModelConfig(provider, model)) return { provider, model }
    const cached = await getDb().modelsDevCatalog.get("singleton")
    const found = cached?.providers[provider]?.models.some((entry) => entry.id === model)
    return found ? { provider, model } : undefined
  },
  async resolveTool({ providerId, toolName }) {
    const plugin = await getDb().plugins.get(providerId)
    if (
      plugin?.enabled &&
      plugin.status === "enabled" &&
      plugin.manifest.tools?.some((tool) => tool.name === toolName)
    ) {
      return { kind: "plugin", pluginId: plugin.id, toolName }
    }
    const server = await getDb().mcpServers.get(providerId)
    return server?.enabled ? { kind: "mcp", serverId: server.id, toolName } : undefined
  },
  async resolveKnowledge(datasetId) {
    return (await getDb().knowledgeBases.get(datasetId))?.id
  },
}

function selectorPath(selector: unknown, startNodeIds: Set<string>): string {
  if (
    !Array.isArray(selector) ||
    selector.length < 2 ||
    !selector.every((part) => typeof part === "string")
  ) {
    return ""
  }
  const [nodeId, ...path] = selector as string[]
  if (path[0] === "item") return "$item"
  if (path[0] === "index") return "$loop.index"
  const root = startNodeIds.has(nodeId)
    ? "$trigger.payload"
    : `$node[${JSON.stringify(nodeId)}].out`
  return path.reduce((expression, part) => `${expression}[${JSON.stringify(part)}]`, root)
}

function expression(selector: unknown, startNodeIds: Set<string>): string {
  const path = selectorPath(selector, startNodeIds)
  return path ? `{{ ${path} }}` : ""
}

function replaceDifyReferences(value: string, startNodeIds: Set<string>): string {
  return value.replace(/\{\{#([A-Za-z0-9_-]+)((?:\.[A-Za-z0-9_-]+)+)#\}\}/g, (_all, node, tail) => {
    const selector = [node, ...String(tail).slice(1).split(".")]
    return expression(selector, startNodeIds)
  })
}

function inputSchema(data: JsonRecord): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const variable of asRecords(data.variables)) {
    const id = stringValue(variable.variable)
    if (!id) continue
    const type = stringValue(variable.type)
    properties[id] =
      type === "number"
        ? { type: "number", title: stringValue(variable.label) || id }
        : type === "file"
          ? { type: "string", format: "file-ref", title: stringValue(variable.label) || id }
          : type === "file-list"
            ? {
                type: "array",
                items: { type: "string", format: "file-ref" },
                title: stringValue(variable.label) || id,
              }
            : type === "select"
              ? {
                  type: "string",
                  enum: Array.isArray(variable.options) ? variable.options : [],
                  title: stringValue(variable.label) || id,
                }
              : { type: "string", title: stringValue(variable.label) || id }
    if (variable.required === true) required.push(id)
  }
  return { type: "object", properties, ...(required.length > 0 ? { required } : {}) }
}

function outputValue(data: JsonRecord, startNodeIds: Set<string>): Record<string, unknown> {
  return Object.fromEntries(
    asRecords(data.outputs)
      .map((output) => [
        stringValue(output.variable),
        expression(output.value_selector, startNodeIds),
      ])
      .filter(([key]) => key.length > 0)
  )
}

function retryPolicy(data: JsonRecord): WorkflowNodeErrorHandling | undefined {
  const retry = asRecord(data.retry_config)
  if (retry?.enabled !== true) return undefined
  const exponential = asRecord(retry.exponential_backoff)
  return {
    retry: {
      maxRetries: Math.max(0, Number(retry.max_retries ?? 0)),
      retryIntervalMs: Math.max(0, Number(retry.retry_interval ?? 0)),
      backoff: exponential?.enabled === true ? "exponential" : "fixed",
      ...(Number(exponential?.max_interval) > 0
        ? { maxIntervalMs: Number(exponential?.max_interval) }
        : {}),
    },
  }
}

function nodeBase(
  raw: JsonRecord,
  data: JsonRecord,
  type: WorkflowNode["type"],
  typeVersion = 1
): WorkflowNode {
  const position = asRecord(raw.position)
  return {
    id: stringValue(raw.id),
    type,
    typeVersion,
    position: { x: Number(position?.x ?? 0), y: Number(position?.y ?? 0) },
    ...(typeof raw.parentId === "string" ? { parentId: raw.parentId } : {}),
    ...(typeof raw.width === "number" ? { width: raw.width } : {}),
    ...(typeof raw.height === "number" ? { height: raw.height } : {}),
    data: {
      label: stringValue(data.title) || type,
      notes: stringValue(data.desc) || undefined,
      params: {},
      importedFrom: { profile: PROFILE, nodeType: stringValue(data.type) },
      ...(retryPolicy(data) ? { errorHandling: retryPolicy(data) } : {}),
    },
  }
}

function modelConfig(data: JsonRecord): { provider: string; model: string } {
  const model = asRecord(data.model)
  return { provider: stringValue(model?.provider), model: stringValue(model?.name) }
}

async function resolveModelForNode(
  data: JsonRecord,
  path: string,
  context: ImportContext
): Promise<{ provider: string; model: string } | undefined> {
  const requested = modelConfig(data)
  if (!requested.provider || !requested.model) {
    context.blockers.push(
      blocker("invalid_node", path, "Dify model provider and name are required")
    )
    return undefined
  }
  const resolved = await context.resolver.resolveModel(requested)
  if (!resolved) {
    context.blockers.push(
      blocker(
        "missing_model",
        `${path}.model`,
        `Model ${requested.provider}/${requested.model} is not installed`
      )
    )
  }
  return resolved
}

function mappedCondition(
  value: JsonRecord,
  startNodeIds: Set<string>
): { left: string; operator: string; right?: string } | undefined {
  const operators: Record<string, string> = {
    is: "eq",
    "is not": "neq",
    "=": "eq",
    "≠": "neq",
    contains: "contains",
    "not contains": "notContains",
    "start with": "startsWith",
    "end with": "endsWith",
    ">": "gt",
    "≥": "gte",
    "<": "lt",
    "≤": "lte",
    empty: "isEmpty",
    "not empty": "isNotEmpty",
  }
  const operator = operators[stringValue(value.comparison_operator)]
  const left = expression(value.variable_selector, startNodeIds)
  if (!operator || !left) return undefined
  return {
    left,
    operator,
    ...(operator === "isEmpty" || operator === "isNotEmpty"
      ? {}
      : { right: typeof value.value === "string" ? value.value : JSON.stringify(value.value) }),
  }
}

function humanInputFields(data: JsonRecord): JsonRecord[] {
  return asRecords(data.inputs).flatMap((field) => {
    const id = stringValue(field.output_variable_name)
    if (!id) return []
    const type = stringValue(field.type)
    const common = { id, label: id, required: false }
    if (type === "select") {
      const source = asRecord(field.option_source)
      const options = Array.isArray(source?.value)
        ? source.value.filter((item): item is string => typeof item === "string")
        : []
      return [
        {
          ...common,
          type: "single-select",
          options: options.map((value) => ({ value, label: value })),
        },
      ]
    }
    if (type === "file") {
      return [{ ...common, type: "file", accept: field.allowed_file_extensions }]
    }
    if (type === "file-list") {
      return [
        {
          ...common,
          type: "file-list",
          accept: field.allowed_file_extensions,
          maxFiles: Math.max(1, Number(field.number_limits ?? 1)),
        },
      ]
    }
    return [{ ...common, type: type === "paragraph" ? "long-text" : "short-text" }]
  })
}

function timeoutMs(data: JsonRecord): number {
  const amount = Math.max(1, Number(data.timeout ?? 3))
  const unit = stringValue(data.timeout_unit)
  const multiplier = unit === "minute" ? 60_000 : unit === "hour" ? 3_600_000 : 86_400_000
  return Math.min(30 * 86_400_000, Math.max(60_000, amount * multiplier))
}

async function mapNode(
  raw: JsonRecord,
  index: number,
  context: ImportContext
): Promise<WorkflowNode[]> {
  const data = asRecord(raw.data)
  const nodeId = stringValue(raw.id)
  const path = `workflow.graph.nodes[${index}]`
  if (!data || !nodeId) {
    context.blockers.push(blocker("invalid_node", path, "Dify node id and data are required"))
    return []
  }
  const difyType = stringValue(data.type)
  if (difyType === "custom-note") {
    context.warnings.push({
      code: "feature_not_ported",
      path,
      message: `Dify custom note ${nodeId} is not part of the executable graph`,
    })
    return []
  }
  if (SYNTHETIC_START_TYPES.has(difyType)) return []

  if (difyType === "start") {
    const node = nodeBase(raw, data, "trigger.manual")
    node.data.params = { inputSchema: inputSchema(data) }
    return [node]
  }
  if (difyType === "end") {
    const node = nodeBase(raw, data, "io.output")
    node.data.params = { value: outputValue(data, context.startNodeIds) }
    return [node]
  }
  if (difyType === "answer") {
    const node = nodeBase(raw, data, "io.answer")
    node.data.params = {
      text: replaceDifyReferences(stringValue(data.answer), context.startNodeIds),
    }
    return [node]
  }
  if (difyType === "llm") {
    const resolved = await resolveModelForNode(data, path, context)
    const prompts = asRecords(data.prompt_template)
    const systemPrompt = prompts
      .filter((prompt) => prompt.role === "system")
      .map((prompt) => replaceDifyReferences(stringValue(prompt.text), context.startNodeIds))
      .join("\n\n")
    const userPrompt = prompts
      .filter((prompt) => prompt.role !== "system")
      .map((prompt) => replaceDifyReferences(stringValue(prompt.text), context.startNodeIds))
      .join("\n\n")
    const node = nodeBase(raw, data, "ai.prompt", 2)
    node.data.params = {
      mode: "explicit",
      provider: resolved?.provider ?? modelConfig(data).provider,
      model: resolved?.model ?? modelConfig(data).model,
      systemPrompt,
      userPrompt: userPrompt || "{{ $trigger.payload.query }}",
      ...(typeof data.model_parameters === "object"
        ? { temperature: Number(asRecord(data.model_parameters)?.temperature ?? 0.7) }
        : {}),
      piiGate: "redact",
    }
    return [node]
  }
  if (difyType === "http-request") {
    const body = asRecord(data.body)
    const node = nodeBase(raw, data, "io.http")
    node.data.params = {
      method: stringValue(data.method).toUpperCase() || "GET",
      url: replaceDifyReferences(stringValue(data.url), context.startNodeIds),
      ...(typeof body?.data === "string" && body.data
        ? { body: replaceDifyReferences(body.data, context.startNodeIds) }
        : {}),
      piiGate: "redact",
    }
    return [node]
  }
  if (difyType === "template-transform") {
    let template = stringValue(data.template)
    for (const variable of asRecords(data.variables)) {
      const name = stringValue(variable.variable)
      const replacement = expression(variable.value_selector, context.startNodeIds)
      if (name && replacement) {
        template = template.replace(
          new RegExp(`\\{\\{\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\}\\}`, "g"),
          replacement
        )
      }
    }
    const node = nodeBase(raw, data, "data.template")
    node.data.params = { template: replaceDifyReferences(template, context.startNodeIds) }
    return [node]
  }
  if (difyType === "if-else") {
    const cases = asRecords(data.cases).map((candidate, caseIndex) => {
      const conditions = asRecords(candidate.conditions)
        .map((condition) => mappedCondition(condition, context.startNodeIds))
        .filter((condition): condition is NonNullable<typeof condition> => !!condition)
      if (conditions.length !== asRecords(candidate.conditions).length) {
        context.blockers.push(
          blocker(
            "invalid_node",
            `${path}.data.cases[${caseIndex}]`,
            "Dify condition operator is unsupported"
          )
        )
      }
      const id = stringValue(candidate.case_id) || stringValue(candidate.id) || `case-${caseIndex}`
      return {
        id,
        label: id,
        when: {
          combinator: candidate.logical_operator === "or" ? "any" : "all",
          conditions,
        },
      }
    })
    const node = nodeBase(raw, data, "flow.switch", 2)
    node.data.params = { cases }
    context.ifElseIds.add(nodeId)
    return [node]
  }
  if (difyType === "question-classifier") {
    const resolved = await resolveModelForNode(data, path, context)
    const classes = asRecords(data.classes)
    const labels = classes.map((item) => stringValue(item.name)).filter(Boolean)
    if (labels.length === 0) {
      context.blockers.push(
        blocker("invalid_node", `${path}.data.classes`, "Question classifier needs classes")
      )
    }
    const classify = nodeBase(raw, data, "ai.classify")
    classify.data.params = {
      provider: resolved?.provider ?? modelConfig(data).provider,
      model: resolved?.model ?? modelConfig(data).model,
      input: expression(data.query_variable_selector, context.startNodeIds),
      labels,
      labelsRaw: labels.join("\n"),
      piiGate: "redact",
    }
    const routeId = `${nodeId}__route`
    const route = nodeBase(
      {
        ...raw,
        id: routeId,
        position: {
          x: Number(asRecord(raw.position)?.x ?? 0) + 280,
          y: Number(asRecord(raw.position)?.y ?? 0),
        },
      },
      { title: `${stringValue(data.title) || "Classifier"} routes`, type: "if-else" },
      "flow.switch",
      2
    )
    route.data.params = {
      cases: classes.map((item, classIndex) => ({
        id: stringValue(item.id) || `class-${classIndex}`,
        label: stringValue(item.name) || `Class ${classIndex + 1}`,
        when: {
          combinator: "all",
          conditions: [
            {
              left: `{{ $node[${JSON.stringify(nodeId)}].out.label }}`,
              operator: "eq",
              right: stringValue(item.name),
            },
          ],
        },
      })),
    }
    context.questionRoutes.set(nodeId, routeId)
    return [classify, route]
  }
  if (difyType === "parameter-extractor") {
    const resolved = await resolveModelForNode(data, path, context)
    const parameters = asRecords(data.parameters)
    const properties = Object.fromEntries(
      parameters.map((parameter) => [
        stringValue(parameter.name),
        {
          type:
            parameter.type === "number" ||
            parameter.type === "boolean" ||
            parameter.type === "array"
              ? parameter.type
              : "string",
          description: stringValue(parameter.description),
        },
      ])
    )
    const node = nodeBase(raw, data, "ai.extract")
    node.data.params = {
      provider: resolved?.provider ?? modelConfig(data).provider,
      model: resolved?.model ?? modelConfig(data).model,
      input:
        expression(data.query, context.startNodeIds) ||
        expression(data.query_variable_selector, context.startNodeIds),
      schema: { type: "object", properties },
      required: parameters
        .filter((parameter) => parameter.required === true)
        .map((parameter) => stringValue(parameter.name)),
      piiGate: "redact",
    }
    return [node]
  }
  if (difyType === "knowledge-retrieval") {
    const requestedDatasetIds = Array.isArray(data.dataset_ids)
      ? data.dataset_ids.filter((value): value is string => typeof value === "string" && !!value)
      : []
    if (requestedDatasetIds.length === 0) {
      context.blockers.push(
        blocker("invalid_node", `${path}.data.dataset_ids`, "Knowledge Retrieval needs a dataset")
      )
    }
    const resolvedDatasetIds = await Promise.all(
      requestedDatasetIds.map(async (datasetId) => {
        const resolved = await context.resolver.resolveKnowledge(datasetId)
        if (!resolved) {
          context.blockers.push(
            blocker(
              "missing_knowledge",
              `${path}.data.dataset_ids`,
              `Knowledge dataset ${datasetId} is unresolved`
            )
          )
        }
        return resolved
      })
    )
    const query = expression(data.query_variable_selector, context.startNodeIds)
    if (!query) {
      context.blockers.push(
        blocker(
          "invalid_node",
          `${path}.data.query_variable_selector`,
          "Knowledge Retrieval query selector is invalid"
        )
      )
    }
    const retrievalMode = stringValue(data.retrieval_mode)
    const multiple = asRecord(data.multiple_retrieval_config)
    const metadataMode = stringValue(data.metadata_filtering_mode) || "disabled"
    if (
      metadataMode !== "disabled" ||
      (Array.isArray(data.query_attachment_selector) && data.query_attachment_selector.length > 0)
    ) {
      context.blockers.push(
        blocker(
          "unsupported_node",
          path,
          "Dify Knowledge Retrieval attachments and metadata filters require an exact Cognia filter mapping"
        )
      )
    }
    if (
      retrievalMode === "multiple" &&
      (multiple?.reranking_enable === true || multiple?.reranking_model || multiple?.weights)
    ) {
      context.blockers.push(
        blocker(
          "unsupported_node",
          `${path}.data.multiple_retrieval_config`,
          "Dify Knowledge Retrieval reranking requires an exact Cognia reranker binding"
        )
      )
    }
    const node = nodeBase(raw, data, "knowledge.retrieve")
    node.data.params = {
      knowledgeBaseIds: resolvedDatasetIds.filter((id): id is string => !!id),
      query,
      topKPerBase: retrievalMode === "multiple" ? Math.max(1, Number(multiple?.top_k ?? 4)) : 4,
      tokenBudget: 4000,
      ...(retrievalMode === "multiple" && typeof multiple?.score_threshold === "number"
        ? { scoreThreshold: multiple.score_threshold }
        : {}),
    }
    return [node]
  }
  if (difyType === "tool") {
    const providerId = stringValue(data.provider_id)
    const toolName = stringValue(data.tool_name)
    const binding = await context.resolver.resolveTool({ providerId, toolName })
    if (!binding) {
      context.blockers.push(
        blocker("missing_tool", path, `Tool ${providerId}/${toolName} is unresolved`)
      )
      return []
    }
    const node = nodeBase(
      raw,
      data,
      binding.kind === "plugin" ? "action.plugin.invoke" : "action.mcp.invokeTool"
    )
    const args = Object.fromEntries(
      Object.entries(asRecord(data.tool_parameters) ?? {}).map(([key, value]) => [
        key,
        typeof value === "string" ? replaceDifyReferences(value, context.startNodeIds) : value,
      ])
    )
    node.data.params =
      binding.kind === "plugin"
        ? {
            pluginId: binding.pluginId,
            mode: "tool",
            toolName: binding.toolName,
            args,
            piiGate: "redact",
          }
        : { serverId: binding.serverId, toolName: binding.toolName, args, piiGate: "redact" }
    return [node]
  }
  if (difyType === "human-input") {
    const actions = asRecords(data.user_actions)
      .map((action) => ({
        id: stringValue(action.id),
        label: stringValue(action.title),
        tone: action.button_style === "danger" ? "destructive" : "primary",
      }))
      .filter((action) => action.id && action.label)
    if (actions.length === 0) {
      context.blockers.push(
        blocker("invalid_node", `${path}.data.user_actions`, "Human Input needs an action")
      )
    }
    const node = nodeBase(raw, data, "action.humanInput.request")
    node.data.params = {
      title: stringValue(data.title) || "Human input",
      message: stringValue(data.form_content),
      fields: humanInputFields(data),
      actions,
      assignees: [{ kind: "initiator" }],
      completionPolicy: { mode: "any" },
      timeoutMs: timeoutMs(data),
    }
    return [node]
  }
  if (difyType === "iteration") {
    const source = expression(data.iterator_selector, context.startNodeIds)
    if (!source) {
      context.blockers.push(
        blocker("invalid_node", `${path}.data.iterator_selector`, "Iteration source is invalid")
      )
    }
    const errorMode = stringValue(data.error_handle_mode)
    const node = nodeBase(raw, data, "flow.loop", 2)
    node.data.params = {
      mode: "forEach",
      source,
      output: expression(data.output_selector, context.startNodeIds),
      iterationConcurrency:
        data.is_parallel === true ? Math.max(1, Number(data.parallel_nums ?? 10)) : 1,
      onItemError:
        errorMode === "continue-on-error"
          ? "continue-with-null"
          : errorMode === "remove-abnormal-output"
            ? "remove-failed"
            : "fail",
    }
    return [node]
  }

  context.blockers.push(
    blocker(
      "unsupported_node",
      path,
      `Dify node type ${difyType || "(missing)"} has no lossless Cognia mapping`
    )
  )
  return []
}

function mapEdges(
  values: JsonRecord[],
  nodeIds: Set<string>,
  syntheticIds: Set<string>,
  context: ImportContext
): WorkflowEdge[] {
  const edges: WorkflowEdge[] = []
  for (const [index, raw] of values.entries()) {
    const originalSource = stringValue(raw.source)
    const target = stringValue(raw.target)
    if (syntheticIds.has(originalSource) || syntheticIds.has(target)) continue
    const source = context.questionRoutes.get(originalSource) ?? originalSource
    if (!nodeIds.has(source) || !nodeIds.has(target)) {
      if (
        !context.blockers.some(
          (item) => item.code === "unsupported_node" || item.code === "missing_tool"
        )
      ) {
        context.blockers.push(
          blocker(
            "invalid_graph",
            `workflow.graph.edges[${index}]`,
            `Edge references missing node ${source} -> ${target}`
          )
        )
      }
      continue
    }
    let sourceHandle =
      typeof raw.sourceHandle === "boolean"
        ? String(raw.sourceHandle)
        : stringValue(raw.sourceHandle)
    if (context.ifElseIds.has(originalSource) && sourceHandle === "false") sourceHandle = "default"
    if (sourceHandle === "source") sourceHandle = ""
    edges.push({
      id: stringValue(raw.id) || `dify-edge-${index}`,
      source,
      target,
      ...(sourceHandle ? { sourceHandle } : {}),
    })
  }
  for (const [source, route] of context.questionRoutes) {
    edges.push({ id: `${source}__to_route`, source, target: route })
  }
  return edges
}

async function resolveTopLevelDependencies(
  parsed: ParsedDifyDsl,
  context: ImportContext
): Promise<void> {
  for (const [index, dependency] of parsed.dependencies.entries()) {
    const value = asRecord(dependency.value)
    const uniqueIdentifier =
      stringValue(value?.plugin_unique_identifier) ||
      stringValue(value?.marketplace_plugin_unique_identifier) ||
      stringValue(value?.github_plugin_unique_identifier)
    if (!uniqueIdentifier) {
      context.blockers.push(
        blocker(
          "invalid_envelope",
          `dependencies[${index}]`,
          "Dify plugin dependency identifier is missing"
        )
      )
      continue
    }
    const resolved = await context.resolver.resolvePlugin({
      uniqueIdentifier,
      currentIdentifier: stringValue(dependency.current_identifier) || undefined,
    })
    if (!resolved) {
      context.blockers.push(
        blocker(
          "missing_plugin",
          `dependencies[${index}]`,
          `Plugin ${uniqueIdentifier} is unresolved`
        )
      )
    }
  }
}

function importedVariables(
  workflow: JsonRecord,
  blockers: DifyImportIssue[]
): Record<string, string> {
  const variables: Record<string, string> = {}
  for (const [index, variable] of asRecords(workflow.environment_variables).entries()) {
    const name = stringValue(variable.name) || stringValue(variable.variable)
    const value = variable.value
    if (!name) continue
    if (variable.value_type === "secret" && typeof value === "string" && value.length > 0) {
      blockers.push(
        blocker(
          "secret_value_present",
          `workflow.environment_variables[${index}]`,
          `Secret environment variable ${name} must be rebound locally`
        )
      )
      continue
    }
    if (typeof value === "string") variables[name] = value
  }
  return variables
}

export async function preflightDifyDslImport(
  source: string,
  options: { workflowId?: string; resolver?: DifyImportResolver; now?: number } = {}
): Promise<DifyImportPreflight> {
  let parsed: ParsedDifyDsl
  try {
    parsed = parseDifyDsl(source)
  } catch (error) {
    return {
      profile: PROFILE,
      ok: false,
      blockers: [
        blocker(
          error instanceof SyntaxError ? "invalid_yaml" : "invalid_envelope",
          "dsl",
          error instanceof Error ? error.message : "Dify DSL is invalid"
        ),
      ],
      warnings: [],
    }
  }

  const blockers: DifyImportIssue[] = []
  const warnings: DifyImportWarning[] = []
  const version = parseVersion(parsed.version)
  if (!version || version[0] !== 0 || compareVersion(version, CURRENT_DSL_VERSION) > 0) {
    blockers.push(
      blocker(
        "unsupported_version",
        "version",
        `Dify DSL ${parsed.version} is newer than the dify-1.16 profile (0.7.0)`
      )
    )
  } else if (compareVersion(version, CURRENT_DSL_VERSION) < 0) {
    warnings.push({
      code: "older_dsl_version",
      path: "version",
      message: `Dify DSL ${parsed.version} is imported through the 0.7.0 compatibility reader`,
    })
  }

  const rawNodes = asRecords(parsed.graph.nodes)
  const startNodeIds = new Set(
    rawNodes
      .filter((node) => asRecord(node.data)?.type === "start")
      .map((node) => stringValue(node.id))
      .filter(Boolean)
  )
  const context: ImportContext = {
    startNodeIds,
    blockers,
    warnings,
    resolver: options.resolver ?? defaultDifyImportResolver,
    questionRoutes: new Map(),
    ifElseIds: new Set(),
  }
  await resolveTopLevelDependencies(parsed, context)
  const mappedNodes = (
    await Promise.all(rawNodes.map((node, index) => mapNode(node, index, context)))
  ).flat()
  const syntheticIds = new Set(
    rawNodes
      .filter((node) => SYNTHETIC_START_TYPES.has(stringValue(asRecord(node.data)?.type)))
      .map((node) => stringValue(node.id))
  )
  const nodeIds = new Set(mappedNodes.map((node) => node.id))
  const edges = mapEdges(asRecords(parsed.graph.edges), nodeIds, syntheticIds, context)
  const workflowId = options.workflowId ?? `wf_dify_${(await sha256(source)).slice(0, 24)}`
  const appMode =
    parsed.app.mode === "advanced-chat" || parsed.app.mode === "chatflow" ? "chatflow" : "workflow"
  const now = options.now ?? Date.now()
  const workflow: VisualWorkflow = {
    id: workflowId,
    schemaVersion: 2,
    name: stringValue(parsed.app.name) || "Imported Dify workflow",
    description: stringValue(parsed.app.description) || undefined,
    icon: stringValue(parsed.app.icon) || undefined,
    tags: ["dify-1.16", appMode],
    createdAt: now,
    updatedAt: now,
    nodes: mappedNodes,
    edges,
    settings: structuredClone(DEFAULT_WORKFLOW_SETTINGS),
    variables: importedVariables(parsed.workflow, blockers),
    interface: {
      inputSchema: inputSchema(
        asRecord(rawNodes.find((node) => startNodeIds.has(stringValue(node.id)))?.data) ?? {}
      ),
    },
  }
  if (await getDb().workflows.get(workflowId)) {
    blockers.push(
      blocker("workflow_conflict", "workflow.id", `Workflow ${workflowId} already exists`)
    )
  }
  if (blockers.length === 0) {
    const validation = validateWorkflow(workflow)
    if (!validation.ok) {
      blockers.push(blocker("invalid_graph", "workflow.graph", validation.errors.join("; ")))
    }
  }
  return { profile: PROFILE, ok: blockers.length === 0, workflow, appMode, blockers, warnings }
}

export async function importDifyDsl(
  source: string,
  options: { workflowId?: string; resolver?: DifyImportResolver; now?: number } = {}
): Promise<{
  workflowId: string
  appMode: "workflow" | "chatflow"
  warnings: DifyImportWarning[]
}> {
  const preflight = await preflightDifyDslImport(source, options)
  if (!preflight.ok || !preflight.workflow || !preflight.appMode) {
    throw new Error(
      `Dify DSL preflight failed: ${preflight.blockers.map((item) => item.message).join("; ")}`
    )
  }
  await getDb().workflows.add(preflight.workflow)
  return {
    workflowId: preflight.workflow.id,
    appMode: preflight.appMode,
    warnings: preflight.warnings,
  }
}
