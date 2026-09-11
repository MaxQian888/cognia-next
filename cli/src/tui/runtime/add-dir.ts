/**
 * Pure logic for `/add-dir` — manage the extra working roots the agent may read
 * (`config.additionalRoots`, unioned into the SDK's `additionalDirectories`).
 *
 * Kept pure (fs probes injected) so the App stays a thin interpreter: it calls
 * {@link computeAddDir}, then — when `roots` is returned — persists them, patches
 * the in-memory config (`SET_ADDITIONAL_ROOTS`), and invalidates the session so
 * the next turn rebuilds with the new dirs.
 */
import path from "node:path"
import { createCliTranslator, type CliLocale } from "../i18n"

export type AddDirOp = "add" | "remove" | "list"

export interface AddDirDeps {
  config: { additionalRoots?: string[]; locale?: CliLocale }
  /** Resolve relative paths against the working dir. */
  cwd: string
  exists: (p: string) => boolean
  isDir: (p: string) => boolean
}

export interface AddDirResult {
  /** New root list to persist + apply. Omitted when nothing changed (list/error). */
  roots?: string[]
  /** User-facing notice. */
  message: string
}

export function computeAddDir(op: AddDirOp, arg: string, deps: AddDirDeps): AddDirResult {
  const roots = deps.config.additionalRoots ?? []
  const t = createCliTranslator(deps.config.locale, "cliUiStartup")

  if (op === "list") {
    if (roots.length === 0) {
      return { message: t("rootsEmpty", { command: "/add-dir <path>" }) }
    }
    return {
      message: t("rootsTitle") + "\n" + roots.map((r, i) => `  ${i + 1}. ${r}`).join("\n"),
    }
  }

  const raw = arg.trim()
  if (!raw) {
    return {
      message: t(op === "remove" ? "rootsRemoveUsage" : "rootsAddUsage", {
        command: op === "remove" ? "/add-dir remove <path | index>" : "/add-dir <path>",
      }),
    }
  }

  if (op === "remove") {
    const idx = Number(raw)
    let target: string | undefined
    if (Number.isInteger(idx) && idx >= 1 && idx <= roots.length) {
      target = roots[idx - 1]
    } else {
      const abs = path.isAbsolute(raw) ? raw : path.resolve(deps.cwd, raw)
      target = roots.find((r) => r === raw || r === abs)
    }
    if (!target) return { message: t("rootsUnknown", { path: raw }) }
    return {
      roots: roots.filter((r) => r !== target),
      message: t("rootsRemoved", { path: target }),
    }
  }

  // add
  const abs = path.isAbsolute(raw) ? raw : path.resolve(deps.cwd, raw)
  if (!deps.exists(abs) || !deps.isDir(abs)) {
    return { message: t("rootsInvalid", { path: abs }) }
  }
  if (roots.includes(abs)) {
    return { message: t("rootsDuplicate", { path: abs }) }
  }
  return {
    roots: [...roots, abs],
    message: t("rootsAdded", { path: abs }),
  }
}
