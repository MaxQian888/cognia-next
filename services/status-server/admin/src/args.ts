/**
 * Minimal, strict argument parsing for the operator CLI. Unknown flags are
 * errors (a typo must never silently drop a field from an operator write).
 */

export interface ParsedArgs {
  positionals: string[]
  values: Map<string, string[]>
  switches: Set<string>
}

export class UsageError extends Error {
  override name = "UsageError"
}

/**
 * `known.values` take a value (`--flag value` or `--flag=value`, repeatable);
 * `known.switches` are booleans and take none.
 */
export function parseArgs(
  argv: readonly string[],
  known: { values: readonly string[]; switches: readonly string[] }
): ParsedArgs {
  const positionals: string[] = []
  const values = new Map<string, string[]>()
  const switches = new Set<string>()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? ""
    if (arg === "--") {
      positionals.push(...argv.slice(index + 1))
      break
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg)
      continue
    }
    const eq = arg.indexOf("=")
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq)
    if (known.switches.includes(name)) {
      if (eq !== -1) throw new UsageError(`--${name} takes no value`)
      switches.add(name)
      continue
    }
    if (!known.values.includes(name)) throw new UsageError(`unknown option --${name}`)
    let value: string | undefined
    if (eq !== -1) {
      value = arg.slice(eq + 1)
    } else {
      value = argv[index + 1]
      index += 1
    }
    if (value === undefined || (eq === -1 && value.startsWith("--"))) {
      throw new UsageError(`--${name} needs a value`)
    }
    values.set(name, [...(values.get(name) ?? []), value])
  }
  return { positionals, values, switches }
}

export function optionalValue(args: ParsedArgs, name: string): string | undefined {
  const list = args.values.get(name)
  if (!list) return undefined
  if (list.length > 1) throw new UsageError(`--${name} given more than once`)
  return list[0]
}

export function requiredValue(args: ParsedArgs, name: string): string {
  const value = optionalValue(args, name)
  if (value === undefined || value.trim() === "") throw new UsageError(`--${name} is required`)
  return value
}

export function integerValue(args: ParsedArgs, name: string, required: true): number
export function integerValue(args: ParsedArgs, name: string, required: false): number | undefined
export function integerValue(
  args: ParsedArgs,
  name: string,
  required: boolean
): number | undefined {
  const raw = required ? requiredValue(args, name) : optionalValue(args, name)
  if (raw === undefined) return undefined
  if (!/^\d+$/.test(raw)) throw new UsageError(`--${name} must be a non-negative integer`)
  return Number(raw)
}

export function listValue(args: ParsedArgs, name: string): string[] | undefined {
  const raw = optionalValue(args, name)
  if (raw === undefined) return undefined
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}
