/**
 * @jest-environment jsdom
 * @cognia-host-integration-test
 */
import {
  listEditorStores,
  registerEditorStore,
  unregisterEditorStore,
} from "@/lib/workflow/editor/store-registry"
import { createEditorStore } from "@/lib/workflow/editor/store"
import { useProposalStore } from "@/lib/workflow/editor/proposal-store"
import { getCopilotTemplate, listCopilotTemplates } from "@/lib/workflow/copilot-templates"
import { createWorkflowAuthorAPI } from "@/lib/plugin/api/workflow-author-api"
import type { VisualWorkflow } from "@cognia/plugin-sdk"
import type { PluginToolRegistration, PluginToolContext } from "@cognia/plugin-sdk"
import { buildTemplateTools } from "./template-tools"
import { configureWorkflowApi } from "../store-bridge"
/**
 * The template these tool tests drive. Any registered template works — they
 * assert the tools' behaviour, not template content — but it must exist, so
 * resolve it loudly. (`github-pr` was removed in
 * f478448874 "align runtime nodes and triggers"; this suite was the consumer
 * that commit missed.)
 */
const TEMPLATE_ID = "cron-report"
/** A required slot on TEMPLATE_ID that carries no defaultValue. */
const REQUIRED_SLOT = "sourceUrl"
const SLOTS = {
  cronExpression: "0 9 * * 1-5",
  sourceUrl: "https://example.com/api/feed",
  adapterId: "telegram_main",
  conversationKey: "ops",
}

function template(id: string = TEMPLATE_ID) {
  const found = getCopilotTemplate(id)
  if (!found) {
    throw new Error(
      `Copilot template "${id}" is not registered — update TEMPLATE_ID/REQUIRED_SLOT ` +
        `in this suite to a template from lib/workflow/copilot-templates/index.ts.`
    )
  }
  return found
}

// Fail loudly, before any tool test, if TEMPLATE_ID stopped being registered.
beforeAll(() => {
  template()
})

function workflow(id: string): VisualWorkflow {
  return {
    id,
    schemaVersion: 1,
    name: id,
    nodes: [],
    edges: [],
    settings: {
      errorPolicy: "stop",
      timeoutMs: 60_000,
      concurrency: 1,
      retryDefaults: { attempts: 3, backoff: "exponential", baseMs: 1000, maxMs: 30_000 },
    },
    tags: [],
    createdAt: 0,
    updatedAt: 0,
  }
}

const EMPTY_CTX: PluginToolContext = { config: {} }

function findTool(tools: PluginToolRegistration[], name: string): PluginToolRegistration {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`Tool not found: ${name}`)
  return t
}

function setupStore(): void {
  const store = createEditorStore(workflow("wf_a"))
  registerEditorStore("wf_a", store)
}

beforeEach(() => {
  configureWorkflowApi(createWorkflowAuthorAPI() as never)
  for (const { workflowId } of listEditorStores()) unregisterEditorStore(workflowId)
  for (const id of Object.keys(useProposalStore.getState().entries))
    useProposalStore.getState().clearProposalsFor(id)
})

describe("wf_list_templates tool", () => {
  it("returns every registered template with its slot metadata", async () => {
    const tool = findTool(buildTemplateTools(), "wf_list_templates")
    const result = (await tool.execute({}, EMPTY_CTX)) as {
      ok: true
      templates: Array<{ id: string; slots: Array<{ key: string; required: boolean }> }>
    }
    expect(result.ok).toBe(true)
    const ids = result.templates.map((t) => t.id)
    expect(ids).toEqual(listCopilotTemplates().map((t) => t.id))
    // The driven template's required slot must surface.
    const listed = result.templates.find((t) => t.id === TEMPLATE_ID)
    expect(listed).toBeDefined()
    expect(listed!.slots.some((s) => s.key === REQUIRED_SLOT && s.required)).toBe(true)
  })
})

describe("wf_apply_template tool", () => {
  it("stages a proposal with add_node + connect_edge ops and returns messageParts", async () => {
    setupStore()
    const tool = findTool(buildTemplateTools(), "wf_apply_template")
    const result = (await tool.execute(
      {
        workflowId: "wf_a",
        templateId: TEMPLATE_ID,
        slots: SLOTS,
      },
      EMPTY_CTX
    )) as {
      ok: true
      proposalId: string
      opCount: { add: number; connect: number }
      messageParts: Array<{ type: string; proposalId: string }>
    }
    expect(result.ok).toBe(true)
    expect(result.proposalId).toMatch(/^p_/)
    expect(result.opCount.add).toBeGreaterThan(0)
    expect(result.opCount.connect).toBeGreaterThan(0)
    expect(result.messageParts[0].type).toBe("workflow-proposal")
    // Verify the proposal is open in the store.
    expect(useProposalStore.getState().statusOf(result.proposalId)).toBe("open")
  })

  it("surfaces missing-required-slot when the slots bag is empty", async () => {
    setupStore()
    const tool = findTool(buildTemplateTools(), "wf_apply_template")
    const result = (await tool.execute(
      {
        workflowId: "wf_a",
        templateId: TEMPLATE_ID,
        slots: {},
      },
      EMPTY_CTX
    )) as { ok: false; error: { code: string; detail?: { missing: string[] } } }
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe("missing-required-slot")
    expect(result.error.detail?.missing).toContain(REQUIRED_SLOT)
  })

  it("surfaces unknown-template for an unregistered id", async () => {
    setupStore()
    const tool = findTool(buildTemplateTools(), "wf_apply_template")
    const result = (await tool.execute(
      { workflowId: "wf_a", templateId: "definitely-not-a-template" },
      EMPTY_CTX
    )) as { ok: false; error: { code: string } }
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe("unknown-template")
  })

  it("returns editor-not-open when no editor is registered", async () => {
    const tool = findTool(buildTemplateTools(), "wf_apply_template")
    const result = (await tool.execute(
      {
        workflowId: "wf_missing",
        templateId: TEMPLATE_ID,
        slots: SLOTS,
      },
      EMPTY_CTX
    )) as { ok: false; error: { code: string } }
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe("editor-not-open")
  })
})
