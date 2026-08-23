import test from "node:test"
import assert from "node:assert/strict"

import {
  extractBlock,
  stripNonCode,
  extractOptionsFields,
  extractQueryMethods,
  extractMessageTypes,
  extractMessageDiscriminant,
  extractMessageDiscriminants,
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

test("extractHookEvents accepts the SDK's single-quoted readonly tuple", () => {
  const source = "export declare const HOOK_EVENTS: readonly ['PreToolUse', 'PostToolUseFailure'];"
  assert.deepEqual(extractHookEvents(source), ["PreToolUse", "PostToolUseFailure"])
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

// ---- wire discriminants -----------------------------------------------------

const DISCRIMINANT_SOURCE = `
export declare type SDKMessage = SDKStatusMessage | SDKToolProgressMessage | SDKResultMessage;
export declare type SDKStatusMessage = {
    type: 'system';
    subtype: 'status';
    status: SDKStatus;
};
export declare type SDKToolProgressMessage = {
    type: 'tool_progress';
    tool_use_id: string;
};
export declare type SDKResultMessage = SDKResultSuccess | SDKResultError;
export declare type SDKResultSuccess = {
    type: 'result';
    subtype: 'success';
    result: string;
};
export declare type SDKResultError = {
    type: 'result';
    subtype: 'error_max_turns' | 'error_during_execution';
    is_error: true;
};
`

test("extractMessageDiscriminant reads the type and its subtype", () => {
  assert.deepEqual(extractMessageDiscriminant(DISCRIMINANT_SOURCE, "SDKStatusMessage"), {
    type: "system",
    subtypes: ["status"],
  })
})

test("extractMessageDiscriminant returns no subtypes when there are none", () => {
  assert.deepEqual(extractMessageDiscriminant(DISCRIMINANT_SOURCE, "SDKToolProgressMessage"), {
    type: "tool_progress",
    subtypes: [],
  })
})

test("extractMessageDiscriminant resolves an alias union instead of guessing", () => {
  // `SDKResultMessage` is `SDKResultSuccess | SDKResultError`. Scanning to the
  // next `\n};` would run past the alias into whichever declaration follows and
  // report that one's discriminant as if it were the union's.
  assert.deepEqual(extractMessageDiscriminant(DISCRIMINANT_SOURCE, "SDKResultMessage"), {
    type: "result",
    subtypes: ["error_during_execution", "error_max_turns", "success"],
  })
})

test("extractMessageDiscriminant refuses a union whose members disagree on type", () => {
  const mixed = DISCRIMINANT_SOURCE.replace(
    "export declare type SDKResultError = {\n    type: 'result';",
    "export declare type SDKResultError = {\n    type: 'other';"
  )
  assert.throws(
    () => extractMessageDiscriminant(mixed, "SDKResultMessage"),
    /mixes wire types \(result, other\)/
  )
})

test("extractMessageDiscriminant names the member it could not find", () => {
  assert.throws(() => extractMessageDiscriminant(DISCRIMINANT_SOURCE, "SDKGhost"), /SDKGhost/)
})

test("extractMessageDiscriminants covers every union member", () => {
  const all = extractMessageDiscriminants(DISCRIMINANT_SOURCE)
  assert.deepEqual(Object.keys(all).sort(), [
    "SDKResultMessage",
    "SDKStatusMessage",
    "SDKToolProgressMessage",
  ])
})
