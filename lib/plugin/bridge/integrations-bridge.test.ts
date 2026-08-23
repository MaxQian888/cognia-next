/** @jest-environment jsdom */

import {
  __resetIntegrationRegistryForTesting,
  getIntegrationAccountStatusProvider,
  getIntegrationResourceProvider,
  listRegisteredIntegrations,
} from "@/lib/integrations/registry"
import { getExecutor, __resetRegistryForTesting } from "@/lib/workflow/nodes/registry"
import {
  __resetPluginCatalogForTesting,
  getPluginCatalogSnapshot,
} from "@/lib/workflow/nodes/catalog"
import {
  registerIntegrationsForPlugin,
  unregisterIntegrationsForPlugin,
} from "./integrations-bridge"
import type { PluginManifest } from "@/types/plugin"

describe("Integration manifest bridge", () => {
  beforeEach(() => {
    __resetIntegrationRegistryForTesting()
    __resetRegistryForTesting()
    __resetPluginCatalogForTesting()
  })

  it("resolves handlers and auto-materializes typed Workflow action nodes", async () => {
    const manifest = {
      id: "example-delivery",
      name: "Example",
      version: "1.0.0",
      description: "Example",
      type: "frontend",
      capabilities: ["integrations"],
      integrations: [
        {
          id: "example",
          label: "Example",
          authStrategies: [],
          resourceKinds: ["issue"],
          eventTypes: [],
          resourceProvider: { handler: "listResources", kinds: ["issue"] },
          healthProvider: { handler: "checkHealth" },
          actions: [
            {
              id: "issue.comment",
              label: "Comment on issue",
              handler: "commentIssue",
              inputSchema: {
                type: "object",
                properties: { issueId: { type: "string" } },
                required: ["issueId"],
              },
              risk: "write",
              idempotency: "required",
            },
          ],
        },
      ],
    } as PluginManifest
    const commentIssue = jest.fn()
    const listResources = jest.fn()
    const checkHealth = jest.fn()
    const registeredTools: Array<{ name: string; definition: { parametersSchema: unknown } }> = []

    await registerIntegrationsForPlugin(
      "example-delivery",
      manifest,
      {
        commentIssue,
        listResources,
        checkHealth,
      },
      (tool) => {
        registeredTools.push(tool)
        return () => undefined
      }
    )

    expect(listRegisteredIntegrations("example-delivery")).toHaveLength(1)
    expect(getIntegrationResourceProvider("example-delivery", "example")).toBe(listResources)
    expect(getIntegrationAccountStatusProvider("example-delivery", "example")).toBe(checkHealth)
    expect(getExecutor("example-delivery.action.issue.comment" as never, 1)).toBeDefined()
    expect(registeredTools).toEqual([
      expect.objectContaining({
        name: "integration__example-delivery__example__issue_comment",
        definition: expect.objectContaining({
          parametersSchema: expect.objectContaining({
            required: ["accountId", "issueId"],
          }),
        }),
      }),
    ])
    expect(
      getPluginCatalogSnapshot().find(
        (entry) => entry.kind === ("example-delivery.action.issue.comment" as never)
      )?.paramsSchema
    ).toMatchObject({
      properties: {
        accountId: { type: "string" },
        issueId: { type: "string" },
      },
      required: ["accountId", "issueId"],
    })

    await unregisterIntegrationsForPlugin("example-delivery")
    expect(listRegisteredIntegrations("example-delivery")).toHaveLength(0)
  })
})
