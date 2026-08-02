import test from "node:test"
import assert from "node:assert/strict"

import {
  extractBlock,
  stripNonCode,
  extractOptionsFields,
  extractQueryMethods,
  extractMessageTypes,
  extractHookEvents,
  extractExports,
  extractSurface,
  diffSurface,
  SURFACE_STATUSES,
  TRIAGED_KINDS,
} from "./sdk-surface.mjs"

/**
 * A miniature `sdk.d.ts`. Every trap the real file contains is represented:
 * braces inside doc-comment examples, braces inside string literals, a nested
 * object type as a field value, and a union field spanning several lines.
 */
const FIXTURE = `
export declare type AgentDefinition = {
    description: string;
};

export declare const HOOK_EVENTS: readonly ["PreToolUse", "PostToolUse", "Stop"];

export declare type Options = {
    /**
     * Redirect built-in tool names.
     * @example
     * \`\`\`typescript
     * toolAliases: { Bash: 'mcp__workspace__bash' }
     * \`\`\`
     */
    toolAliases?: Record<string, string>;
    tools?: string[] | {
        type: 'preset';
        preset: 'claude_code';
    };
    env?: {
        [envVar: string]: string | undefined;
    };
    maxTurns?: number;
};

export declare interface Query extends AsyncGenerator<SDKMessage, void> {
    interrupt(): Promise<void>;
    rewindFiles(userMessageId: string, options?: {
        dryRun?: boolean;
    }): Promise<RewindFilesResult>;
    close(): void;
}

export declare type SDKMessage = SDKAssistantMessage | SDKUserMessage | SDKResultMessage;

export declare function query(): Query;
export declare class InMemorySessionStore {
}
`

test("stripNonCode blanks string literals so their braces are not counted", () => {
  const line = `    alias?: string; // e.g. { a: '}' }`
  const out = stripNonCode(line)
  assert.equal(out.length, line.length, "length must be preserved")
  assert.ok(!out.includes("}"), "braces inside a comment must not survive")
})

test("stripNonCode keeps structural braces outside strings", () => {
  assert.ok(stripNonCode("    env?: {").includes("{"))
})

test("extractBlock returns null for an absent declaration", () => {
  assert.equal(extractBlock(FIXTURE, "export declare type Nope = {"), null)
})

test("extractBlock throws on unbalanced braces rather than truncating", () => {
  assert.throws(
    () =>
      extractBlock(
        "export declare type Options = {\n    a?: string;\n",
        "export declare type Options = {"
      ),
    /unterminated block/
  )
})

test("extractOptionsFields ignores nested object members and doc-comment braces", () => {
  assert.deepEqual(extractOptionsFields(FIXTURE), ["toolAliases", "tools", "env", "maxTurns"])
})

test("extractQueryMethods ignores nested option-object members", () => {
  assert.deepEqual(extractQueryMethods(FIXTURE), ["interrupt", "rewindFiles", "close"])
})

test("extractMessageTypes splits the union", () => {
  assert.deepEqual(extractMessageTypes(FIXTURE), [
    "SDKAssistantMessage",
    "SDKUserMessage",
    "SDKResultMessage",
  ])
})

test("extractHookEvents reads the readonly tuple", () => {
  assert.deepEqual(extractHookEvents(FIXTURE), ["PreToolUse", "PostToolUse", "Stop"])
})

test("extractExports covers functions, classes and types", () => {
  const exports = extractExports(FIXTURE)
  for (const name of [
    "AgentDefinition",
    "HOOK_EVENTS",
    "Options",
    "Query",
    "query",
    "InMemorySessionStore",
  ]) {
    assert.ok(exports.includes(name), `expected export ${name}`)
  }
})

test("extractSurface sorts and de-duplicates every kind", () => {
  const s = extractSurface(FIXTURE)
  for (const kind of Object.keys(s)) {
    assert.deepEqual(s[kind], [...s[kind]].sort(), `${kind} must be sorted`)
    assert.equal(new Set(s[kind]).size, s[kind].length, `${kind} must be unique`)
  }
})

test("extractOptionsFields throws a named error when the declaration is gone", () => {
  assert.throws(() => extractOptionsFields("export declare type Other = {\n};\n"), /Options/)
})

// ---- diffSurface ------------------------------------------------------------

const SURFACE = {
  options: ["a", "b"],
  queryMethods: [],
  messages: [],
  hookEvents: [],
  exports: ["E"],
}

function manifest(overrides = {}) {
  return {
    surface: {
      options: { a: { status: "supported" }, b: { status: "planned" } },
      queryMethods: {},
      messages: {},
      hookEvents: {},
      exports: ["E"],
      ...overrides,
    },
  }
}

test("diffSurface is silent when the manifest matches", () => {
  assert.deepEqual(diffSurface(SURFACE, manifest()), [])
})

test("diffSurface reports an SDK member the manifest never triaged", () => {
  const m = manifest({ options: { a: { status: "supported" } } })
  const [result] = diffSurface(SURFACE, m)
  assert.equal(result.kind, "options")
  assert.deepEqual(result.added, ["b"])
  assert.deepEqual(result.removed, [])
})

test("diffSurface reports a manifest member the SDK dropped", () => {
  const m = manifest({
    options: {
      a: { status: "supported" },
      b: { status: "planned" },
      gone: { status: "supported" },
    },
  })
  const [result] = diffSurface(SURFACE, m)
  assert.deepEqual(result.removed, ["gone"])
})

test("diffSurface rejects an unknown status", () => {
  const m = manifest({ options: { a: { status: "definitely-maybe" }, b: { status: "planned" } } })
  const [result] = diffSurface(SURFACE, m)
  assert.deepEqual(result.badStatus, ["a"])
})

test("diffSurface rejects a missing status", () => {
  const m = manifest({ options: { a: {}, b: { status: "planned" } } })
  const [result] = diffSurface(SURFACE, m)
  assert.deepEqual(result.badStatus, ["a"])
})

test("exports is drift-only — a plain list, never status-checked", () => {
  assert.ok(!TRIAGED_KINDS.includes("exports"))
  const m = manifest({ exports: ["E", "Stale"] })
  const [result] = diffSurface(SURFACE, m)
  assert.equal(result.kind, "exports")
  assert.deepEqual(result.removed, ["Stale"])
  assert.deepEqual(result.badStatus, [])
})

test("every status the seeded manifest uses is in the allowed set", () => {
  assert.deepEqual(SURFACE_STATUSES, ["supported", "planned", "host-only", "not-applicable"])
})
