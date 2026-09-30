/**
 * The signature task as a staged conversation (ADR-0092, product footage
 * amendment).
 *
 * `record-product.mjs` and `capture-product.mjs` hand this to the product's
 * `window.__cogniaSeedStagedConversation` (dev/E2E builds only,
 * `lib/dev/demo-stage-seed.ts`) and advance it one stage at a time, so the
 * camera watches the real chat renderers draw the task: the files read, the
 * failing check, the plan, the diff, the re-run, the notes and the halt on the
 * push.
 *
 * Identities come from `DEMO`, which `web/content/demo-task.test.ts` pins to
 * `DEMO_TASK`, so a reconstruction, a screenshot and a film frame describe one
 * task. The prose is per locale and lives here rather than in `content/*.ts`
 * because this file is plain Node: the conversation text is what the agent
 * *says* in the product, not website copy, and the website's own sentences
 * about it stay in the copy bundles.
 *
 * Every stage carries `holdMs`, how long the camera stays on it before the next
 * stage plays, and the stages that open a new part of the story carry a
 * `beat`. The film's callouts and caption track are keyed by beat, never by
 * stage index, so inserting a stage does not shift a caption onto the wrong
 * moment.
 */

/** The demo project every recording and screenshot shows. Fictional on purpose. */
export const DEMO = {
  repository: "acme/checkout-service",
  branch: "release/2.4.0",
  failingCheck: "unit-tests",
  artifact: "launch-notes.md",
  version: "2.4.0",
  testCommand: "pnpm test --filter checkout",
  sourcePath: "src/checkout/total.ts",
  instructionsPath: "AGENTS.md",
  pushCommand: "git push origin release/2.4.0",
}

export const LOCALES = ["en", "zh"]

/** The story's beats, in the order they happen. */
export const BEATS = [
  "request",
  "context",
  "reproduce",
  "plan",
  "fix",
  "verify",
  "notes",
  "approval",
]

/**
 * What the film's camera frames on each beat: the product element that beat
 * is about, found by the product's own test ids. The recorder measures it at
 * the end of the beat, when it has settled, so the camera lands on where it
 * really is in that locale's layout rather than on a hand-tuned rectangle.
 * `which` picks among several matches in document order.
 */
export const BEAT_FOCUS = {
  request: { selector: '[data-testid="message-shell"]', which: "first" },
  context: { selector: '[data-testid="tool-activity-group"]', which: "first" },
  reproduce: { selector: '[data-testid="tool-activity-group"]', which: "first" },
  plan: { selector: '[data-testid="mcp-plan-card"]', which: "last" },
  fix: { selector: '[data-testid="mcp-edit-card"]', which: "last" },
  verify: { selector: '[data-testid="terminal-tool-part"]', which: "last" },
  notes: { selector: '[data-testid="artifact-workspace-dock"]', which: "first" },
  approval: { selector: '[role="dialog"]', which: "last" },
}

const INSTRUCTIONS = `# checkout-service

- Money is stored in minor units. Round per currency, never per order.
- Run \`${DEMO.testCommand}\` before proposing a change.
- Pushing a release branch needs a maintainer's confirmation.
`

const SOURCE_BEFORE = `export function orderTotal(lines: Line[], discountRate: number, currency: Currency) {
  const subtotal = lines.reduce(
    (sum, line) => sum + line.unitPrice * line.quantity,
    0
  )
  const discounted = subtotal - subtotal * discountRate
  return Math.round(discounted)
}
`

const OLD_STRING = "  return Math.round(discounted)"
const NEW_STRING = `  // Minor units differ per currency: JPY has none, USD has two.
  return roundToMinorUnits(discounted, currency)`

const FAILING_RUN = ` RUN  ${DEMO.testCommand}

 ✓ applies the discount before tax
 ✓ keeps USD totals at two decimals
 ✗ rounds JPY totals to whole yen
   expected 1234  received 1233.6

 Tests  1 failed | 2 passed (3)`

const PASSING_RUN = ` RUN  ${DEMO.testCommand}

 ✓ applies the discount before tax
 ✓ keeps USD totals at two decimals
 ✓ rounds JPY totals to whole yen

 Tests  3 passed (3)`

