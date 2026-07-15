/**
 * Export a {@link RecordedFlow} into each artifact the user can choose. See
 * ADR-0072.
 *
 * Every exporter is a pure `flow → string`: the flow is the source of truth and
 * these only re-serialize it, which is what keeps "pick your output format" a
 * cheap feature rather than three parallel recorders. Keep them DOM- and
 * Tauri-free so they stay in the fast `node` jest project.
 */
import {
  resolveStepUrl,
  secretKey,
  type RecordedFlow,
  type RecordedStep,
  type RecordedTarget,
} from "@/lib/browser/recording/protocol"

/** Safely embed an arbitrary string in generated JS/TS source. */
function quote(value: string): string {
  return JSON.stringify(value)
}

/**
 * Map our chord vocabulary (`parseKeyChord` in the overlay: `ctrl+a`,
 * `shift+Tab`) onto Playwright's (`Control+a`, `Shift+Tab`). Unknown tokens
 * pass through — Playwright's own key parser is the backstop.
 */
const PLAYWRIGHT_MODIFIERS: Record<string, string> = {
  ctrl: "Control",
  control: "Control",
  shift: "Shift",
  alt: "Alt",
  meta: "Meta",
  cmd: "Meta",
  command: "Meta",
}

export function toPlaywrightKey(chord: string): string {
  return chord
    .split("+")
    .map((token) => PLAYWRIGHT_MODIFIERS[token.trim().toLowerCase()] ?? token.trim())
    .join("+")
}

/**
 * Prefer a role locator: `getByRole("button", { name: "Sign in" })` survives
 * markup churn, which is the whole reason `role`/`name` are captured at record
 * time. Fall back to the CSS selector only when the element had no mapped role
 * or no accessible name.
 */
export function toPlaywrightLocator(target: RecordedTarget): string {
  if (target.role && target.name) {
    return `page.getByRole(${quote(target.role)}, { name: ${quote(target.name)} })`
  }
  return `page.locator(${quote(target.selector)})`
}

function playwrightLine(flow: RecordedFlow, step: RecordedStep): string | null {
  switch (step.act) {
    case "navigate":
      return `  await page.goto(${quote(resolveStepUrl(flow, step.url))})`
    case "click": {
      const locator = toPlaywrightLocator(step.target)
      if (step.modifiers?.length) {
        const mods = step.modifiers.map((m) => quote(toPlaywrightKey(m))).join(", ")
        return `  await ${locator}.click({ modifiers: [${mods}] })`
      }
      return `  await ${locator}.click()`
    }
    case "fill": {
      // A password's value was never captured (see FillStep.secret) — read it
      // from the environment so the generated spec stays credential-free.
      const value = step.secret ? `process.env.${secretKey(step.target)} ?? ""` : quote(step.value)
      return `  await ${toPlaywrightLocator(step.target)}.fill(${value})`
    }
    case "select":
      return `  await ${toPlaywrightLocator(step.target)}.selectOption(${quote(step.value)})`
    case "press_key": {
      const key = quote(toPlaywrightKey(step.key))
      return step.target
        ? `  await ${toPlaywrightLocator(step.target)}.press(${key})`
        : `  await page.keyboard.press(${key})`
    }
    case "wait_for":
      return `  await expect(page.getByText(${quote(step.text)})).toBeVisible()`
    default:
      return null
  }
}

/**
 * Emit a Playwright spec. `expect` is imported only when the flow has an
 * assertion, otherwise the generated file trips the repo's no-unused-imports
 * lint the moment it lands in `tests/e2e/`.
 */
export function toPlaywrightSpec(flow: RecordedFlow): string {
  const body = flow.steps
    .map((step) => playwrightLine(flow, step))
    .filter((line): line is string => line !== null)
  const usesExpect = flow.steps.some((s) => s.act === "wait_for")
  const imported = usesExpect ? "test, expect" : "test"
  return [
    `import { ${imported} } from "@playwright/test"`,
    "",
    `test(${quote(flow.name)}, async ({ page }) => {`,
    ...body,
    "})",
    "",
  ].join("\n")
}

function describeTarget(target: RecordedTarget): string {
  if (target.role && target.name) return `${target.role} "${target.name}"`
  if (target.name) return `"${target.name}"`
  return target.selector
}

function agentLine(flow: RecordedFlow, step: RecordedStep): string | null {
  switch (step.act) {
    case "navigate":
      return `navigate to ${resolveStepUrl(flow, step.url)}`
    case "click": {
      const mods = step.modifiers?.length ? ` (holding ${step.modifiers.join("+")})` : ""
      return `click ${describeTarget(step.target)}${mods} — selector: ${step.target.selector}`
    }
    case "fill":
      return step.secret
        ? `fill ${describeTarget(step.target)} with the ${secretKey(step.target)} secret (value not recorded; ask the user) — selector: ${step.target.selector}`
        : `fill ${describeTarget(step.target)} with "${step.value}" — selector: ${step.target.selector}`
    case "select":
      return `select "${step.value}" in ${describeTarget(step.target)} — selector: ${step.target.selector}`
    case "press_key":
      return step.target
        ? `press ${step.key} on ${describeTarget(step.target)}`
        : `press ${step.key}`
    case "wait_for":
      return `expect the text "${step.text}" to be visible`
    default:
      return null
  }
}

/**
 * Render the flow as markdown for the chat composer. Explicitly instructs the
 * model to re-snapshot and act by `ref`, because the recorded selectors are
 * anchors for *finding* the element, not a substitute for the snapshot→act loop
 * the browser tools require (ADR-0055).
 */
export function toAgentContext(flow: RecordedFlow): string {
  const lines = flow.steps
    .map((step) => agentLine(flow, step))
    .filter((line): line is string => line !== null)
    .map((line, i) => `${i + 1}. ${line}`)
  return [
    `— Recorded browser flow: ${flow.name} —`,
    `Base URL: ${flow.baseUrl}`,
    "",
    ...(lines.length ? lines : ["(no steps recorded)"]),
    "",
    "Replay this with the browser_* tools: take a browser_snapshot after each " +
      "navigation or mutating action and act on elements by the `ref` from the " +
      "latest snapshot — the selectors above are only there to help you find the " +
      "right node.",
  ].join("\n")
}

/** The raw flow, for re-import and hand-editing. */
export function toJson(flow: RecordedFlow): string {
  return JSON.stringify(flow, null, 2)
}

export type ExportFormat = "json" | "playwright" | "agent"

const EXPORTERS: Record<ExportFormat, (flow: RecordedFlow) => string> = {
  json: toJson,
  playwright: toPlaywrightSpec,
  agent: toAgentContext,
}

export function exportFlow(flow: RecordedFlow, format: ExportFormat): string {
  return EXPORTERS[format](flow)
}

/** Suggested download filename per format. */
export function exportFilename(flow: RecordedFlow, format: ExportFormat): string {
  const slug = flow.name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
  const stem = slug || "recording"
  if (format === "playwright") return `${stem}.spec.ts`
  if (format === "json") return `${stem}.json`
  return `${stem}.md`
}
