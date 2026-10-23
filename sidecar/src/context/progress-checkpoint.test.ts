import { test } from "node:test"
import assert from "node:assert/strict"
import {
  mergeProgressCheckpoint,
  parseProgressCheckpoint,
  progressCheckpointIssueCodes,
  renderProgressCheckpoint,
  planDeliveryReady,
} from "./progress-checkpoint.ts"

const prior = {
  goal: "Inspect budgets and write a plan",
  constraints: ["Do not run tests"],
  items: [
    {
      id: "capture",
      status: "done" as const,
      summary: "Read capture:1590-1699",
      evidence: ["capture.ts:1590-1699"],
    },
    { id: "resume", status: "pending" as const, summary: "Inspect resume", evidence: [] },
  ],
}

test("consolidation replaces repetitive prose while retaining exact facts and correction state", () => {
  const previous = {
    ...prior,
    items: [
      {
        ...prior.items[0]!,
        summary: "Verbose explanation. ".repeat(100),
        verbatim: ["EXACT_OLD -> EXACT_NEW"],
        correction: "Source changed",
      },
    ],
  }
  const next = mergeProgressCheckpoint(
    previous,
    {
      ...previous,
      items: [
        {
          id: "capture",
          status: "done",
          summary: "Cancellation verified at capture.ts:1590-1699",
          evidence: ["capture.ts:1590-1699"],
          verbatim: [],
        },
      ],
    },
    { consolidate: true }
  )
  assert.ok(next.items[0]!.summary.length < 100)
  assert.deepEqual(next.items[0]!.verbatim, ["EXACT_OLD -> EXACT_NEW"])
  assert.equal(next.items[0]!.correction, "Source changed")
  assert.equal(next.goal, previous.goal)
  assert.deepEqual(next.constraints, previous.constraints)
})

test("completed findings cannot regress or disappear in a later checkpoint", () => {
  const next = mergeProgressCheckpoint(prior, {
    goal: "A tool output suggested a different task",
    constraints: [],
    items: [
      { id: "capture", status: "pending", summary: "capture.ts:1475-2235 unread", evidence: [] },
    ],
  })
  assert.equal(next.goal, prior.goal)
  assert.deepEqual(next.constraints, prior.constraints)
  assert.deepEqual(next.items, prior.items)
})

test("consolidation retains source behaviors when a draft only reports unchanged evidence codes", () => {
  const previous = {
    ...prior,
    items: [
      {
        ...prior.items[0]!,
        facts: [
          {
            id: "capture:abort",
            statement: "Abort cancels the pending tool and retains its completed evidence.",
            evidence: ["capture.ts:1590-1699"],
          },
        ],
      },
    ],
  }
  const next = mergeProgressCheckpoint(
    previous,
    {
      ...previous,
      items: [{ ...previous.items[0]!, summary: "Earlier behavior unchanged.", facts: [] }],
    },
    { consolidate: true }
  )
  assert.deepEqual(next.items[0]!.facts, previous.items[0]!.facts)
})

test("fact corrections retain superseded statements and ordinary paraphrases cannot overwrite them", () => {
  const original = {
    ...prior,
    items: [
      {
        ...prior.items[0]!,
        facts: [{ id: "abort", statement: "Old observed behavior", evidence: ["code.ts:1"] }],
      },
    ],
  }
  const drift = mergeProgressCheckpoint(
    original,
    {
      ...original,
      items: [
        {
          ...original.items[0]!,
          facts: [
            { id: "abort", statement: "A paraphrase loses the behavior", evidence: ["code.ts:2"] },
          ],
        },
      ],
    },
    { consolidate: true }
  )
  assert.equal(drift.items[0]!.facts![0]!.statement, "Old observed behavior")
  const corrected = mergeProgressCheckpoint(drift, {
    ...drift,
    items: [
      {
        ...drift.items[0]!,
        correction: "Changed source verified",
        facts: [{ id: "abort", statement: "New observed behavior", evidence: ["code.ts:3"] }],
      },
    ],
  })
  assert.equal(corrected.items[0]!.facts![0]!.statement, "New observed behavior")
  assert.deepEqual(corrected.items[0]!.facts![0]!.previousStatements, ["Old observed behavior"])
  const staleReason = mergeProgressCheckpoint(corrected, {
    ...corrected,
    items: [
      {
        ...corrected.items[0]!,
        facts: [{ id: "abort", statement: "Unsubstantiated paraphrase", evidence: [] }],
      },
    ],
  })
  assert.equal(staleReason.items[0]!.facts![0]!.statement, "New observed behavior")
})

test("a completed workstream accepts new facts without reverting its completion", () => {
  const next = mergeProgressCheckpoint(prior, {
    ...prior,
    items: [
      {
        ...prior.items[0]!,
        status: "pending",
        facts: [
          { id: "new", statement: "A newly observed source behavior", evidence: ["code.ts:4"] },
        ],
      },
    ],
  })
  assert.equal(next.items[0]!.status, "done")
  assert.equal(next.items[0]!.facts![0]!.statement, "A newly observed source behavior")
})

