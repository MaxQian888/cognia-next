/**
 * Recognise "this tool call ran a test suite" from a tool invocation alone.
 *
 * Detection is deliberately conservative in what it CLAIMS and relaxed in what
 * it accepts, because both error directions are safe here:
 *
 * - a false positive yields an `inconclusive` artifact (the parser will not
 *   find counts in output that is not a test report), which is honest;
 *   never a green one, because nothing infers `0 failed` from silence.
 * - a false negative yields no artifact at all, which is the status quo.
 *
 * What is NOT safe is echoing the command line anywhere downstream — it can
 * carry paths, env assignments, and tokens — so the runner label returned here
 * is a closed enum, and the command string never leaves this module.
 */

/** Which report format to expect. `package-script` means "unknown, try all". */
export type VerificationRunner = "jest" | "vitest" | "playwright" | "cargo-test" | "package-script"

/**
 * Command position: start of string, or after a shell separator. Keeps
 * `rg "jest" src/` and `git commit -m "fix jest flake"` from matching, which a
 * bare `\bjest\b` would.
 */
const AFTER_SEPARATOR = String.raw`(?:^|[;&|]\s*|\(\s*)`
/** Optional runner prefixes: `npx`, `pnpm exec`, `bunx`, `pnpm --filter x run`… */
const RUNNER_PREFIX = String.raw`(?:(?:npx|bunx|pnpm|npm|yarn|bun|cross-env|dotenv)\s+(?:[-\w:@./=]+\s+)*?)?`

const PATTERNS: ReadonlyArray<readonly [VerificationRunner, RegExp]> = [
  ["playwright", new RegExp(`${AFTER_SEPARATOR}${RUNNER_PREFIX}playwright\\s+test\\b`)],
  [
    "cargo-test",
    new RegExp(`${AFTER_SEPARATOR}cargo\\s+(?:\\+\\S+\\s+)?(?:nextest\\s+run|test)\\b`),
  ],
  ["vitest", new RegExp(`${AFTER_SEPARATOR}${RUNNER_PREFIX}vitest\\b`)],
  ["jest", new RegExp(`${AFTER_SEPARATOR}${RUNNER_PREFIX}jest\\b`)],
  // `pnpm test`, `npm run test:e2e`, `yarn test --watch=false`, `bun run test`.
  [
    "package-script",
    new RegExp(`${AFTER_SEPARATOR}(?:pnpm|npm|yarn|bun)\\s+(?:run\\s+)?test(?::[\\w:-]+)?\\b`),
  ],
]

/** Tool names whose input carries a shell command. */
const SHELL_TOOLS = new Set(["bash", "shell", "run_command", "execute_command", "terminal"])

function commandOf(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined
  const record = input as Record<string, unknown>
  for (const key of ["command", "cmd", "script"]) {
    const value = record[key]
    if (typeof value === "string" && value.trim().length > 0) return value
  }
  return undefined
}

/**
 * The runner this call appears to invoke, or `null` when it is not a test run.
 *
 * Only shell-shaped tools are considered: a file-edit tool that happens to
 * write the word `jest` into a file is not a verification run.
 */
export function detectVerificationRunner(
  toolName: string | undefined,
  input: unknown
): VerificationRunner | null {
  if (!toolName || !SHELL_TOOLS.has(toolName.toLowerCase())) return null
  const command = commandOf(input)
  if (!command) return null
  // Lowercase for matching only; the command itself is never returned or logged.
  const haystack = command.toLowerCase()
  for (const [runner, pattern] of PATTERNS) {
    if (pattern.test(haystack)) return runner
  }
  return null
}