const PROSE = {
  en: {
    title: "Release 2.4.0",
    request: "Take the 2.4.0 release — fix the check that is failing, then draft the notes.",
    opening:
      "Starting from the release branch: the project instructions first, then the checkout total the failing check covers.",
    diagnosis:
      "The check fails on JPY. The total is rounded once per order, but yen has no minor unit, so the rounding has to follow the currency.",
    plan: `## Fix the ${DEMO.version} release check

1. **Reproduce** — run \`${DEMO.testCommand}\` and keep the failure.
2. **Fix** — round with \`roundToMinorUnits\` per currency in \`${DEMO.sourcePath}\`.
3. **Verify** — re-run the same check until it passes.
4. **Notes** — draft \`${DEMO.artifact}\` for the release.`,
    applying: `Plan approved. Applying the fix in \`${DEMO.sourcePath}\`.`,
    fixed: "Rounding now follows the currency. Re-running the check that failed.",
    notesLead: "The check passes. Launch notes are drafted as an artifact.",
    notes: `# Checkout ${DEMO.version}

## Fixed
- Order totals round per currency. JPY totals are whole yen again.

## Verified
- \`${DEMO.testCommand}\` — 3 passed.
`,
    handoff: "Pushing the branch reaches outside the workspace, so it waits for you.",
    approvalTitle: `Push ${DEMO.branch} to origin`,
    approvalDescription: "The release branch leaves this machine.",
  },
  zh: {
    title: "发布 2.4.0",
    request: "看一下 2.4.0 这次发布——修好正在失败的那个检查，然后起草说明。",
    opening: "从发布分支开始：先读项目说明，再读失败检查覆盖的订单总额计算。",
    diagnosis: "检查在日元上失败。总额按订单只取整一次，但日元没有辅币单位，取整必须跟着币种走。",
    plan: `## 修复 ${DEMO.version} 发布检查

1. **复现**：运行 \`${DEMO.testCommand}\`，保留失败输出。
2. **修复**：在 \`${DEMO.sourcePath}\` 中按币种调用 \`roundToMinorUnits\`。
3. **验证**：重跑同一个检查，直到通过。
4. **说明**：为本次发布起草 \`${DEMO.artifact}\`。`,
    applying: `计划已批准。在 \`${DEMO.sourcePath}\` 中应用修复。`,
    fixed: "取整已改为跟随币种。重跑刚才失败的检查。",
    notesLead: "检查通过。发布说明已作为产物起草。",
    notes: `# Checkout ${DEMO.version}

## 修复
- 订单总额按币种取整，日元总额恢复为整数。

## 验证
- \`${DEMO.testCommand}\`：3 项通过。
`,
    handoff: "推送分支会离开这个工作空间，所以它停下来等你确认。",
    approvalTitle: `推送 ${DEMO.branch} 到 origin`,
    approvalDescription: "发布分支将离开这台机器。",
  },
}

const A = "demo-agent"

function toolCall(type, toolCallId, input) {
  return { type, toolCallId, state: "input-available", input }
}

/**
 * The staged script for one locale, each stage wrapped with its camera hold
 * and, where a new part of the story starts, its beat.
 *
 * @param {"en" | "zh"} locale
 */
