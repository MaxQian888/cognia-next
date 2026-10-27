import { gooseSessionSource } from "./goose"

const fixture = {
  id: "goose-child",
  working_dir: "/repo",
  name: "Read file",
  session_type: "sub_agent",
  parent_session_id: "goose-parent",
  created_at: "2026-10-25T00:00:00Z",
  model_config: { model: "example" },
  conversation: [
    { id: "u", role: "user", created: 1792886400, content: [{ type: "text", text: "Read file" }] },
    {
      id: "a",
      role: "assistant",
      created: 1792886401,
      content: [
        { type: "thinking", thinking: "Inspect first" },
        {
          type: "toolRequest",
          id: "call",
          toolCall: { status: "success", value: { name: "read", arguments: { path: "file" } } },
        },
      ],
      metadata: { usage: { inputTokens: 10, outputTokens: 3, cacheReadTokens: 2 } },
    },
    {
      id: "r",
      role: "user",
      created: 1792886402,
      content: [
        {
          type: "toolResponse",
          id: "call",
          toolResult: {
            status: "success",
            value: { content: [{ type: "text", text: "contents" }] },
          },
        },
      ],
    },
    {
      role: "user",
      content: [{ type: "text", text: "hidden secret" }],
      metadata: { userVisible: false },
    },
  ],
}

const input = {
  home: "",
  fs: {
    exists: async () => false,
    readDir: async () => [],
    stat: async () => ({ size: 0, isFile: true }),
    readTextFile: async () => "",
  },
  pickedFiles: [
    { name: "goose.json", path: "/fixture/goose.json", content: JSON.stringify(fixture) },
  ],
}

it("detects actual Goose structure without claiming arbitrary conversation JSON", async () => {
  expect(gooseSessionSource.detect(input.pickedFiles)).toBe("match")
  expect(
    gooseSessionSource.detect([
      { name: "other.json", path: "/other.json", content: '{"conversation":[]}' },
    ])
  ).toBe("no")
  const listed = await gooseSessionSource.listSessions(input)
  expect(listed).toHaveLength(1)
  const parsed = await gooseSessionSource.parseSession(listed[0].ref, input)
  expect(JSON.stringify(parsed)).toContain("Inspect first")
  expect(JSON.stringify(parsed)).toContain("contents")
  expect(JSON.stringify(parsed)).not.toContain("hidden secret")
  expect(parsed.messages[0].createdAt).toBe(1792886400000)
  expect(parsed.session.importRuntimeBinding).toBeUndefined()
})

it("keeps equal native session IDs from different stores separate and scopes parent links", async () => {
  const scoped = {
    ...input,
    pickedFiles: ["config-a", "config-b"].flatMap((scope) => [
      {
        name: `${scope}-parent.json`,
        path: `/${scope}/parent.json`,
        content: JSON.stringify({
          ...fixture,
          id: "goose-parent",
          parent_session_id: null,
          _cognia_store: scope,
        }),
      },
      {
        name: `${scope}-child.json`,
        path: `/${scope}/child.json`,
        content: JSON.stringify({ ...fixture, _cognia_store: scope }),
      },
    ]),
  }
  const listed = await gooseSessionSource.listSessions(scoped)
  expect(listed).toHaveLength(2)
  const parsed = await Promise.all(
    listed.map((item) => gooseSessionSource.parseSession(item.ref, scoped))
  )
  expect(
    new Set(parsed.flatMap((item) => [item.session.id, item.nested![0].session.id])).size
  ).toBe(4)
  for (const [index, item] of parsed.entries()) {
    expect(item.nested).toHaveLength(1)
    const scope = listed[index].ref.originalSessionId.includes("config-a") ? "config-a" : "config-b"
    expect(JSON.stringify(item.nested)).toContain(scope)
  }
  expect(JSON.stringify(parsed)).toContain("config-a")
  expect(JSON.stringify(parsed)).toContain("config-b")
})

it("honors Goose's per-block user audience including tool results", async () => {
  const document = structuredClone(fixture)
  document.conversation.push({
    id: "audience",
    role: "assistant",
    content: [
      { type: "text", text: "assistant-only-text", annotations: { audience: ["assistant"] } },
      {
        type: "image",
        data: "assistant-only-image",
        mimeType: "image/png",
        annotations: { audience: [] },
      },
      { type: "text", text: "visible-to-user", annotations: { audience: ["user"] } },
      {
        type: "text",
        text: "assistant-only-malformed-audience",
        annotations: { audience: "assistant" },
      },
      { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
    ],
  } as never)
  const result = document.conversation[2].content[0] as {
    toolResult: { value: { content: unknown[] } }
  }
  result.toolResult.value.content.push({
    type: "text",
    text: "assistant-only-tool-result",
    annotations: { audience: ["assistant"] },
  })
  const scoped = {
    ...input,
    pickedFiles: [
      { name: "audience.json", path: "/audience.json", content: JSON.stringify(document) },
    ],
  }
  const [listed] = await gooseSessionSource.listSessions(scoped)
  const parsed = await gooseSessionSource.parseSession(listed.ref, scoped)
  const serialized = JSON.stringify(parsed)
  expect(serialized).not.toContain("assistant-only")
  expect(serialized).toContain("visible-to-user")
  expect(serialized).toContain("data:image/png;base64,aW1hZ2U=")
  expect(serialized).toContain('"cacheReadInputTokens":2')
})

it("reports malformed export content without exposing damaged visibility context and preserves tool errors", async () => {
  const document = {
    ...fixture,
    conversation: [
      {
        id: "damaged-visibility",
        role: "user",
        metadata: "corrupt",
        content: [{ type: "text", text: "MALFORMED_VISIBILITY_SECRET" }],
      },
      { id: "damaged-content", role: "assistant", content: "MALFORMED_CONTENT_SECRET" },
      {
        id: "damaged-flag",
        role: "user",
        metadata: { userVisible: "false" },
        content: [{ type: "text", text: "MALFORMED_FLAG_SECRET" }],
      },
      fixture.conversation[1],
      {
        id: "error",
        role: "user",
        content: [
          {
            type: "toolResponse",
            id: "call",
            toolResult: { status: "error", error: "Tool denied" },
          },
        ],
      },
    ],
  }
  const scoped = {
    ...input,
    pickedFiles: [
      { name: "damaged.json", path: "/damaged.json", content: JSON.stringify(document) },
    ],
  }
  const [listed] = await gooseSessionSource.listSessions(scoped)
  const parsed = await gooseSessionSource.parseGraph!(listed.ref, scoped)
  const serialized = JSON.stringify(parsed)
  expect(serialized).not.toContain("MALFORMED_")
  expect(serialized).toContain("goose.invalid_content")
  expect(serialized).toContain('"state":"output-error"')
  expect(serialized).toContain("Tool denied")
})
