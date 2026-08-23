import { inspectOpenApiDocument, installReviewedOpenApi, loadOpenApiFromUrl } from "./importer"

const ROOT = `openapi: 3.2.0
info: { title: Example, version: "1" }
servers: [{ url: https://api.example.test/v1 }]
paths:
  /items:
    post:
      operationId: createItem
      requestBody:
        content:
          application/json:
            schema: { $ref: https://schemas.example.test/common.yaml#/$defs/Item }
      responses: { "204": { description: ok } }
`

const EXTERNAL = `$defs:
  Item:
    type: object
    properties: { name: { type: string } }
`

const LOCAL = `openapi: 3.1.0
info: { title: Example, version: "1" }
servers: [{ url: https://api.example.test/v1 }]
paths:
  /items:
    post:
      operationId: createItem
      responses: { "204": { description: ok } }
`

function deps() {
  return {
    fetch: jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      return new Response(url.includes("common.yaml") ? EXTERNAL : ROOT, {
        status: 200,
        headers: { "content-type": "application/yaml" },
      })
    }),
    hash: jest.fn(async () => "a".repeat(64)),
    persist: jest.fn(async () => undefined),
    randomUUID: () => "import-1",
  }
}

describe("OpenAPI importer", () => {
  it("fetches reviewed external refs with credentials omitted and manual redirects", async () => {
    const runtime = deps()
    const inspection = await loadOpenApiFromUrl(
      "https://api.example.test/openapi.yaml",
      { approvedExternalRefOrigins: ["https://schemas.example.test"] },
      runtime
    )

    expect(runtime.fetch).toHaveBeenCalledTimes(2)
    expect(runtime.fetch).toHaveBeenCalledWith(
      "https://schemas.example.test/common.yaml",
      expect.objectContaining({ credentials: "omit", redirect: "manual", blockPrivateHosts: true })
    )
    expect(inspection.externalDocuments).toEqual(
      expect.objectContaining({ "https://schemas.example.test/common.yaml": EXTERNAL })
    )
    expect(inspection.provider.operations[0].inputSchema).not.toHaveProperty("$ref")
  })

  it("requires exact origin and risk review before persisting a connected account", async () => {
    const runtime = deps()
    const inspection = await inspectOpenApiDocument(
      { document: LOCAL, sourceKind: "file" },
      runtime
    )

    await expect(
      installReviewedOpenApi(
        {
          inspection,
          label: "Example",
          runtimeTargetId: "local",
          approvedOrigins: ["https://api.example.test"],
          reviewedRisks: {},
        },
        runtime
      )
    ).rejects.toThrow("Every OpenAPI operation risk must be reviewed")

    const installed = await installReviewedOpenApi(
      {
        inspection,
        label: "Example",
        runtimeTargetId: "local",
        approvedOrigins: ["https://api.example.test"],
        reviewedRisks: { createItem: "write" },
      },
      runtime
    )

    expect(installed.row.trust).toBe("untrusted")
    expect(installed.connection).toEqual(
      expect.objectContaining({
        status: "connected",
        providerRef: expect.objectContaining({ kind: "openapi", importId: installed.row.id }),
      })
    )
    expect(runtime.persist).toHaveBeenCalledWith(installed.row, installed.connection)
  })

  it("rejects private and redirecting remote specs before parsing", async () => {
    const runtime = deps()
    await expect(loadOpenApiFromUrl("http://127.0.0.1/spec", {}, runtime)).rejects.toThrow(
      "must use HTTPS"
    )
    runtime.fetch.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: "https://other.test/spec" } })
    )
    await expect(
      loadOpenApiFromUrl("https://api.example.test/openapi.yaml", {}, runtime)
    ).rejects.toThrow("redirects require a new origin review")
  })
})