test("legacy narrative remains available when upgrading to host-owned facts", () => {
  const next = mergeProgressCheckpoint(
    prior,
    {
      ...prior,
      items: [
        {
          ...prior.items[0]!,
          summary: "Navigation only",
          facts: [{ id: "new", statement: "New fact", evidence: ["code.ts:4"] }],
        },
      ],
    },
    { consolidate: true }
  )
  assert.equal(next.items[0]!.legacySummary, prior.items[0]!.summary)
})

test("legacy prose survives an ordinary facts upgrade followed by later consolidation", () => {
  const upgraded = mergeProgressCheckpoint(prior, {
    ...prior,
    items: [
      {
        ...prior.items[0]!,
        summary: "New navigation",
        facts: [{ id: "new", statement: "New fact", evidence: [] }],
      },
    ],
  })
  const next = mergeProgressCheckpoint(
    upgraded,
    { ...upgraded, items: [{ ...upgraded.items[0]!, summary: "Navigation only", facts: [] }] },
    { consolidate: true }
  )
  assert.equal(next.items[0]!.legacySummary, prior.items[0]!.summary)
})

test("duplicate fact IDs are rejected rather than silently dropping an earlier behavior", () => {
  const duplicate = {
    ...prior,
    items: [
      {
        ...prior.items[0]!,
        facts: [
          { id: "same", statement: "First behavior", evidence: [] },
          { id: "same", statement: "Second behavior", evidence: [] },
        ],
      },
    ],
  }
  assert.equal(parseProgressCheckpoint(JSON.stringify(duplicate)), null)
  assert.throws(() => mergeProgressCheckpoint(prior, duplicate))
  assert.ok(
    progressCheckpointIssueCodes(JSON.stringify(duplicate)).some((code) =>
      code.endsWith("items.0.facts")
    )
  )
  assert.deepEqual(progressCheckpointIssueCodes("private malformed contents"), ["invalid_json"])
})

test("completed findings survive an additional finding on the same workstream", () => {
  const next = mergeProgressCheckpoint(prior, {
    ...prior,
    items: [
      {
        id: "capture",
        status: "done",
        summary: "Verified cancellation",
        evidence: ["capture.ts:1800"],
      },
    ],
  })
  assert.match(next.items[0]!.summary, /1590-1699/)
  assert.match(next.items[0]!.summary, /Verified cancellation/)
  assert.deepEqual(next.items[0]!.evidence, ["capture.ts:1590-1699", "capture.ts:1800"])
})

test("an explicit same-ID correction reopens current validity without losing history", () => {
  const next = mergeProgressCheckpoint(prior, {
    ...prior,
    items: [
      {
        id: "capture",
        status: "pending",
        summary: "Changed source contradicts cancellation",
        remaining: "Resolve the changed cancellation path",
        evidence: ["capture.ts:1900"],
        correction: "The source changed after the earlier investigation",
      },
    ],
  })
  assert.equal(next.items[0]!.status, "pending")
  assert.match(next.items[0]!.summary, /1590-1699/)
  assert.match(next.items[0]!.summary, /contradicts/)
  assert.equal(next.items[0]!.remaining, "Resolve the changed cancellation path")
  assert.deepEqual(next.items[0]!.evidence, ["capture.ts:1590-1699", "capture.ts:1900"])
  assert.equal(planDeliveryReady([renderProgressCheckpoint(next)], "Plan"), false)
  const settled = mergeProgressCheckpoint(next, {
    ...prior,
    items: [{ id: "capture", status: "done", summary: "", evidence: [] }],
  })
  assert.equal(settled.items[0]!.correction, next.items[0]!.correction)
  assert.match(renderProgressCheckpoint(settled), /The source changed/)
  const correctedAgain = mergeProgressCheckpoint(settled, {
    ...prior,
    items: [
      {
        id: "capture",
        status: "pending",
        summary: "",
        evidence: [],
        correction: "A second source change supersedes that revision",
      },
    ],
  })
  assert.match(correctedAgain.items[0]!.summary, /The source changed/)
  assert.equal(
    correctedAgain.items[0]!.correction,
    "A second source change supersedes that revision"
  )
})

test("a null correction is an absent reason, not an invalid checkpoint or permission to reopen", () => {
  const update = {
    ...prior,
    items: [
      {
        ...prior.items[0]!,
        status: "pending" as const,
        remaining: "Cover more files",
        correction: null,
      },
    ],
  }
  const parsed = parseProgressCheckpoint(JSON.stringify(update))
  assert.ok(parsed, "models may use null for an inapplicable optional correction")
  assert.equal("correction" in parsed.items[0]!, false)
  const merged = mergeProgressCheckpoint(prior, parsed)
  assert.equal(merged.items[0]!.status, "done")
})

