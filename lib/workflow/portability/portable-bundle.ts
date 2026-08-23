import { getDb } from "@/lib/db/schema"
import type { TemplateDefinitionRow } from "@/lib/db/template-platform"
import { verifyTemplateDefinitionHash } from "@/lib/templates/contracts"
import { validateWorkflow } from "@/lib/workflow/definition/validate"
import {
  WORKFLOW_NODE_KINDS,
  type VisualWorkflow,
  type WorkflowNodeKind,
} from "@/types/workflow/visual"
import type {
  WorkflowPortableBundle,
  WorkflowPortableCompatibilityIssue,
  WorkflowPortableDependency,
  WorkflowPortablePreflight,
} from "@/types/workflow/portable-bundle"

const API_VERSION = "cognia.ai/workflow-bundle/v1" as const
const FORBIDDEN_SECRET_KEYS = new Set([
  "apiKey",
  "token",
  "secret",
  "password",
  "webhookSecret",
  "credentialValue",
])
const BUILT_IN_NODE_KINDS = new Set<WorkflowNodeKind>(WORKFLOW_NODE_KINDS)

export interface WorkflowPortableResolver {
  hasPlugin(id: string): Promise<boolean>
  hasModel(id: string): Promise<boolean>
  hasTool(id: string): Promise<boolean>
  hasKnowledge(id: string): Promise<boolean>
  hasSecretRef(id: string): Promise<boolean>
}

const defaultResolver: WorkflowPortableResolver = {
  async hasPlugin(id) {
    return Boolean(await getDb().plugins.get(id))
  },
  async hasModel(id) {
    const db = getDb()
    const catalogModel = await db.providerCatalogModels.where("id").equals(id).first()
    if (catalogModel) return true
    const cached = await db.modelsDevCatalog.get("singleton")
    return Object.entries(cached?.providers ?? {}).some(([providerId, provider]) =>
      provider.models.some((model) => model.id === id || `${providerId}/${model.id}` === id)
    )
  },
  async hasTool(id) {
    const { getToolCatalog } = await import("@/lib/tools/tool-catalog")
    const tools = await getToolCatalog()
    return tools.some((tool) => tool.enabled && (tool.id === id || tool.name === id))
  },
  async hasKnowledge(id) {
    return Boolean(await getDb().knowledgeBases.get(id))
  },
  async hasSecretRef() {
    // Secret values are never queried from Dexie. Import callers must bind a
    // local secret reference explicitly through a resolver override.
    return false
  },
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonical(nested)])
  )
}

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(canonical(value)))
  const hash = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function assertNoSecretValues(value: unknown, path = "bundle"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretValues(item, `${path}[${index}]`))
    return
  }
  if (!value || typeof value !== "object") return
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_SECRET_KEYS.has(key) && typeof nested === "string" && nested.trim()) {
      throw new Error(`${path}.${key} contains a secret value; use a Secret reference`)
    }
    assertNoSecretValues(nested, `${path}.${key}`)
  }
}

function sanitizedWorkflow(workflow: VisualWorkflow): VisualWorkflow {
  const {
    published: _published,
    pinData: _pinData,
    staticData: _staticData,
    ...portable
  } = structuredClone(workflow)
  assertNoSecretValues(portable, `workflow:${workflow.id}`)
  return portable
}

function dependencies(workflow: VisualWorkflow): WorkflowPortableDependency[] {
  const result: WorkflowPortableDependency[] = []
  for (const node of workflow.nodes) {
    if (!BUILT_IN_NODE_KINDS.has(node.type)) {
      result.push({
        kind: "plugin",
        id: node.type.split(".")[0],
        required: true,
        source: `workflow:${workflow.id}:node:${node.id}`,
      })
    }
    const params = node.data.params as Record<string, unknown>
    for (const [key, value] of Object.entries(params)) {
      if (typeof value !== "string" || !value.trim()) continue
      if (/model(Id)?$/i.test(key)) {
        result.push({ kind: "model", id: value, required: true, source: `node:${node.id}.${key}` })
      } else if (/tool(Id|Name)?$/i.test(key)) {
        result.push({ kind: "tool", id: value, required: true, source: `node:${node.id}.${key}` })
      } else if (/knowledge(Base)?Id$/i.test(key)) {
        result.push({
          kind: "knowledge",
          id: value,
          required: true,
          source: `node:${node.id}.${key}`,
        })
      }
    }
  }
  for (const id of workflow.knowledgeBaseIds ?? []) {
    result.push({ kind: "knowledge", id, required: true, source: `workflow:${workflow.id}` })
  }
  for (const credential of Object.values(workflow.credentials ?? {})) {
    result.push({
      kind: "secret",
      id: credential.id,
      required: true,
      source: `workflow:${workflow.id}`,
    })
  }
  return result
}