export function buildDemoTranscript(locale) {
  const prose = PROSE[locale]
  if (!prose) throw new Error(`demo transcript: unsupported locale ${locale}`)

  /** @type {Array<{ stage: Record<string, unknown>, holdMs: number, beat?: string }>} */
  const steps = [
    {
      beat: "request",
      holdMs: 1400,
      stage: {
        kind: "append",
        message: { id: "demo-user", role: "user", parts: [{ type: "text", text: prose.request }] },
      },
    },
    { holdMs: 300, stage: { kind: "append", message: { id: A, role: "assistant", parts: [] } } },
    {
      beat: "context",
      holdMs: 500,
      stage: { kind: "stream", messageId: A, text: prose.opening, chunkSize: 3, intervalMs: 22 },
    },
    {
      holdMs: 450,
      stage: {
        kind: "addPart",
        messageId: A,
        part: toolCall("tool-Read", "demo-read-instructions", {
          file_path: DEMO.instructionsPath,
        }),
      },
    },
    {
      holdMs: 500,
      stage: {
        kind: "patchPart",
        messageId: A,
        toolCallId: "demo-read-instructions",
        patch: { state: "output-available", output: INSTRUCTIONS },
      },
    },
    {
      holdMs: 450,
      stage: {
        kind: "addPart",
        messageId: A,
        part: toolCall("tool-Read", "demo-read-source", { file_path: DEMO.sourcePath }),
      },
    },
    {
      holdMs: 700,
      stage: {
        kind: "patchPart",
        messageId: A,
        toolCallId: "demo-read-source",
        patch: { state: "output-available", output: SOURCE_BEFORE },
      },
    },
    {
      beat: "reproduce",
      holdMs: 1100,
      stage: {
        kind: "addPart",
        messageId: A,
        part: toolCall("tool-Bash", "demo-run-failing", {
          command: DEMO.testCommand,
          description: DEMO.failingCheck,
        }),
      },
    },
    {
      holdMs: 2600,
      stage: {
        kind: "patchPart",
        messageId: A,
        toolCallId: "demo-run-failing",
        patch: { state: "output-error", errorText: FAILING_RUN },
      },
    },
    {
      holdMs: 500,
      stage: { kind: "stream", messageId: A, text: prose.diagnosis, chunkSize: 3, intervalMs: 22 },
    },
    {
      beat: "plan",
      holdMs: 600,
      stage: {
        kind: "addPart",
        messageId: A,
        part: toolCall("tool-ExitPlanMode", "demo-plan", { plan: prose.plan }),
      },
    },
    {
      holdMs: 2600,
      stage: {
        kind: "patchPart",
        messageId: A,
        toolCallId: "demo-plan",
        patch: { state: "output-available", output: "approved" },
      },
    },
    {
      beat: "fix",
      holdMs: 300,
      stage: { kind: "stream", messageId: A, text: prose.applying, chunkSize: 3, intervalMs: 22 },
    },
    {
      holdMs: 700,
      stage: {
        kind: "addPart",
        messageId: A,
        part: toolCall("tool-Edit", "demo-edit", {
          file_path: DEMO.sourcePath,
          old_string: OLD_STRING,
          new_string: NEW_STRING,
        }),
      },
    },
    {
      holdMs: 2800,
      stage: {
        kind: "patchPart",
        messageId: A,
        toolCallId: "demo-edit",
        patch: { state: "output-available", output: `Updated ${DEMO.sourcePath}` },
      },
    },
    {
      beat: "verify",
      holdMs: 400,
      stage: { kind: "stream", messageId: A, text: prose.fixed, chunkSize: 3, intervalMs: 22 },
    },
    {
      holdMs: 1000,
      stage: {
        kind: "addPart",
        messageId: A,
        part: toolCall("tool-Bash", "demo-run-passing", {
          command: DEMO.testCommand,
          description: `${DEMO.failingCheck} (re-run)`,
        }),
      },
    },
    {
      holdMs: 2200,
      stage: {
        kind: "patchPart",
        messageId: A,
        toolCallId: "demo-run-passing",
        patch: { state: "output-available", output: PASSING_RUN },
      },
    },
    {
      beat: "notes",
      holdMs: 400,
      stage: { kind: "stream", messageId: A, text: prose.notesLead, chunkSize: 3, intervalMs: 22 },
    },
    {
      holdMs: 2600,
      stage: {
        kind: "artifact",
        messageId: A,
        title: DEMO.artifact,
        content: prose.notes,
        artifactType: "document",
        language: "markdown",
      },
    },
    {
      beat: "approval",
      holdMs: 500,
      stage: { kind: "stream", messageId: A, text: prose.handoff, chunkSize: 3, intervalMs: 22 },
    },
    {
      holdMs: 600,
      stage: {
        kind: "addPart",
        messageId: A,
        part: {
          type: "tool-Bash",
          toolCallId: "demo-push",
          state: "approval-requested",
          input: { command: DEMO.pushCommand, description: prose.approvalTitle },
        },
      },
    },
    {
      holdMs: 4500,
      stage: {
        kind: "approval",
        toolCallId: "demo-push",
        toolName: "Bash",
        input: { command: DEMO.pushCommand, description: prose.approvalTitle },
        title: prose.approvalTitle,
        description: prose.approvalDescription,
      },
    },
  ]

  return {
    script: { title: prose.title, stages: steps.map((step) => step.stage) },
    holds: steps.map((step) => step.holdMs),
    beats: steps.flatMap((step, index) => (step.beat ? [{ beat: step.beat, stage: index }] : [])),
  }
}
