/**
 * The signature task's technical fixture (spec §4.2, ADR-0092 §8, §9).
 *
 * Everything here is locale-invariant on purpose: repository slugs, branch
 * names, file paths, diff bodies, commands and check names do not translate, and
 * duplicating them into `en.ts` and `zh.ts` would create two sources that drift.
 * The prose *about* these values — what a file is, what a step does, what a
 * permission would allow — lives in the localised copy and joins the fixture by
 * key, never by array position.
 *
 * The project is fictional and named as such. Spec §9 bans fake KPIs and fake
 * testimonials; it does not ban a demonstration, and the alternative is worse:
 * manufacturing a failing check in a real repository in order to photograph it,
 * or publishing the author's own working data. `DEMO.repository` here is the same
 * identity `web/scripts/capture-product.mjs` seeds, so a DOM reconstruction and
 * a future screenshot of the same section describe the same task.
 */

export type DiffLineKind = "context" | "add" | "remove"

export interface DiffLine {
  kind: DiffLineKind
  text: string
}

export type TestLineState = "pass" | "fail" | "queued"

/** Literal keys, so the localised `lineNotes` record has to cover every line. */
export type TestLineKey = "discount" | "usd" | "jpy" | "rerun"

export interface TestLine {
  key: TestLineKey
  state: TestLineState
  /** Test name as a runner would print it — not translated. */
  name: string
}

/** Keys the localised copy attaches its prose to. */
export interface DemoFile {
  key: "source" | "test" | "instructions"
  path: string
}

export const DEMO_TASK = {
  /** Fictional demo project, shared with the capture script's `DEMO`. */
  repository: "acme/checkout-service",
  branch: "release/2.4.0",
  /** The check the release fails on. */
  check: "unit-tests",

  files: [
    { key: "source", path: "src/checkout/total.ts" },
    { key: "test", path: "src/checkout/total.test.ts" },
    { key: "instructions", path: "AGENTS.md" },
  ] satisfies DemoFile[],

  plan: [
    { key: "reproduce", tool: "terminal" },
    { key: "fix", tool: "editor" },
    { key: "verify", tool: "terminal" },
    { key: "notes", tool: "artifact" },
  ],

  diff: {
    path: "src/checkout/total.ts",
    hunk: "@@ -18,9 +18,11 @@ export function orderTotal(",
    added: 18,
    removed: 6,
    filesChanged: 2,
    lines: [
      { kind: "context", text: "  const subtotal = lines.reduce(" },
      { kind: "context", text: "    (sum, line) => sum + line.unitPrice * line.quantity," },
      { kind: "context", text: "    0" },
      { kind: "context", text: "  )" },
      { kind: "context", text: "  const discounted = subtotal - subtotal * discountRate" },
      { kind: "remove", text: "  return Math.round(discounted)" },
      { kind: "add", text: "  // Minor units differ per currency: JPY has none, USD has two." },
      { kind: "add", text: "  return roundToMinorUnits(discounted, currency)" },
      { kind: "context", text: "}" },
    ] satisfies DiffLine[],
  },

  approval: {
    /** The action the checkpoint is holding. */
    command: "git push",
    target: "origin release/2.4.0",
  },

  test: {
    command: "pnpm test --filter checkout",
    lines: [
      { key: "discount", state: "pass", name: "applies the discount before tax" },
      { key: "usd", state: "pass", name: "keeps USD totals at two decimals" },
      { key: "jpy", state: "fail", name: "rounds JPY totals to whole yen" },
      { key: "rerun", state: "queued", name: "unit-tests (re-run)" },
    ] satisfies TestLine[],
  },

  artifact: {
    file: "launch-notes.md",
    version: "2.4.0",
  },

  /**
   * A plugin declaration, verbatim from `plugins/web-tools/plugin.json` in
   * this repository. `denied` is a real permission id the manifest does not
   * declare, which is exactly the call the runtime refuses.
   */
  plugin: {
    id: "cognia-web-tools",
    capabilities: ["tools"],
    permissions: ["network:fetch", "agent:control"],
    denied: "secrets:read",
  },

  /** Activity rail entries, in shipping order. `chat` is the active one. */
  rail: ["chat", "agents", "workflows", "knowledge", "plugins"] as const,
} as const

export type RailKey = (typeof DEMO_TASK.rail)[number]
export type PlanKey = (typeof DEMO_TASK.plan)[number]["key"]
export type DemoFileKey = DemoFile["key"]
