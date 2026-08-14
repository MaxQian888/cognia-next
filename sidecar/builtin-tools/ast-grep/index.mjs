// `ast_grep_search` / `ast_grep_replace` — AST-aware structural code search and
// refactoring across 25 languages, backed by the `ast-grep` CLI. Ported from
// oh-my-opencode-slim's `src/tools/ast-grep/tools.ts` into cognia's sidecar
// tool shape (`tool(name, desc, shape, exec)` → `toolText`/`toolError`).
//
// Unlike text grep, ast-grep matches code STRUCTURE: patterns use meta-variables
// (`$VAR` = one node, `$$$` = many) and must be complete AST nodes. It is
// complementary to the resolver-bound `codegraph_*` tools (symbol graph /
// navigation) — this is pattern search + structural rewrite.

import { z } from "zod"
import { tool } from "@anthropic-ai/claude-agent-sdk"

import { toolError, toolText } from "../safety.mjs"
import { CLI_LANGUAGES } from "./languages.mjs"
import { runSg } from "./run.mjs"
import { formatSearchResult, formatReplaceResult, getEmptyResultHint } from "./format.mjs"

const langEnum = z.enum(/** @type {[string, ...string[]]} */ (CLI_LANGUAGES))

// ---- ast_grep_search ------------------------------------------------------

export const astGrepSearchShape = {
  pattern: z
    .string()
    .min(1)
    .describe(
      "AST pattern with meta-variables ($VAR = one node, $$$ = many). Must be a complete AST " +
        "node, e.g. 'console.log($MSG)', 'function $NAME($$$) { $$$ }', 'def $FUNC($$$):'."
    ),
  lang: langEnum.describe("Target language (one of the 25 supported)."),
  paths: z.array(z.string()).optional().describe("Paths to search (default: ['.'])."),
  globs: z
    .array(z.string())
    .optional()
    .describe("Include/exclude globs (prefix ! to exclude), e.g. '!**/node_modules/**'."),
  context: z.number().int().min(0).optional().describe("Context lines around each match."),
}

/**
 * @param {z.infer<z.ZodObject<typeof astGrepSearchShape>>} args
 * @param {{ run?: typeof runSg, cwd?: string }} [deps] Injected runner (tests)
 *        plus the session cwd. The SDK passes its tool context here at runtime,
 *        which has neither field, so both fall back safely.
 */
export async function execAstGrepSearch(args, deps = {}) {
  const run = deps && typeof deps === "object" && typeof deps.run === "function" ? deps.run : runSg
  try {
    const result = await run({
      pattern: args.pattern,
      lang: args.lang,
      paths: args.paths,
      globs: args.globs,
      context: args.context,
      // Without this the child inherits the SIDECAR process cwd, so the
      // documented `paths: ['.']` default resolved against wherever Tauri/the
      // CLI was launched rather than the agent's workspace.
      cwd: deps?.cwd,
    })
    let output = formatSearchResult(result)
    if (result.matches.length === 0 && !result.error) {
      const hint = getEmptyResultHint(args.pattern, args.lang)
      if (hint) output += `\n\n${hint}`
    }
    return result.error ? toolError(output) : toolText(output)
  } catch (err) {
    return toolError(err, "ast_grep_search")
  }
}

export const astGrepSearchTool = tool(
  "ast_grep_search",
  "Search code by AST structure across 25 languages (more precise than text grep). Read-only. " +
    "Patterns use meta-variables: $VAR (one node), $$$ (many); they must be complete AST nodes.",
  astGrepSearchShape,
  execAstGrepSearch
)

// ---- ast_grep_replace -----------------------------------------------------

export const astGrepReplaceShape = {
  pattern: z.string().min(1).describe("AST pattern to match (meta-variables allowed)."),
  rewrite: z
    .string()
    .describe(
      "Replacement pattern. Reuse matched meta-variables, e.g. pattern 'console.log($MSG)' rewrite 'logger.info($MSG)'."
    ),
  lang: langEnum.describe("Target language."),
  paths: z.array(z.string()).optional().describe("Paths to search (default: ['.'])."),
  globs: z.array(z.string()).optional().describe("Include/exclude globs (prefix ! to exclude)."),
  dry_run: z
    .boolean()
    .default(true)
    .describe(
      "When true (default), preview changes without writing. Set false to apply them to disk."
    ),
}

/**
 * @param {z.infer<z.ZodObject<typeof astGrepReplaceShape>>} args
 * @param {{ run?: typeof runSg, cwd?: string }} [deps] Injected runner (tests)
 *        plus the session cwd; see search.
 */
export async function execAstGrepReplace(args, deps = {}) {
  const run = deps && typeof deps === "object" && typeof deps.run === "function" ? deps.run : runSg
  try {
    const dryRun = args.dry_run !== false
    const result = await run({
      pattern: args.pattern,
      lang: args.lang,
      rewrite: args.rewrite,
      paths: args.paths,
      globs: args.globs,
      // Only write to disk when explicitly not a dry run.
      updateAll: !dryRun,
      // Critical for the write path: without the session cwd a non-dry-run
      // rewrite applied to an unrelated directory tree.
      cwd: deps?.cwd,
    })
    const output = formatReplaceResult(result, dryRun)
    return result.error ? toolError(output) : toolText(output)
  } catch (err) {
    return toolError(err, "ast_grep_replace")
  }
}

export const astGrepReplaceTool = tool(
  "ast_grep_replace",
  "Refactor code by AST-aware structural rewrite across 25 languages. Dry-run by default " +
    "(set dry_run:false to write). Meta-variables in the rewrite preserve matched content.",
  astGrepReplaceShape,
  execAstGrepReplace
)

// ---- category export ------------------------------------------------------

/** Fixed registration order — do not reorder (prompt-cache stability). New tools APPEND. */
export const AST_GREP_TOOL_NAMES = Object.freeze(["ast_grep_search", "ast_grep_replace"])

/**
 * Session-bound ast-grep tools. The `ast-grep` child process must run in the
 * SESSION cwd, not the sidecar's — mirrors the `createProcessTools` pattern in
 * `../index.mjs`, which swaps a static category for a bound one at the same
 * registration position.
 *
 * @param {{ cwd?: string }} [ctx]
 */
export function createAstGrepTools({ cwd } = {}) {
  return [
    tool("ast_grep_search", astGrepSearchTool.description, astGrepSearchShape, (args) =>
      execAstGrepSearch(args, { cwd })
    ),
    tool("ast_grep_replace", astGrepReplaceTool.description, astGrepReplaceShape, (args) =>
      execAstGrepReplace(args, { cwd })
    ),
  ]
}

/** All ast-grep tool definitions, in AST_GREP_TOOL_NAMES order. */
export const astGrepTools = [astGrepSearchTool, astGrepReplaceTool]

// Defensive: emitted order must match the public constant.
for (let i = 0; i < astGrepTools.length; i++) {
  if (astGrepTools[i].name !== AST_GREP_TOOL_NAMES[i]) {
    throw new Error(
      `ast-grep tool order drift: expected ${AST_GREP_TOOL_NAMES[i]}, got ${astGrepTools[i].name}`
    )
  }
}

/** Test-only handler exports so the suite can hit them without the SDK transport. */
export const __testExports = { execAstGrepSearch, execAstGrepReplace }
