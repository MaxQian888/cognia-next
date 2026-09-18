// Built-in hook: deny a tool call by its provenance — which surface declared it.
//
// Fires on PreToolUse. The deny list comes from env
// `COGNIA_DENY_TOOL_PROVENANCE`: a comma-separated set of selectors —
//   kind                  → any tool of that class ("mcp", "plugin", ...)
//   kind:source           → one declaring surface ("mcp:github", "plugin:ripgrep-tools")
//   kind:source:declared  → one declaring artifact ("mcp:github:.mcp.json")
// The third segment is a substring match against `declared_by` so a config-file
// basename pins every server the file declares.
//
// A tool with no resolvable provenance, or a selector list that is absent or
// empty, soft-allows (exit 0): an unconfigured guard must never block a turn.
// Blocks by exiting 2 with a reason on stderr — the contract honoured by BOTH
// the Rust command handler (exit 2 ⇒ block, stderr line = reason) and the CLI
// runner (non-zero exit on a blocking event ⇒ deny).
import { readFileSync } from "node:fs"

let input
try {
  input = JSON.parse(readFileSync(0, "utf8"))
} catch {
  process.exit(0)
}

const selectors = (process.env.COGNIA_DENY_TOOL_PROVENANCE ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
if (selectors.length === 0) process.exit(0)

const prov = input.tool_provenance
if (!prov || typeof prov !== "object") process.exit(0)

const kind = typeof prov.kind === "string" ? prov.kind : ""
const source = typeof prov.source === "string" ? prov.source : ""
const declaredBy = typeof prov.declared_by === "string" ? prov.declared_by : ""

for (const selector of selectors) {
  const [selKind, selSource, selDeclared] = selector.split(":")
  if (selKind !== kind) continue
  if (selSource !== undefined && selSource !== source) continue
  if (selDeclared !== undefined && !declaredBy.includes(selDeclared)) continue
  process.stderr.write(
    `Tool denied by provenance guard: ${typeof input.tool_name === "string" ? input.tool_name : "tool"} ` +
      `is ${kind}${source ? ` from ${source}` : ""}` +
      `${declaredBy ? ` (declared by ${declaredBy})` : ""}` +
      ` — matches COGNIA_DENY_TOOL_PROVENANCE selector "${selector}".\n`
  )
  process.exit(2)
}
process.exit(0)
