/**
 * Regression guard: every string in the shipped `en.json` / `zh-CN.json`
 * bundles must be a valid ICU MessageFormat template.
 *
 * next-intl compiles each message with `intl-messageformat` when a component
 * reads it, so a malformed template (literal `{{token}}`, a JSON example like
 * `{ "k": 1 }`, or a `<placeholder>` that reads as an unclosed rich-text tag)
 * throws `INVALID_MESSAGE` and surfaces as a console error in the app.
 *
 * The actual parsing lives in `scripts/i18n/validate-icu.mjs`, because
 * `intl-messageformat` is ESM-only and Jest's CJS loader can't import it under
 * the pnpm layout. This test runs that validator against the committed bundles;
 * a non-zero exit (any malformed message) fails the suite with the offenders.
 */
import { execFileSync } from "node:child_process"
import { resolve } from "node:path"

const REPO_ROOT = resolve(__dirname, "../..")
const VALIDATOR = resolve(REPO_ROOT, "scripts/i18n/validate-icu.mjs")

describe("i18n bundle ICU validity", () => {
  it("has no malformed ICU messages in either locale bundle", () => {
    let error: (Error & { stdout?: Buffer; stderr?: Buffer }) | null = null
    try {
      execFileSync(process.execPath, [VALIDATOR], { cwd: REPO_ROOT, stdio: "pipe" })
    } catch (err) {
      error = err as Error & { stdout?: Buffer; stderr?: Buffer }
    }
    // On failure the validator prints each offending key to stderr; surface it.
    const report = error ? `${error.stderr ?? ""}${error.stdout ?? ""}` : ""
    expect(report).toBe("")
  })
})
