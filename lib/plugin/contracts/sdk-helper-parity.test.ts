import { readFileSync } from "node:fs"
import { join } from "node:path"

import { REPO_ROOT } from "./contract-path-audit"
import { PLUGIN_CAPABILITY_CONTRACTS, getPluginCapabilityContract } from "./plugin-capabilities"

/**
 * Content-level SDK parity for the plugin capability contracts.
 *
 * `contract-path-audit` already proves every contract proof PATH exists on disk.
 * This guard goes one level deeper — it proves the bound SDK files still contain
 * the symbol the contract claims, which is where staleness historically hid (a
 * file listed in the contract whose helper/type was later renamed or deleted).
 *
 * It generalizes the former `compaction-strategy-parity.test.ts` (now subsumed)
 * across every `supported` capability that ships a `define-*` helper, and adds
 * the experimental-drift guard (③) that would have caught the cli-tools /
 * lsp-server promotion miss.
 */

const DEFINE_HELPER_RE = /packages\/plugin-sdk\/src\/define\/(define-[a-z0-9-]+)\.ts$/

/** `define-cli-tool` → `defineCliTool` (kebab → camelCase). */
function kebabToCamel(name: string): string {
  return name
    .split("-")
    .map((part, i) => (i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join("")
}

describe("plugin SDK helper parity (content-level)", () => {
  const supported = PLUGIN_CAPABILITY_CONTRACTS.filter((c) => c.support === "supported")

  // Broad TS guard: every supported capability advertising a `define-*.ts`
  // helper must have that file still expose the matching `define<Symbol>` export.
  // A substring match (like the prior compaction test) tolerates harmless suffix
  // differences such as `define-terminal-completion` → `defineTerminalCompletionProvider`.
  const tsCases = supported.flatMap((contract) =>
    contract.typescriptSdk
      .map((rel) => ({ rel, match: DEFINE_HELPER_RE.exec(rel.replace(/\\/g, "/")) }))
      .filter((x): x is { rel: string; match: RegExpExecArray } => x.match !== null)
      .map(({ rel, match }) => ({ capability: contract.id, rel, symbol: kebabToCamel(match[1]) }))
  )

  it("discovers the define-helper-backed capabilities to guard", () => {
    // Sanity: the broad scan actually found helpers (cli-tools, lsp-server,
    // compaction-strategy, theme, exporter, … all ship a define-*.ts). Guards
    // against a refactor silently zeroing the matcher.
    expect(tsCases.length).toBeGreaterThan(10)
  })

  it.each(tsCases)("$capability — $rel still exports $symbol", ({ rel, symbol }) => {
    const src = readFileSync(join(REPO_ROOT, rel), "utf8")
    expect(src).toContain(symbol)
  })

  // Python parity is heterogeneous (snake_case modules, dataclass names without a
  // uniform `Def` suffix, most caps share the generic `types.py` / `context.py`),
  // so it is asserted per-capability where a concrete type name is known rather
  // than derived. Ported verbatim from the former compaction-strategy-parity test.
  it("compaction-strategy ships its Python SDK type", () => {
    const contract = getPluginCapabilityContract("compaction-strategy")
    const paths = (contract?.pythonSdk ?? []) as string[]
    expect(paths.length).toBeGreaterThan(0)
    const found = paths.some((rel) =>
      readFileSync(join(REPO_ROOT, rel), "utf8").includes("CompactionStrategyDef")
    )
    expect(found).toBe(true)
  })

  // ③ Experimental capabilities must NOT advertise a typed `define-*` helper.
  // The moment a dedicated `define-*.ts` helper is wired into `typescriptSdk`,
  // the contract must be promoted to `supported` (which then subjects it to the
  // proof audit + the content checks above). Otherwise an expired "no helper yet"
  // justification hides forever — the exact cli-tools / lsp-server drift this
  // guard was added to prevent. (Generic SDK surfaces a capability may legitimately
  // reference while experimental — `index.ts`, `context/extended.ts`,
  // `capability_contract.py` — are intentionally not a promotion signal.)
  it("no experimental capability advertises a typed define-* SDK helper", () => {
    const offenders = PLUGIN_CAPABILITY_CONTRACTS.filter((c) => c.support === "experimental")
      .filter((c) => c.typescriptSdk.some((rel) => DEFINE_HELPER_RE.test(rel.replace(/\\/g, "/"))))
      .map((c) => c.id)
    expect(offenders).toEqual([])
  })
})
