/**
 * Command line of the live smoke (`pnpm router-fusion:live-smoke`).
 *
 * The default is a dry run: read the providers, print them and the planned
 * cases with their caps, and exit without a network call. Spending money
 * takes an explicit `--confirm`; the offline run against the Fake Provider
 * is `--fake`. The two cannot be combined — a run is either real or
 * simulated, never a mix whose report could be mistaken for the other.
 */

export type LiveSmokeCommand = "dry_run" | "simulated" | "live" | "help"

export interface LiveSmokeArgs {
  command: LiveSmokeCommand
  /** A settings export (Settings → Actions → Export), or null. */
  settingsPath: string | null
  /** The providers the run may call, as confirmed by the user; null = every provider with a credential. */
  providers: string[] | null
  /** Where the report goes; null = a fresh directory under the OS temp dir. */
  outDir: string | null
}

export type ParsedLiveSmokeArgs = { ok: true; args: LiveSmokeArgs } | { ok: false; message: string }

/** The settings export path, when no `--settings` flag names one. */
export const LIVE_SMOKE_SETTINGS_ENV = "COGNIA_LIVE_SMOKE_SETTINGS"

export const LIVE_SMOKE_USAGE = [
  "Usage: pnpm router-fusion:live-smoke [options]",
  "",
  "Without --confirm or --fake this is a dry run: it prints the providers and the",
  "planned cases with their caps, and exits without any network call.",
  "",
  "Options:",
  "  --settings <file>     settings export (Settings → Actions → Export settings);",
  `                        or set ${LIVE_SMOKE_SETTINGS_ENV}`,
  "  --providers <a,b>     the providers the run may call (default: every enabled",
  "                        provider with a credential)",
  "  --out <dir>           report directory (default: a new directory under the OS temp dir)",
  "  --fake                run every case against the Fake Provider (no network);",
  '                        the report is labelled "simulated"',
  "  --confirm             run every case against the real providers, under a",
  '                        ledger-enforced $5 total cap; the report is labelled "live"',
  "  -h, --help            show this help",
  "",
  "Credentials come only from COGNIA_LIVE_SMOKE_KEY_<PROVIDER> (for example",
  "COGNIA_LIVE_SMOKE_KEY_ANTHROPIC): a settings export never contains keys.",
].join("\n")

const VALUE_FLAGS = new Set(["--settings", "--providers", "--out"])

export function parseLiveSmokeArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = {}
): ParsedLiveSmokeArgs {
  let confirm = false
  let fake = false
  let help = false
  const values: Record<string, string> = {}

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--confirm") confirm = true
    else if (arg === "--fake") fake = true
    else if (arg === "--help" || arg === "-h") help = true
    else {
      const separator = arg.indexOf("=")
      const flag = separator > 0 ? arg.slice(0, separator) : arg
      if (!VALUE_FLAGS.has(flag)) return { ok: false, message: `unknown option: ${arg}` }
      const value = separator > 0 ? arg.slice(separator + 1) : argv[(index += 1)]
      if (value === undefined || value.trim() === "" || value.startsWith("--")) {
        return { ok: false, message: `${flag} needs a value` }
      }
      values[flag] = value.trim()
    }
  }

  if (confirm && fake) {
    return {
      ok: false,
      message: "--confirm and --fake cannot be combined: a run is either live or simulated",
    }
  }

  const providers = values["--providers"]
    ? [
        ...new Set(
          values["--providers"]
            .split(",")
            .map((id) => id.trim())
            .filter((id) => id.length > 0)
        ),
      ]
    : null
  if (providers && providers.length === 0) {
    return { ok: false, message: "--providers names no provider" }
  }
  const fromEnv = env[LIVE_SMOKE_SETTINGS_ENV]?.trim()

  return {
    ok: true,
    args: {
      command: help ? "help" : confirm ? "live" : fake ? "simulated" : "dry_run",
      settingsPath: values["--settings"] ?? (fromEnv ? fromEnv : null),
      providers,
      outDir: values["--out"] ?? null,
    },
  }
}