function uniqueDependencies(values: WorkflowPortableDependency[]): WorkflowPortableDependency[] {
  const seen = new Set<string>()
  return values.filter((value) => {
    const key = `${value.kind}:${value.id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export async function createWorkflowPortableBundle(input: {
  workflow: VisualWorkflow
  templates?: WorkflowPortableBundle["templates"]
  now?: number
}): Promise<WorkflowPortableBundle> {
  const workflow = sanitizedWorkflow(input.workflow)
  const templates = structuredClone(input.templates ?? [])
  templates.forEach((template) => assertNoSecretValues(template, `template:${template.id}`))
  const allDependencies = uniqueDependencies([
    ...dependencies(workflow),
    ...templates.flatMap((template) =>
      template.dependencies
        .filter((dependency) => dependency.requirement === "required")
        .flatMap((dependency) => {
          const kind = dependency.kind
          if (kind !== "plugin" && kind !== "model" && kind !== "tool") return []
          return [
            { kind, id: dependency.id, required: true as const, source: `template:${template.id}` },
          ]
        })
    ),
  ])
  const unsigned = {
    apiVersion: API_VERSION,
    profile: "cognia-native" as const,
    createdAt: input.now ?? Date.now(),
    interface: structuredClone(workflow.interface ?? {}),
    workflows: [workflow],
    templates,
    dependencies: allDependencies,
    configSlots: allDependencies
      .filter((dependency) => dependency.kind !== "plugin")
      .map((dependency) => ({
        key: `${dependency.kind}:${dependency.id}`,
        kind:
          dependency.kind === "secret"
            ? ("secretRef" as const)
            : (dependency.kind as "model" | "tool" | "knowledge"),
        required: true,
      })),
  }
  return { ...unsigned, digest: await digest(unsigned) }
}

function issue(
  code: WorkflowPortableCompatibilityIssue["code"],
  path: string,
  message: string
): WorkflowPortableCompatibilityIssue {
  return { code, path, message }
}

async function parseBundle(text: string): Promise<WorkflowPortableBundle> {
  const value = JSON.parse(text) as Partial<WorkflowPortableBundle>
  if (
    value.apiVersion !== API_VERSION ||
    value.profile !== "cognia-native" ||
    !Array.isArray(value.workflows) ||
    !Array.isArray(value.templates) ||
    !Array.isArray(value.dependencies) ||
    typeof value.digest !== "string"
  ) {
    throw new Error("Portable Bundle envelope is invalid")
  }
  const { digest: expected, ...unsigned } = value as WorkflowPortableBundle
  if ((await digest(unsigned)) !== expected) throw new Error("Portable Bundle digest mismatch")
  assertNoSecretValues(value)
  return value as WorkflowPortableBundle
}

export async function preflightWorkflowPortableBundle(
  text: string,
  resolver: WorkflowPortableResolver = defaultResolver
): Promise<WorkflowPortablePreflight> {
  let bundle: WorkflowPortableBundle
  try {
    bundle = await parseBundle(text)
  } catch (error) {
    return {
      ok: false,
      blockers: [
        issue(
          "invalid_bundle",
          "bundle",
          error instanceof Error ? error.message : "Portable Bundle is invalid"
        ),
      ],
      warnings: [],
    }
  }
  const blockers: WorkflowPortableCompatibilityIssue[] = []
  for (const [index, workflow] of bundle.workflows.entries()) {
    const validated = validateWorkflow(workflow)
    if (!validated.ok) {
      blockers.push(issue("invalid_bundle", `workflows[${index}]`, validated.errors.join("; ")))
    }
    if (await getDb().workflows.get(workflow.id)) {
      blockers.push(
        issue(
          "workflow_conflict",
          `workflows[${index}].id`,
          `Workflow ${workflow.id} already exists`
        )
      )
    }
  }
  for (const [index, template] of bundle.templates.entries()) {
    if (!(await verifyTemplateDefinitionHash(template))) {
      blockers.push(
        issue("invalid_bundle", `templates[${index}]`, `Template ${template.id} hash is invalid`)
      )
      continue
    }
    const storageKey = template.version
      ? `release:${template.id}@${template.version}`
      : `draft:${template.id}`
    const current = await getDb().templateDefinitions.get(storageKey)
    if (current && current.contentHash !== template.contentHash) {
      blockers.push(
        issue(
          "template_conflict",
          `templates[${index}]`,
          `Template ${template.id} conflicts with a local definition`
        )
      )
    }
  }
  for (const dependency of bundle.dependencies) {
    const available =
      dependency.kind === "plugin"
        ? await resolver.hasPlugin(dependency.id)
        : dependency.kind === "model"
          ? await resolver.hasModel(dependency.id)
          : dependency.kind === "tool"
            ? await resolver.hasTool(dependency.id)
            : dependency.kind === "knowledge"
              ? await resolver.hasKnowledge(dependency.id)
              : await resolver.hasSecretRef(dependency.id)
    if (!available) {
      const code =
        dependency.kind === "plugin"
          ? "missing_plugin"
          : dependency.kind === "model"
            ? "missing_model"
            : dependency.kind === "tool"
              ? "missing_tool"
              : dependency.kind === "knowledge"
                ? "missing_knowledge"
                : "missing_secret_ref"
      blockers.push(
        issue(code, dependency.source, `${dependency.kind} ${dependency.id} is unresolved`)
      )
    }
  }
  return { ok: blockers.length === 0, bundle, blockers, warnings: [] }
}

export async function importWorkflowPortableBundle(
  text: string,
  resolver: WorkflowPortableResolver = defaultResolver
): Promise<{ workflowIds: string[]; templateIds: string[] }> {
  const preflight = await preflightWorkflowPortableBundle(text, resolver)
  if (!preflight.ok || !preflight.bundle) {
    throw new Error(
      `Portable Bundle preflight failed: ${preflight.blockers.map((item) => item.message).join("; ")}`
    )
  }
  const bundle = preflight.bundle
  const db = getDb()
  await db.transaction("rw", [db.workflows, db.templateDefinitions], async () => {
    await db.workflows.bulkAdd(bundle.workflows)
    const rows: TemplateDefinitionRow[] = bundle.templates.map((template) => ({
      ...template,
      storageKey: template.version
        ? `release:${template.id}@${template.version}`
        : `draft:${template.id}`,
    }))
    const newRows: TemplateDefinitionRow[] = []
    for (const row of rows) {
      if (!(await db.templateDefinitions.get(row.storageKey))) newRows.push(row)
    }
    if (newRows.length > 0) await db.templateDefinitions.bulkAdd(newRows)
  })
  return {
    workflowIds: bundle.workflows.map((workflow) => workflow.id),
    templateIds: bundle.templates.map((template) => template.id),
  }
}
