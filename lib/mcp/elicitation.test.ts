import { approvalElicitationRequest, createMcpElicitationRequest } from "./elicitation"

describe("runtime elicitation approval adapter", () => {
  it("supports portable and historical interaction markers without reinterpreting ordinary tool input", () => {
    const input = { elicitation: { mode: "form", message: "Question", propertyOrder: ["b", "a"] } }
    for (const toolName of ["Runtime:Elicitation", "SDK:Elicitation"]) {
      expect(approvalElicitationRequest({ toolName, requestId: "req", input })).toMatchObject({
        id: "req",
        propertyOrder: ["b", "a"],
      })
    }
    expect(
      approvalElicitationRequest({ toolName: "Read", requestId: "req", input })
    ).toBeUndefined()
    expect(
      approvalElicitationRequest({
        toolName: "Runtime:Elicitation",
        requestId: "req",
        input: { elicitation: { mode: "url", message: "Login", url: "javascript:alert(1)" } },
      })
    ).toBeUndefined()
  })
})

const provenance = { serverId: "mcp_figma", serverName: "Figma" }

describe("createMcpElicitationRequest", () => {
  it("preserves portable presentation order for MCP forms", () => {
    expect(
      createMcpElicitationRequest(
        {
          params: {
            message: "Question",
            propertyOrder: ["second", "first"],
            requestedSchema: {
              type: "object",
              properties: { first: { type: "string" }, second: { type: "string" } },
            },
          },
        },
        provenance
      )
    ).toMatchObject({ propertyOrder: ["second", "first"] })
  })
  it("preserves structured form fields and server provenance", () => {
    expect(
      createMcpElicitationRequest(
        {
          params: {
            message: "Choose a component",
            requestedSchema: {
              type: "object",
              properties: { component: { type: "string", title: "Component" } },
              required: ["component"],
            },
          },
        },
        provenance
      )
    ).toEqual({
      mode: "form",
      message: "Choose a component",
      requestedSchema: {
        type: "object",
        properties: { component: { type: "string", title: "Component" } },
        required: ["component"],
      },
      provenance,
    })
  })

  it.each(["password", "api_key", "paymentCard", "cvv", "accessToken"])(
    "rejects sensitive field %s from ordinary forms",
    (field) => {
      expect(() =>
        createMcpElicitationRequest(
          {
            params: {
              message: "Credentials",
              requestedSchema: {
                type: "object",
                properties: { [field]: { type: "string" } },
              },
            },
          },
          provenance
        )
      ).toThrow("cannot request sensitive field")
    }
  )

  it("exposes the URL target hostname for explicit confirmation", () => {
    expect(
      createMcpElicitationRequest(
        {
          params: {
            mode: "url",
            message: "Authorize this operation",
            elicitationId: "elicit_1",
            url: "https://accounts.example.com/authorize?request=1",
          },
        },
        provenance
      )
    ).toEqual({
      mode: "url",
      message: "Authorize this operation",
      elicitationId: "elicit_1",
      url: "https://accounts.example.com/authorize?request=1",
      targetOrigin: "https://accounts.example.com",
      targetHostname: "accounts.example.com",
      provenance,
    })
  })

  it("rejects insecure and credential-bearing URLs", () => {
    for (const url of ["http://example.com/auth", "https://user:secret@example.com/auth"]) {
      expect(() =>
        createMcpElicitationRequest(
          {
            params: { mode: "url", message: "Auth", elicitationId: "1", url },
          },
          provenance
        )
      ).toThrow()
    }
  })
})
