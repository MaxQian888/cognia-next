// Put a saved template into the checkout, as `.cognia/templates/<slug>.md`.
//
// The read path (`repo-templates.ts` + `hooks/chat/use-repo-chat-templates.ts`)
// treats a checkout as an untrusted author: it reads under Workspace Trust and
// demotes whatever setup the file proposes. Writing is the mirror image, and it
// needs the SAME verdict for a different reason. Reading an untrusted checkout
// risks what the file says to you. Writing into one puts your text somewhere you
// have already said you do not trust, in a directory the app itself treats as
// authoritative for everyone who clones it next.
//
// So the gate is not "can this device write files" (it can), it is the one
// verdict `loadRepoChatTemplates` already asks for, resolved by the same
// function so the two answers cannot drift apart.

import {
  REPO_TEMPLATE_DIR,
  repoTemplatePath,
  serializeChatTemplate,
  type SerializableChatTemplate,
} from "./repo-templates"

/**
 * Is this workspace root outside the trust boundary?
 *
 * Every field resolved lazily, so a caller that injects the dependency (tests,
 * and the read hook's own default) does not drag the settings store, the trust
 * gate and the Tauri bridge in behind it.
 *
 * Fails CLOSED at the call sites: both the reader and the writer treat a thrown
 * verdict as restricted, because a trust question nobody could answer is not an
 * answer of "yes".
 */
export async function isRepoTemplateWorkspaceRestricted(root: string): Promise<boolean> {
  const [{ isWorkspaceRestricted }, { useSettingsStore }, { isTauri }] = await Promise.all([
    import("@/lib/workspace/trust-gate"),
    import("@/stores/settings"),
    import("@/lib/tauri"),
  ])
  // A single-root stand-in for the directory the templates are actually being
  // read from or written to. Asking about the ACTIVE project instead would
  // answer about a different checkout whenever the session overrides its
  // working directory.
  return isWorkspaceRestricted(
    { roots: [{ id: root, path: root, isPrimary: true }] },
    {
      enabled: useSettingsStore.getState().settings?.workspaceTrust?.enabled !== false,
      onWeb: !isTauri(),
    }
  )
}

export type SaveRepoTemplateOutcome =
  | { ok: true; path: string }
  /**
   * `exists` is not a failure so much as a question. The caller re-issues with
   * `overwrite` once the user has confirmed. A repository file is reviewed and
   * versioned by other people, and clobbering one without asking is how a
   * template someone else wrote disappears in a commit nobody reads.
   */
  | { ok: false; reason: "no-root" | "restricted" | "exists" | "failed"; path: string }

export interface RepoTemplateWriteDeps {
  isRestricted(root: string): Promise<boolean>
  exists(root: string, relPath: string): Promise<boolean>
  createDir(root: string, relPath: string): Promise<void>
  writeFile(root: string, relPath: string, content: string): Promise<void>
}

const DEFAULT_DEPS: RepoTemplateWriteDeps = {
  isRestricted: isRepoTemplateWorkspaceRestricted,
  exists: async (root, relPath) => {
    const { statWorkspaceFile } = await import("@/lib/files/workspace-fs")
    // `statWorkspaceFile` answers `{ exists: false }` rather than throwing for
    // an absent path, which is the whole reason it is the probe here.
    return (await statWorkspaceFile(root, relPath)).exists
  },
  createDir: async (root, relPath) => {
    const { createWorkspaceDir } = await import("@/lib/files/workspace-fs")
    await createWorkspaceDir(root, relPath)
  },
  writeFile: async (root, relPath, content) => {
    const { writeWorkspaceFile } = await import("@/lib/files/workspace-fs")
    await writeWorkspaceFile(root, relPath, content)
  },
}

/**
 * Write one template into `root`, returning what happened rather than throwing.
 *
 * Every refusal is a distinct reason because each one has a different thing the
 * user can do about it: pick a workspace, trust this one, confirm the
 * overwrite, or look at why the host refused the write.
 */
export async function saveChatTemplateToRepository(
  root: string | null | undefined,
  template: SerializableChatTemplate,
  options: { overwrite?: boolean } = {},
  deps: Partial<RepoTemplateWriteDeps> = {}
): Promise<SaveRepoTemplateOutcome> {
  const resolved: RepoTemplateWriteDeps = { ...DEFAULT_DEPS, ...deps }
  const path = repoTemplatePath(template.name)
  const cwd = root?.trim()
  if (!cwd) return { ok: false, reason: "no-root", path }

  if (await resolved.isRestricted(cwd).catch(() => true)) {
    return { ok: false, reason: "restricted", path }
  }

  if (!options.overwrite) {
    // A probe that cannot answer is treated as "already there": asking one
    // needless question is cheaper than silently replacing a teammate's file.
    const present = await resolved.exists(cwd, path).catch(() => true)
    if (present) return { ok: false, reason: "exists", path }
  }

  try {
    // `writeWorkspaceFile` creates parents on its own. Creating the directory
    // first is still worth the round trip: it is the call that fails when the
    // host refuses to write under this root at all, and failing there names the
    // directory rather than the file.
    await resolved.createDir(cwd, REPO_TEMPLATE_DIR)
    await resolved.writeFile(cwd, path, serializeChatTemplate(template))
  } catch {
    return { ok: false, reason: "failed", path }
  }
  return { ok: true, path }
}