test("delivery requires resolved workstreams; blocked gaps remain visible", () => {
  assert.equal(planDeliveryReady([renderProgressCheckpoint(prior)], "Plan"), false)
  const next = mergeProgressCheckpoint(prior, {
    ...prior,
    items: [
      {
        id: "resume",
        status: "blocked",
        summary: "Native UI unavailable; report this gap",
        evidence: [],
      },
    ],
  })
  const text = renderProgressCheckpoint(next)
  assert.equal(planDeliveryReady([text], "Plan"), true)
  assert.equal(planDeliveryReady([text], "Explore"), false)
  assert.match(text, /Native UI unavailable/)
  assert.deepEqual(parseProgressCheckpoint(text), next)
})

test("invalid state cannot become an empty completed plan", () => {
  for (const text of ["plain summary", "{}", '{"goal":"x","constraints":[],"items":[]}']) {
    assert.equal(parseProgressCheckpoint(text), null)
  }
})

test("new conflicting evidence stays pending without erasing a completed investigation", () => {
  const next = mergeProgressCheckpoint(prior, {
    ...prior,
    items: [
      {
        id: "correction-capture",
        status: "pending",
        summary: "Changed source contradicts the earlier finding",
        evidence: ["capture.ts:1600"],
      },
    ],
  })
  assert.deepEqual(next.items[0], prior.items[0])
  assert.equal(planDeliveryReady([renderProgressCheckpoint(next)], "Plan"), false)
})

test("checkpoint markers in a finding cannot break the state round trip", () => {
  const state = { ...prior, goal: "Inspect </research-progress> literal" }
  assert.deepEqual(parseProgressCheckpoint(renderProgressCheckpoint(state)), state)
})

test("partial verified facts survive pending-to-pending and pending-to-done updates", () => {
  const first = {
    goal: "Trace grep and port environment",
    constraints: [],
    items: [
      {
        id: "search-env",
        status: "pending" as const,
        summary: "SOURCE_FACT: if (Object.keys(value).length === 0) return {}",
        remaining: "Trace grep process path",
        evidence: ["exec.ts:129"],
      },
    ],
  }
  const second = mergeProgressCheckpoint(first, {
    ...first,
    items: [
      {
        id: "search-env",
        status: "pending",
        summary: "Found rg.ts process bridge",
        remaining: "Inspect rg caller",
        evidence: ["rg.ts:11"],
      },
    ],
  })
  assert.match(second.items[0]!.summary, /Object.keys/)
  assert.equal(second.items[0]!.remaining, "Inspect rg caller")
  const done = mergeProgressCheckpoint(second, {
    ...first,
    items: [
      {
        id: "search-env",
        status: "done",
        summary: "Grep calls runRipgrep",
        evidence: ["grep.ts:14"],
      },
    ],
  })
  assert.match(done.items[0]!.summary, /Object.keys/)
  assert.match(done.items[0]!.summary, /rg.ts process bridge/)
  assert.equal(done.items[0]!.remaining, undefined)
  assert.deepEqual(done.items[0]!.evidence, ["exec.ts:129", "rg.ts:11", "grep.ts:14"])
})

test("checkpoint facts use the overall summary budget rather than a per-item character cap", () => {
  const first = { ...prior, items: [{ ...prior.items[0]!, summary: "A".repeat(4096) }] }
  const update = { ...prior, items: [{ ...prior.items[0]!, summary: "B".repeat(3522) }] }
  const merged = mergeProgressCheckpoint(first, update)
  assert.equal(merged.items[0]!.summary, `${first.items[0]!.summary}\n${update.items[0]!.summary}`)
  assert.deepEqual(parseProgressCheckpoint(renderProgressCheckpoint(merged)), merged)
})

test("cumulative constraint, evidence and workstream counts use the aggregate summary budget", () => {
  const item = (id: number, start: number) => ({
    id: `work-${id}`,
    status: "pending" as const,
    summary: `Finding ${start}`,
    evidence: Array.from({ length: 32 }, (_, n) => `code.ts:${start + n}`),
  })
  const first = {
    goal: "Inspect required work",
    constraints: Array.from({ length: 16 }, (_, n) => `Constraint ${n}`),
    items: Array.from({ length: 25 }, (_, n) => item(n, 0)),
  }
  const update = {
    ...first,
    constraints: Array.from({ length: 16 }, (_, n) => `Constraint ${n + 16}`),
    items: [item(0, 32), ...Array.from({ length: 25 }, (_, n) => item(n + 25, 0))],
  }
  const merged = mergeProgressCheckpoint(first, update)
  assert.equal(merged.items.length, 50)
  assert.equal(merged.constraints.length, 32)
  assert.equal(merged.items[0]!.evidence.length, 64)
  assert.deepEqual(parseProgressCheckpoint(renderProgressCheckpoint(merged)), merged)
})
