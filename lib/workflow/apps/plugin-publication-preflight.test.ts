import type { PluginRow } from "@/lib/db/plugin-types"
import type { PluginManifest } from "@/types/plugin"
import type { WorkflowVersion } from "@/types/workflow/deployment"
import type { VisualWorkflowNode } from "@/types/workflow/visual"
import {
  assertWorkflowPluginPublicationPreflight,
  WorkflowPluginPreflightError,
} from "./plugin-publication-preflight"

function workflowVersion(nodes: VisualWorkflowNode[]): WorkflowVersion {
  return {
    id: "version-1",
    accountId: "account-1",
    workflowId: "workflow-1",
    sequence: 1,
    definition: {
      id: "workflow-1",
      name: "Published workflow",
      nodes,
      edges: [],
      settings: { concurrency: 1 },
      createdAt: 1,
      updatedAt: 1,
    },
    interface: { inputSchema: { type: "object" } },
    dependencyManifest: { nodeTypes: [], workflows: [], credentials: [] },
    configDefinition: { constants: {}, secretRefs: [] },
    digest: "wfv1:test",
    name: "Published workflow",
    createdAt: 1,
  }
}

function node(
  type: string,
  params: Record<string, unknown> = {},
  typeVersion = 1
): VisualWorkflowNode {
  return {
    id: `node-${type}`,
    type,
    typeVersion,
    position: { x: 0, y: 0 },
    data: { label: type, params },
  } as VisualWorkflowNode
}

function plugin(
  id: string,
  patch: Partial<PluginManifest> = {},
  rowPatch: Partial<PluginRow> = {}
): PluginRow {
  const manifest: PluginManifest = {
    id,
    name: id,
    version: "1.0.0",
    description: "Production plugin",
    type: "frontend",
    main: "index.js",
    capabilities: ["tools"],
    tools: [
      {
        name: "lookup",
        description: "Lookup",
        parametersSchema: { type: "object" },
      },
    ],
    runtimeCompatibility: { headless: { availability: "supported" } },
    ...patch,
  }
  return {
    id,
    name: manifest.name,
    version: manifest.version,
    status: "enabled",
    source: "builtin",
    type: manifest.type,
    enabled: true,
    capabilities: [...manifest.capabilities],
    path: `builtin://${id}`,
    manifest: manifest as unknown as Record<string, unknown>,
    createdAt: 1,
    updatedAt: 1,
    ...rowPatch,
  }
}

const pluginInvoke = () =>
  node("action.plugin.invoke", {
    pluginId: "demo.plugin",
    mode: "tool",
    toolName: "lookup",
  })

describe("assertWorkflowPluginPublicationPreflight", () => {
  it("freezes exact trusted plugin artifacts used by a workflow", async () => {
    const lock = await assertWorkflowPluginPublicationPreflight(workflowVersion([pluginInvoke()]), {
      plugins: [plugin("demo.plugin")],
      verifySignature: jest.fn().mockResolvedValue(true),
    })

    expect(lock["demo.plugin"]).toEqual({
      pluginId: "demo.plugin",
      version: "1.0.0",
      manifestDigest: expect.stringMatching(/^wfv1:[0-9a-f]{32}$/),
      capabilities: ["tools"],
      runtimeProfile: "headless",
    })
  })

  it("includes required plugin dependencies in the frozen lock", async () => {
    const root = plugin("demo.plugin", { dependencies: { "support.plugin": "^1.0.0" } })
    const support = plugin("support.plugin", { capabilities: [] })

    const lock = await assertWorkflowPluginPublicationPreflight(workflowVersion([pluginInvoke()]), {
      plugins: [root, support],
      verifySignature: jest.fn().mockResolvedValue(true),
    })

    expect(Object.keys(lock).sort()).toEqual(["demo.plugin", "support.plugin"])
  })

  it.each([
    {
      name: "missing",
      plugins: [] as PluginRow[],
      expectedCode: "plugin-missing",
    },
    {
      name: "disabled",
      plugins: [plugin("demo.plugin", {}, { enabled: false, status: "disabled" })],
      expectedCode: "plugin-dependency-unavailable",
    },
    {
      name: "undeclared capability",
      plugins: [plugin("demo.plugin", { capabilities: [] })],
      expectedCode: "plugin-capability-undeclared",
    },
    {
      name: "undeclared tool",
      plugins: [plugin("demo.plugin", { tools: [] })],
      expectedCode: "plugin-tool-unresolved",
    },
    {
      name: "degraded Headless runtime",
      plugins: [
        plugin("demo.plugin", {
          runtimeCompatibility: { headless: { availability: "degraded" } },
        }),
      ],
      expectedCode: "plugin-runtime-incompatible",
    },
  ])("rejects a $name production dependency", async ({ plugins, expectedCode }) => {
    await expect(
      assertWorkflowPluginPublicationPreflight(workflowVersion([pluginInvoke()]), {
        plugins,
        verifySignature: jest.fn().mockResolvedValue(true),
      })
    ).rejects.toMatchObject({ code: expectedCode })
  })

  it("rejects a plugin that fails signature trust verification", async () => {
    await expect(
      assertWorkflowPluginPublicationPreflight(workflowVersion([pluginInvoke()]), {
        plugins: [
          plugin("demo.plugin", {}, { source: "marketplace", path: "/plugins/demo.plugin" }),
        ],
        verifySignature: jest.fn().mockResolvedValue(false),
      })
    ).rejects.toMatchObject({ code: "plugin-untrusted" })
  })

  it("resolves namespaced custom node ownership and exact type version", async () => {
    const custom = plugin("demo.plugin", {
      capabilities: ["workflow"],
      tools: undefined,
      workflows: {
        nodes: [
          {
            kind: "action.transform",
            typeVersion: 2,
            category: "plugin",
            label: "Transform",
            description: "Transform data",
            iconName: "Box",
            paramsSchema: { type: "object" },
          },
        ],
      },
    })
    const version = workflowVersion([node("demo.plugin.action.transform", {}, 2)])

    await expect(
      assertWorkflowPluginPublicationPreflight(version, {
        plugins: [custom],
        verifySignature: jest.fn().mockResolvedValue(true),
      })
    ).resolves.toMatchObject({ "demo.plugin": { version: "1.0.0" } })

    await expect(
      assertWorkflowPluginPublicationPreflight(
        workflowVersion([node("demo.plugin.action.transform", {}, 3)]),
        { plugins: [custom], verifySignature: jest.fn().mockResolvedValue(true) }
      )
    ).rejects.toMatchObject({ code: "plugin-contribution-version-mismatch" })
  })

  it("rejects unresolved plugin contributions and desktop-only Headless capabilities", async () => {
    await expect(
      assertWorkflowPluginPublicationPreflight(
        workflowVersion([node("missing.plugin.action.custom")]),
        { plugins: [] }
      )
    ).rejects.toBeInstanceOf(WorkflowPluginPreflightError)

    await expect(
      assertWorkflowPluginPublicationPreflight(
        workflowVersion([node("action.desktop.performAction")]),
        { plugins: [] }
      )
    ).rejects.toMatchObject({ code: "headless-capability-missing" })
  })
})
