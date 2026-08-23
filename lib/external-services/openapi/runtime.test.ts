import type { CompiledOpenApiProvider } from "./compiler"
import { compileOpenApiDocument } from "./compiler"
import { executeOpenApiOperation, projectOpenApiCapabilities } from "./runtime"
import {
  __resetExternalServiceCatalogForTesting,
  listExternalCapabilities,
  registerExternalServices,
} from "../catalog"

const provider: CompiledOpenApiProvider = compileOpenApiDocument({
  openapi: "3.1.2",
  info: { title: "Issues", version: "1" },
  servers: [{ url: "https://api.example.test/v1" }],
  paths: {
    "/repos/{owner}/{repo}/issues/{number}": {
      patch: {
        operationId: "updateIssue",
        parameters: [
          { name: "owner", in: "path", required: true, schema: { type: "string" } },
          { name: "repo", in: "path", required: true, schema: { type: "string" } },
          { name: "number", in: "path", required: true, schema: { type: "integer" } },
          { name: "notify", in: "query", schema: { type: "boolean" } },
          { name: "x-trace", in: "header", schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { title: { type: "string" } },
                required: ["title"],
              },
            },
          },
        },
        responses: { "200": { description: "ok" } },
      },
    },
  },
})

describe("OpenAPI runtime", () => {
  it("serializes a reviewed operation and keeps authentication host-owned", async () => {
    const request = jest.fn().mockResolvedValue({
      status: 200,
      headers: { "content-type": "application/json" },
      data: { ok: true },
    })

    const result = await executeOpenApiOperation({
      provider,
      operationId: "updateIssue",
      baseUrl: "https://api.example.test/v1",
      approvedOrigins: ["https://api.example.test"],
      args: {
        path: { owner: "acme", repo: "app", number: 42 },
        query: { notify: true },
        header: { "x-trace": "trace-1" },
        body: { title: "Fix button" },
      },
      request,
    })

    expect(request).toHaveBeenCalledWith(
      "https://api.example.test/v1/repos/acme/app/issues/42?notify=true",
      {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-trace": "trace-1" },
        body: JSON.stringify({ title: "Fix button" }),
        redirect: "manual",
      }
    )
    expect(result).toEqual(expect.objectContaining({ status: 200, data: { ok: true } }))
    expect(JSON.stringify(request.mock.calls)).not.toContain("authorization")
  })

  it("rejects unreviewed origins and redirects", async () => {
    await expect(
      executeOpenApiOperation({
        provider,
        operationId: "updateIssue",
        baseUrl: "https://evil.example/v1",
        approvedOrigins: ["https://api.example.test"],
        args: { path: { owner: "acme", repo: "app", number: 1 }, body: { title: "Fix" } },
        request: jest.fn(),
      })
    ).rejects.toThrow("OpenAPI request origin is not approved")

    await expect(
      executeOpenApiOperation({
        provider,
        operationId: "updateIssue",
        baseUrl: "https://api.example.test/v1",
        approvedOrigins: ["https://api.example.test"],
        args: { path: { owner: "acme", repo: "app", number: 1 }, body: { title: "Fix" } },
        request: jest.fn().mockResolvedValue({ status: 302, headers: {}, data: null }),
      })
    ).rejects.toThrow("OpenAPI redirects require a new origin review")
  })

  it("projects compiled operations without changing their provider-native execution", () => {
    __resetExternalServiceCatalogForTesting()
    registerExternalServices("plugin", [
      {
        id: "issues",
        label: "Issues",
        fallbackPolicy: "never",
        providers: [
          {
            id: "api",
            kind: "openapi",
            contributionId: "issues-api",
            priority: 100,
            surfaces: ["chat", "workflow"],
          },
        ],
      },
    ])

    projectOpenApiCapabilities({
      pluginId: "plugin",
      serviceId: "issues",
      providerId: "api",
      surfaces: ["chat", "workflow"],
      provider,
    })

    expect(listExternalCapabilities()).toEqual([
      expect.objectContaining({
        capabilityId: "updateIssue",
        operationId: "updateIssue",
        risk: "write",
        kind: "action",
      }),
    ])
  })
})
