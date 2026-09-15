/**
 * Finding a repository's runtime-environment declaration (ADR-0182).
 *
 * Order, first match wins:
 *
 * 1. The `environment` block of `.cognia/workspace.json` — inline, or a
 *    pointer to a devcontainer file (which the block may extend with egress
 *    domains).
 * 2. `.devcontainer/devcontainer.json`, then `.devcontainer.json`.
 *
 * A workspace.json that fails to parse is reported as the verdict rather than
 * skipped past: if the file meant to declare an environment, falling through
 * to a devcontainer would run something the repository did not choose.
 *
 * # Trust
 *
 * An untrusted checkout (ADR-0147) is not read at all — neither file. The
 * declaration's own approval is separate from the workspace.json approval:
 * approving setup scripts does not approve an image, and vice versa, so an
 * `unapproved` workspace.json still yields its environment declaration for
 * the environment approval to judge.
 */

import {
  parseDevcontainer,
  DEVCONTAINER_CANDIDATE_PATHS,
  DEVCONTAINER_MAX_BYTES,
} from "./devcontainer"
import {
  environmentDeclarationDigest,
  WORKSPACE_CONFIG_DECLARATION_PATH,
  type DeclarationNotice,
  type DeclarationProblem,
  type EnvironmentDeclaration,
} from "./environment-declaration"
import type { WorkspaceConfigVerdict } from "./workspace-config-trust"

export type EnvironmentDeclarationVerdict =
  /** Neither file declares an environment. */
  | { kind: "absent" }
  /** The workspace is not trusted; nothing was read. */
  | { kind: "restricted" }
  /** A declaring file exists and does not parse. */
  | { kind: "invalid"; path: string; problems: DeclarationProblem[]; notices: DeclarationNotice[] }
  | {
      kind: "declared"
      declaration: EnvironmentDeclaration
      /** `environmentDeclarationDigest` — what an approval is keyed on. */
      digest: string
      notices: DeclarationNotice[]
    }

export interface ReadEnvironmentDeclarationInput {
  /** The run's execution root — the branch the run is actually on. */
  root: string | null | undefined
  /** `evaluateWorkspaceConfig`'s verdict for the same root. */
  workspaceConfig: WorkspaceConfigVerdict
  /** Whether the workspace trust gate restricts this checkout. */
  restricted: boolean
}

export interface ReadEnvironmentDeclarationDeps {
  readFile: (root: string, relPath: string, maxBytes: number) => Promise<string>
}

const NOT_FOUND = /not found|no such file|does not exist|ENOENT/i

export async function readEnvironmentDeclaration(
  input: ReadEnvironmentDeclarationInput,
  deps: ReadEnvironmentDeclarationDeps
): Promise<EnvironmentDeclarationVerdict> {
  const root = input.root?.trim()
  if (!root) return { kind: "absent" }
  if (input.restricted || input.workspaceConfig.kind === "restricted") return { kind: "restricted" }

  const verdict = input.workspaceConfig
  if (verdict.kind === "invalid") {
    // Only an environment problem makes the environment invalid; a broken
    // `setup` block says nothing about which image the repository wants.
    if (verdict.field === "environment" || verdict.field.startsWith("environment.")) {
      return {
        kind: "invalid",
        path: WORKSPACE_CONFIG_DECLARATION_PATH,
        problems: verdict.problems ?? [{ code: "declaration_not_object", field: verdict.field }],
        notices: [],
      }
    }
  }

  const block =
    verdict.kind === "approved" || verdict.kind === "unapproved"
      ? verdict.config.environment
      : undefined
  if (block?.kind === "inline") {
    return declared(block.declaration, [])
  }
  if (block?.kind === "devcontainer") {
    const text = await readOptional(deps, root, block.path)
    if (text === null) {
      return {
        kind: "invalid",
        path: WORKSPACE_CONFIG_DECLARATION_PATH,
        problems: [
          {
            code: "declaration_path_invalid",
            field: "environment.devcontainer",
            detail: { reason: "missing" },
          },
        ],
        notices: [],
      }
    }
    const parsed = parseDevcontainer(text, block.path)
    if (!parsed.ok)
      return {
        kind: "invalid",
        path: block.path,
        problems: parsed.problems,
        notices: parsed.notices,
      }
    return declared({ ...parsed.declaration, egressDomains: block.egressDomains }, parsed.notices)
  }

  for (const path of DEVCONTAINER_CANDIDATE_PATHS) {
    const text = await readOptional(deps, root, path)
    if (text === null) continue
    const parsed = parseDevcontainer(text, path)
    if (!parsed.ok)
      return { kind: "invalid", path, problems: parsed.problems, notices: parsed.notices }
    return declared(parsed.declaration, parsed.notices)
  }
  return { kind: "absent" }
}

async function declared(
  declaration: EnvironmentDeclaration,
  notices: DeclarationNotice[]
): Promise<EnvironmentDeclarationVerdict> {
  return {
    kind: "declared",
    declaration,
    digest: await environmentDeclarationDigest(declaration),
    notices,
  }
}

/** The file's text, `null` when it does not exist. Any other read failure propagates. */
async function readOptional(
  deps: ReadEnvironmentDeclarationDeps,
  root: string,
  path: string
): Promise<string | null> {
  try {
    // One byte over the limit so the parser, not the reader, reports "too large".
    return await deps.readFile(root, path, DEVCONTAINER_MAX_BYTES + 1)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    if (NOT_FOUND.test(message)) return null
    throw cause
  }
}
