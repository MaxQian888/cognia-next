import {
  classifyStructuredOutcome,
  expectsStructuredOutput,
  validateClaudeAgentSdkOptions,
} from "./claude-agent-sdk-options"
import type { ClaudeAgentSdkOptionsV1 } from "./claude-agent-sdk-options"
import { SDK_RESULT_SUBTYPES } from "./index"

const base: ClaudeAgentSdkOptionsV1 = { version: 1 }

const errorsOf = (v: unknown, flat = {}) => validateClaudeAgentSdkOptions(v, flat).errors.join("\n")

describe("validateClaudeAgentSdkOptions", () => {
  it("accepts an empty versioned block", () => {
    expect(validateClaudeAgentSdkOptions(base)).toEqual({ ok: true, errors: [], warnings: [] })
  })

  it("rejects a non-object or an unknown version outright", () => {
    expect(validateClaudeAgentSdkOptions(null).ok).toBe(false)
    expect(validateClaudeAgentSdkOptions("nope").ok).toBe(false)
    expect(errorsOf({ version: 2 })).toMatch(/version must be 1/)
    // A block with no version is a shape from before the contract existed.
    expect(errorsOf({ outputFormat: { type: "json_schema", schema: {} } })).toMatch(
      /version must be 1/
    )
  })

  describe("session shape", () => {
    it("refuses a session store with persistence turned off", () => {
      expect(
        errorsOf({ ...base, sessionStore: { backend: "host-sqlite" }, persistSession: false })
      ).toMatch(/would be written to and never read back/)
    })

    it("refuses a session store alongside file checkpointing", () => {
      // The SDK owns checkpoint storage; a custom store cannot mirror it.
      expect(
        errorsOf({
          ...base,
          sessionStore: { backend: "host-sqlite" },
          enableFileCheckpointing: true,
        })
      ).toMatch(/mutually exclusive/)
    })

    it("refuses an unknown store backend rather than falling back to a default", () => {
      expect(errorsOf({ ...base, sessionStore: { backend: "s3" } })).toMatch(
        /backend "s3" is unknown/
      )
    })

    it("refuses two ways of continuing the same session", () => {
      expect(errorsOf({ ...base, continue: true, sessionId: "s-1" })).toMatch(
        /conflicting session continuation: continue \+ sessionId/
      )
      expect(errorsOf({ ...base, continue: true }, { resume: "s-1" })).toMatch(/continue \+ resume/)
      expect(errorsOf({ ...base, sessionId: "s-1" }, { resume: "s-2" })).toMatch(
        /sessionId \+ resume/
      )
    })

    it("accepts exactly one continuation signal", () => {
      expect(validateClaudeAgentSdkOptions({ ...base, continue: true }).ok).toBe(true)
      expect(validateClaudeAgentSdkOptions(base, { resume: "s-1" }).ok).toBe(true)
    })

    it("refuses resumeSessionAt with nothing to resume", () => {
      expect(errorsOf({ ...base, resumeSessionAt: "msg-1" })).toMatch(/needs a session to resume/)
      expect(
        validateClaudeAgentSdkOptions({ ...base, resumeSessionAt: "m" }, { resume: "s" }).ok
      ).toBe(true)
    })

    it("refuses a fork with no parent", () => {
      expect(errorsOf(base, { forkSession: true })).toMatch(/there is nothing to fork from/)
      expect(validateClaudeAgentSdkOptions(base, { forkSession: true, resume: "s-1" }).ok).toBe(
        true
      )
    })
  })

  describe("dangerous permissions", () => {
    const dangerous = { ...base, allowDangerouslySkipPermissions: true }

    it("refuses to skip permissions without the matching permission mode", () => {
      expect(errorsOf(dangerous, { bypassConfirmed: true })).toMatch(
        /requires permissionMode 'bypassPermissions'; got 'default'/
      )
    })

    it("refuses to skip permissions without a confirmed policy AND user consent", () => {
      // The field is a request, never a grant — the confirmation lives outside
      // the payload precisely so a renderer cannot self-authorise.
      expect(errorsOf(dangerous, { permissionMode: "bypassPermissions" })).toMatch(
        /without a confirmed host policy \+ user confirmation/
      )
    })

    it("allows it only when both gates passed", () => {
      expect(
        validateClaudeAgentSdkOptions(dangerous, {
          permissionMode: "bypassPermissions",
          bypassConfirmed: true,
        }).ok
      ).toBe(true)
    })
  })

  describe("structured output", () => {
    it("accepts a draft-07 schema", () => {
      expect(
        validateClaudeAgentSdkOptions({
          ...base,
          outputFormat: {
            type: "json_schema",
            schema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object" },
          },
        }).ok
      ).toBe(true)
    })

    it("names the exact fix for a newer draft the SDK will reject", () => {
      expect(
        errorsOf({
          ...base,
          outputFormat: {
            type: "json_schema",
            schema: { $schema: "https://json-schema.org/draft/2020-12/schema" },
          },
        })
      ).toMatch(/requires JSON Schema draft-07 \(Zod: z\.toJSONSchema/)
    })

    it("accepts a schema that declares no $schema at all", () => {
      expect(
        validateClaudeAgentSdkOptions({
          ...base,
          outputFormat: { type: "json_schema", schema: { type: "object" } },
        }).ok
      ).toBe(true)
    })

    it("rejects a non-object schema and an unsupported format", () => {
      expect(errorsOf({ ...base, outputFormat: { type: "json_schema", schema: "x" } })).toMatch(
        /must be a JSON Schema object/
      )
      expect(errorsOf({ ...base, outputFormat: { type: "yaml", schema: {} } })).toMatch(
        /"yaml" is unsupported/
      )
    })
  })

  describe("extension surfaces", () => {
    it("accepts local plugins and rejects anything else", () => {
      expect(
        validateClaudeAgentSdkOptions({ ...base, plugins: [{ type: "local", path: "/p" }] }).ok
      ).toBe(true)
      expect(errorsOf({ ...base, plugins: [{ type: "remote", path: "https://x" }] })).toMatch(
        /unsupported plugin type "remote"/
      )
      expect(errorsOf({ ...base, plugins: [{ type: "local", path: "" }] })).toMatch(
        /needs a non-empty path/
      )
    })

    it('accepts skills as a list or "all"', () => {
      expect(validateClaudeAgentSdkOptions({ ...base, skills: "all" }).ok).toBe(true)
      expect(validateClaudeAgentSdkOptions({ ...base, skills: ["a"] }).ok).toBe(true)
      expect(errorsOf({ ...base, skills: "some" })).toMatch(/must be a string array or "all"/)
    })
  })

  describe("limits", () => {
    it("rejects non-positive budgets and timeouts", () => {
      expect(errorsOf({ ...base, taskBudget: { total: 0 } })).toMatch(/must be a positive number/)
      expect(errorsOf({ ...base, loadTimeoutMs: -1 })).toMatch(/must be a positive number/)
      expect(validateClaudeAgentSdkOptions({ ...base, taskBudget: { total: 1 } }).ok).toBe(true)
    })
  })

  describe("extraArgs", () => {
    it("refuses flags that re-open a host-only capability", () => {
      // The whole point of leaving `settings` / `executable` out of the type is
      // that a renderer cannot reach them; a raw CLI flag would undo that.
      for (const flag of ["settings", "mcp-config", "add-dir", "dangerously-skip-permissions"]) {
        expect(errorsOf({ ...base, extraArgs: { [flag]: null } })).toMatch(
          new RegExp(`extraArgs\\["${flag}"\\] is refused`)
        )
      }
    })

    it("allows an ordinary flag through", () => {
      expect(validateClaudeAgentSdkOptions({ ...base, extraArgs: { verbose: null } }).ok).toBe(true)
    })

    it("warns that the host manages replay-user-messages under checkpointing", () => {
      const result = validateClaudeAgentSdkOptions({
        ...base,
        enableFileCheckpointing: true,
        extraArgs: { "replay-user-messages": "no" },
      })
      expect(result.ok).toBe(true)
      expect(result.warnings.join("\n")).toMatch(/managed by the host/)
    })
  })

  it("warns when tools is explicitly empty rather than silently running toolless", () => {
    const result = validateClaudeAgentSdkOptions({ ...base, tools: [] })
    expect(result.ok).toBe(true)
    expect(result.warnings.join("\n")).toMatch(/no tools at all/)
  })

  it("reports every independent failure at once, not just the first", () => {
    const result = validateClaudeAgentSdkOptions({
      ...base,
      sessionStore: { backend: "host-sqlite" },
      persistSession: false,
      enableFileCheckpointing: true,
      taskBudget: { total: -5 },
    })
    expect(result.ok).toBe(false)
    expect(result.errors.length).toBeGreaterThanOrEqual(3)
  })
})

describe("expectsStructuredOutput", () => {
  it("is true only for a block carrying an outputFormat", () => {
    expect(expectsStructuredOutput({ version: 1, outputFormat: { type: "json_schema" } })).toBe(
      true
    )
    expect(expectsStructuredOutput({ version: 1 })).toBe(false)
    expect(expectsStructuredOutput(undefined)).toBe(false)
    // A malformed value must not read as a request: the classifier would then
    // report `missing` on every turn of a session nobody asked a schema of.
    expect(expectsStructuredOutput({ version: 1, outputFormat: "json_schema" })).toBe(false)
    expect(expectsStructuredOutput({ version: 1, outputFormat: {} })).toBe(false)
  })
})

describe("classifyStructuredOutcome", () => {
  const success = { subtype: "success", is_error: false }

  it("says nothing at all when no schema was requested", () => {
    // Not `{ status: "missing" }` — a plain chat turn has no structured-output
    // outcome, and reporting one would make the status meaningless.
    expect(classifyStructuredOutcome({ ...success }, false)).toBeNull()
    expect(classifyStructuredOutcome({ subtype: "error_max_turns" }, false)).toBeNull()
  })

  it("returns the parsed value on a satisfied contract", () => {
    expect(classifyStructuredOutcome({ ...success, structured_output: { a: 1 } }, true)).toEqual({
      status: "ok",
      output: { a: 1 },
    })
  })

  it("treats falsy-but-present output as ok, not as missing", () => {
    // `null`, `0`, `""` and `false` are all legal JSON Schema values. Only
    // `undefined` means the SDK sent nothing, so the check is on `undefined`
    // rather than truthiness.
    for (const output of [null, 0, "", false]) {
      expect(classifyStructuredOutcome({ ...success, structured_output: output }, true)).toEqual({
        status: "ok",
        output,
      })
    }
  })

  it("flags a SUCCESSFUL turn that returned no structured output", () => {
    // The trap this whole classification exists for: the SDK reports success,
    // `is_error` is false, and the caller still has no value.
    expect(classifyStructuredOutcome(success, true)).toEqual({ status: "missing" })
  })

  it("separates exhausted schema retries from a plain missing value", () => {
    expect(
      classifyStructuredOutcome({ subtype: "error_max_structured_output_retries" }, true)
    ).toEqual({ status: "retries-exhausted" })
  })

  it("blames the ceiling, not the schema, when the turn never finished", () => {
    for (const subtype of ["error_max_turns", "error_max_budget_usd", "error_during_execution"]) {
      expect(classifyStructuredOutcome({ subtype }, true)).toEqual({ status: "turn-incomplete" })
    }
  })

  it("does not call a turn ok when the SDK set is_error on a success subtype", () => {
    expect(classifyStructuredOutcome({ ...success, is_error: true }, true)).toEqual({
      status: "turn-incomplete",
    })
  })

  it("classifies every subtype the pinned SDK can emit", () => {
    // Walks the gate-verified vocabulary rather than a hand-written list, so a
    // new SDK subtype cannot land on an unexamined branch.
    const seen = new Set(
      SDK_RESULT_SUBTYPES.map((subtype) => classifyStructuredOutcome({ subtype }, true)?.status)
    )
    expect(seen).toEqual(new Set(["missing", "retries-exhausted", "turn-incomplete"]))
    expect(SDK_RESULT_SUBTYPES).toHaveLength(5)
  })
})
