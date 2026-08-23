jest.mock("@/lib/db/workflow-apps", () => ({ resolvePublishedWorkflowApp: jest.fn() }))
jest.mock("./api-key-service", () => ({
  authenticateWorkflowAppApiKey: jest.fn(),
  WorkflowAppKeyError: class extends Error {},
}))
jest.mock("./app-execution", () => ({ executePublishedWorkflowApp: jest.fn() }))

import { resolvePublishedWorkflowApp } from "@/lib/db/workflow-apps"
import { authenticateWorkflowAppApiKey } from "./api-key-service"
import { executePublishedWorkflowApp } from "./app-execution"
import { handleWorkflowAppMcpRequest } from "./mcp-service"

const resolved = {
  app: { id: "app-1", slug: "release-review" },
  release: {
    id: "release-1",
    workflowInterface: {
      inputSchema: { type: "object", required: ["topic"] },
      outputSchema: { type: "object", required: ["answer"] },
    },
    snapshot: {
      mcp: { enabled: true, tokenVersion: 4 },
      localized: { en: { title: "Release review", description: "Review a release" } },
    },
  },
} as never

beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(authenticateWorkflowAppApiKey).mockResolvedValue({
    key: { id: "key-1", mcpTokenVersion: 4 },
    accountId: "account-1",
    appId: "app-1",
    appSlug: "release-review",
  } as never)
  jest.mocked(resolvePublishedWorkflowApp).mockResolvedValue(resolved)
})

it("lists one tool whose schemas come from the immutable release", async () => {
  await expect(
    handleWorkflowAppMcpRequest({
      apiKey: "secret",
      appSlug: "release-review",
      request: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    })
  ).resolves.toMatchObject({
    id: 1,
    result: {
      tools: [
        {
          name: "run_release_review",
          title: "Release review",
          inputSchema: { required: ["topic"] },
          outputSchema: { required: ["answer"] },
        },
      ],
    },
  })
})

it("invokes the frozen release through ExecutionAuthority with service-key provenance", async () => {
  jest.mocked(executePublishedWorkflowApp).mockResolvedValue({
    result: { status: "succeeded", output: { answer: "approved" } },
  } as never)

  await expect(
    handleWorkflowAppMcpRequest({
      apiKey: "secret",
      appSlug: "release-review",
      request: {
        jsonrpc: "2.0",
        id: "call-7",
        method: "tools/call",
        params: { name: "run_release_review", arguments: { topic: "v2" } },
      },
    })
  ).resolves.toMatchObject({
    result: {
      structuredContent: { answer: "approved" },
      isError: false,
    },
  })
  expect(executePublishedWorkflowApp).toHaveBeenCalledWith(
    expect.objectContaining({
      resolved,
      input: { topic: "v2" },
      idempotencyKey: "mcp:key-1:call-7",
      entrypoint: "mcp",
      actor: expect.objectContaining({ serviceCredentialId: "key-1", authenticated: false }),
    })
  )
})

it("rejects a key invalidated by the app MCP token version", async () => {
  jest.mocked(authenticateWorkflowAppApiKey).mockResolvedValue({
    key: { id: "key-1", mcpTokenVersion: 3 },
    accountId: "account-1",
    appId: "app-1",
    appSlug: "release-review",
  } as never)

  await expect(
    handleWorkflowAppMcpRequest({
      apiKey: "secret",
      appSlug: "release-review",
      request: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    })
  ).rejects.toMatchObject({ code: "mcp_token_revoked" })
})
