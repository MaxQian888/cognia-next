/**
 * Pure template-substitution for custom slash commands, split out of `builtin.ts`
 * so consumers (the desktop picker AND the standalone CLI) can import it without
 * dragging in `builtin.ts`'s store / React / settings-nav side effects. Mirrors
 * how `build-args.ts` is a pure sibling the CLI already imports.
 */

/**
 * Replace `$ARGUMENTS` and `$1..$9` placeholders in a template body. The `args`
 * string is split on whitespace for positional substitution; the whole `args`
 * string is used for `$ARGUMENTS`. Unfilled positionals collapse to empty.
 */
export function applyTemplate(template: string, args: string): string {
  const positional = args.trim().split(/\s+/).filter(Boolean)
  let out = template.replace(/\$ARGUMENTS/g, args.trim())
  out = out.replace(/\$([1-9])/g, (_, n) => positional[Number(n) - 1] ?? "")
  return out
}
