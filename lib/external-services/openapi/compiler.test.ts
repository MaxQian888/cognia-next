import { compileOpenApiDocument, OpenApiCompileError } from "./compiler"

const SPEC = `
openapi: 3.2.0
info:
  title: Example
  version: 1.0.0
servers:
  - url: https://api.example.test/v1
paths:
  /issues/{issueId}:
    parameters:
      - name: issueId
        in: path
        required: true
        schema: { type: string }
    get:
      operationId: getIssue
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Issue' }
    patch:
      operationId: updateIssue
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                title: { type: string }
      responses:
        '200': { description: ok }
    delete:
      operationId: deleteIssue
      responses:
        '204': { description: deleted }
webhooks:
  issueChanged:
    post:
      operationId: issueChanged
      responses:
        '200': { description: accepted }
components:
  securitySchemes:
    bearer:
      type: http
      scheme: bearer
  schemas:
    Issue:
      type: object
      properties:
        id: { type: string }
`

describe("OpenAPI compiler", () => {
  it("normalizes operations, schemas, origins, auth, and risk for OpenAPI 3.2", () => {
    const result = compileOpenApiDocument(SPEC, {
      sourceUrl: "https://specs.example.test/openapi.yaml",
    })

    expect(result.version).toBe("3.2.0")
    expect(result.allowedOrigins).toEqual(["https://api.example.test"])
    expect(result.securitySchemes).toEqual([
      expect.objectContaining({ id: "bearer", type: "http", scheme: "bearer" }),
    ])
    expect(result.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operationId: "getIssue", method: "GET", risk: "read" }),
        expect.objectContaining({ operationId: "updateIssue", method: "PATCH", risk: "write" }),
        expect.objectContaining({
          operationId: "deleteIssue",
          method: "DELETE",
          risk: "destructive",
        }),
      ])
    )
    expect(
      result.operations.find((operation) => operation.operationId === "getIssue")?.outputSchema
    ).toMatchObject({ type: "object", properties: { id: { type: "string" } } })
    expect(result.webhooks).toEqual([
      expect.objectContaining({ id: "issueChanged", enabled: false }),
    ])
  })

  it.each(["3.0.4", "3.1.2", "3.2.0"])("accepts supported OpenAPI %s documents", (version) => {
    expect(
      compileOpenApiDocument({
        openapi: version,
        info: { title: "Example", version: "1" },
        paths: {},
      }).version
    ).toBe(version)
  })

  it("rejects external refs that are not explicitly approved", () => {
    const spec = {
      openapi: "3.1.2",
      info: { title: "Example", version: "1" },
      paths: {
        "/items": {
          get: {
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: { $ref: "https://evil.example/schema.json#/Item" },
                  },
                },
              },
            },
          },
        },
      },
    }

    expect(() =>
      compileOpenApiDocument(spec, { sourceUrl: "https://api.example.test/openapi.json" })
    ).toThrow(new OpenApiCompileError("external-ref-origin-not-approved"))
  })

  it("rejects cyclic local references instead of recursing indefinitely", () => {
    expect(() =>
      compileOpenApiDocument({
        openapi: "3.1.2",
        info: { title: "Example", version: "1" },
        components: { schemas: { Loop: { $ref: "#/components/schemas/Loop" } } },
        paths: {
          "/loop": {
            get: {
              responses: {
                "200": {
                  description: "ok",
                  content: {
                    "application/json": { schema: { $ref: "#/components/schemas/Loop" } },
                  },
                },
              },
            },
          },
        },
      })
    ).toThrow(new OpenApiCompileError("cyclic-ref"))
  })
})
