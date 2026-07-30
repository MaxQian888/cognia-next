import {
  TEMPLATE_API_VERSION,
  createTemplateDefinition,
  suggestTemplateVersionBump,
  validateTemplateDefinition,
} from "./contracts"

describe("template contracts", () => {
  it("creates a canonical draft with a stable content hash", async () => {
    const first = await createTemplateDefinition({
      id: "team.review",
      domain: "agentTeam",
      status: "draft",
      revision: 1,
      metadata: { name: "Review team", tags: ["review"] },
      payload: { config: { executionMode: "coordinated" }, teammates: [] },
      inputs: [],
      dependencies: [],
      capabilities: [],
      compatibility: { platforms: ["desktop", "web"] },
      provenance: { source: "user" },
    })
    const second = await createTemplateDefinition({
      ...first,
      contentHash: undefined,
      baselineHash: undefined,
      status: "deprecated",
      revision: 9,
      provenance: { source: "file", trust: "unsigned" },
      metadata: { tags: ["review"], name: "Review team" },
      payload: { teammates: [], config: { executionMode: "coordinated" } },
    })

    expect(first.apiVersion).toBe(TEMPLATE_API_VERSION)
    expect(first.contentHash).toMatch(/^[0-9a-f]{64}$/)
    expect(second.contentHash).toBe(first.contentHash)
  })

  it("rejects non-portable Twin, credential, and local-path fields", async () => {
    const definition = await createTemplateDefinition({
      id: "team.private",
      domain: "agentTeam",
      status: "draft",
      revision: 1,
      metadata: { name: "Private team" },
      payload: {
        teammates: [{ name: "Researcher", twinId: "local-twin" }],
        credentialId: "cred-1",
        localPath: "/Users/example/private",
      },
      inputs: [],
      dependencies: [],
      capabilities: [],
      compatibility: { platforms: ["desktop"] },
      provenance: { source: "user" },
    })

    const result = validateTemplateDefinition(definition)
    expect(result.ok).toBe(false)
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "portable.private-field",
        "portable.credential-field",
        "portable.local-path-field",
      ])
    )
  })

  it("requires deterministic behavior for optional dependencies", async () => {
    const definition = await createTemplateDefinition({
      id: "workflow.optional",
      domain: "workflow",
      status: "draft",
      revision: 1,
      metadata: { name: "Optional connector" },
      payload: { nodes: [] },
      inputs: [],
      dependencies: [
        {
          id: "connector.mail",
          kind: "plugin",
          requirement: "optional",
          version: "^1.0.0",
        },
      ],
      capabilities: [],
      compatibility: { platforms: ["desktop", "web"] },
      provenance: { source: "user" },
    })

    expect(validateTemplateDefinition(definition)).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: "dependency.optional-fallback" })],
    })
  })

  it("allows declared interpolation and rejects expressions or property access", async () => {
    const safe = await createTemplateDefinition({
      id: "skill.safe",
      domain: "skill",
      status: "draft",
      revision: 1,
      metadata: { name: "Safe" },
      payload: { content: "Summarize {{topic}}" },
      inputs: [{ id: "topic", kind: "string", label: "Topic", required: true }],
      dependencies: [],
      capabilities: [],
      compatibility: { platforms: ["desktop"] },
      provenance: { source: "user" },
    })
    expect(validateTemplateDefinition(safe).ok).toBe(true)

    for (const content of [
      "{{topic.name}}",
      "{{unknown}}",
      "{{topic",
      "topic}}",
      "${process.env.SECRET}",
    ]) {
      expect(validateTemplateDefinition({ ...safe, payload: { content } }).issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: expect.stringMatching(/^interpolation\./) }),
        ])
      )
    }
  })

  it("classifies structural compatibility conservatively", async () => {
    const base = await createTemplateDefinition({
      id: "skill.summary",
      domain: "skill",
      status: "published",
      revision: 1,
      version: "1.2.3",
      metadata: { name: "Summary" },
      payload: { content: "Summarize {{topic}}" },
      inputs: [
        { id: "topic", kind: "string", label: "Topic", required: true },
        { id: "tone", kind: "enum", label: "Tone", required: false, options: ["brief", "full"] },
      ],
      dependencies: [],
      capabilities: [],
      compatibility: { platforms: ["desktop", "web", "mobile"] },
      provenance: { source: "user" },
    })
    const breaking = await createTemplateDefinition({
      ...base,
      status: "draft",
      revision: 2,
      version: null,
      contentHash: undefined,
      baselineHash: base.contentHash,
      inputs: [{ id: "topic", kind: "string", label: "Topic", required: true }],
    })

    expect(suggestTemplateVersionBump(base, breaking)).toMatchObject({
      bump: "major",
      reasons: [expect.stringContaining("tone")],
    })
  })
})
