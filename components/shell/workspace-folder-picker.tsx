"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { ArrowUpIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { FileTree, FileTreeFolder } from "@/components/ai-elements/file-tree"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Spinner } from "@/components/ui/spinner"
import { defaultExportDir } from "@/lib/claude/ipc"
import { listWorkspaceDir, listWorkspaceRoots } from "@/lib/files/workspace-fs"
import type { WorkspaceEntry, WorkspaceRoot } from "@/lib/files/types"
import { cn } from "@/lib/utils"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialPath?: string
  onSelect: (path: string) => void
}

/** The tree node key for the active root itself. Children carry a real relPath. */
const ROOT_REL = ""

/**
 * Why a listing failed. The Host refusing the path is not the same problem as
 * the Host being unreachable.
 *
 * Both used to render "This folder could not be opened. Check the path and
 * server connection.", which sends the user to debug a connection that is
 * working. A headless Host confines browsing to its workspaces root
 * (`COGNIA_WORKSPACES_DIR`, default `<data dir>/workspaces`) and answers
 * anything outside it with a non-retryable refusal that names that root, so the
 * one fact that resolves the situation was being thrown away.
 */
interface LoadFailure {
  kind: "refused" | "unreachable"
  /** The Host's own words, when it gave any. */
  detail: string | null
}

/**
 * A Host refusal is shape-checked, not `instanceof`-checked: the error crosses
 * a module boundary, and every companion error carries `code` + `retryable`.
 * `retryable: false` is the Host saying "this will not work however many times
 * you ask", which is exactly the distinction the UI needs to draw.
 */
function classifyLoadFailure(error: unknown): LoadFailure {
  if (typeof error === "object" && error !== null) {
    const candidate = error as { code?: unknown; retryable?: unknown }
    if (typeof candidate.code === "string" && candidate.retryable === false) {
      const message = error instanceof Error ? error.message.trim() : ""
      return { kind: "refused", detail: message || null }
    }
  }
  return { kind: "unreachable", detail: null }
}

function parentDirectory(path: string): string | null {
  const trimmed = path.replace(/[\\/]+$/, "")
  if (!trimmed || trimmed === "/" || /^[A-Za-z]:$/.test(trimmed)) return null
  const separatorIndex = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"))
  if (separatorIndex < 0) return null
  if (separatorIndex === 0) return "/"
  if (separatorIndex === 2 && /^[A-Za-z]:/.test(trimmed)) return `${trimmed.slice(0, 2)}\\`
  return trimmed.slice(0, separatorIndex)
}

/**
 * Compare host paths without pretending to know the host OS. Separators are
 * folded because a Windows Host answers with backslashes while a user pastes
 * either, but case is left alone: folding it would make two distinct
 * directories look like one on the Linux and macOS hosts this mostly runs on.
 */
function normalizeForCompare(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "")
}

function samePath(a: string, b: string): boolean {
  return normalizeForCompare(a) === normalizeForCompare(b)
}

/** The path of `target` relative to `root`, or null when it is not inside it. */
function relativeToRoot(root: string, target: string): string | null {
  const base = normalizeForCompare(root)
  const path = normalizeForCompare(target)
  if (path === base) return ROOT_REL
  return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : null
}

/** Every ancestor rel from the root down to `rel`, in load order. */
function ancestorChain(rel: string): string[] {
  const segments = rel ? rel.split("/").filter(Boolean) : []
  const chain = [ROOT_REL]
  for (let index = 0; index < segments.length; index += 1) {
    chain.push(segments.slice(0, index + 1).join("/"))
  }
  return chain
}

function displayName(rel: string, root: string): string {
  if (rel) return rel.split("/").pop() ?? rel
  const trimmed = normalizeForCompare(root)
  return trimmed.split("/").pop() || root
}

interface FolderNodesProps {
  rel: string
  activeRoot: string
  childrenByRel: Record<string, WorkspaceEntry[]>
  expanded: Set<string>
  pendingRels: Set<string>
}

/**
 * One directory's folder rows, recursing into whichever are expanded.
 *
 * A component rather than a helper because it recurses: a `useCallback` that
 * calls itself reads its own binding before the declaration finishes, which is
 * exactly what `react-hooks/immutability` refuses.
 */
function FolderNodes({ rel, activeRoot, childrenByRel, expanded, pendingRels }: FolderNodesProps) {
  const t = useTranslations("workspace.manage.remotePicker")
  if (pendingRels.has(rel)) {
    return (
      <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
        <Spinner className="size-3" />
        {t("loading")}
      </div>
    )
  }
  const entries = childrenByRel[rel]
  if (!entries) return null
  if (entries.length === 0) {
    return <div className="px-2 py-1 text-xs text-muted-foreground">{t("empty")}</div>
  }
  return (
    <>
      {entries.map((entry) => (
        <FileTreeFolder
          key={entry.relPath}
          path={entry.relPath}
          name={displayName(entry.relPath, activeRoot)}
          aria-label={t("openFolder", { name: entry.relPath })}
        >
          {expanded.has(entry.relPath) ? (
            <FolderNodes
              rel={entry.relPath}
              activeRoot={activeRoot}
              childrenByRel={childrenByRel}
              expanded={expanded}
              pendingRels={pendingRels}
            />
          ) : null}
        </FileTreeFolder>
      ))}
    </>
  )
}

export function WorkspaceFolderPicker({ open, onOpenChange, initialPath, onSelect }: Props) {
  const t = useTranslations("workspace.manage.remotePicker")
  /**
   * Bumped whenever the tree is re-rooted. Every in-flight listing captures it
   * and drops its result if it no longer matches, so a slow directory from the
   * previous root cannot land in the new one's tree.
   */
  const generationRef = useRef(0)
  const [roots, setRoots] = useState<WorkspaceRoot[]>([])
  const [activeRoot, setActiveRoot] = useState("")
  const [pathDraft, setPathDraft] = useState("")
  const [childrenByRel, setChildrenByRel] = useState<Record<string, WorkspaceEntry[]>>({})
  const [absoluteByRel, setAbsoluteByRel] = useState<Record<string, string>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set([ROOT_REL]))
  const [selectedRel, setSelectedRel] = useState<string>(ROOT_REL)
  const [pendingRels, setPendingRels] = useState<Set<string>>(new Set())
  const [rootLoading, setRootLoading] = useState(false)
  const [loadFailure, setLoadFailure] = useState<LoadFailure | null>(null)

  /**
   * Re-root the tree and reveal `rel` inside it, loading the whole ancestor
   * chain so a pasted deep path lands expanded and selected rather than
   * silently collapsing back to the root.
   */
  const openRoot = useCallback(async (root: string, rel: string = ROOT_REL) => {
    const normalized = root.trim()
    if (!normalized) return
    generationRef.current += 1
    const generation = generationRef.current
    setActiveRoot(normalized)
    setChildrenByRel({})
    setAbsoluteByRel({ [ROOT_REL]: normalized })
    setExpanded(new Set([ROOT_REL]))
    setSelectedRel(ROOT_REL)
    setPendingRels(new Set())
    setLoadFailure(null)
    setRootLoading(true)
    try {
      const chain = ancestorChain(rel)
      const children: Record<string, WorkspaceEntry[]> = {}
      const absolutes: Record<string, string> = { [ROOT_REL]: normalized }
      for (const step of chain) {
        const entries = await listWorkspaceDir(normalized, step || undefined)
        if (generation !== generationRef.current) return
        const directories = entries.filter((entry) => entry.isDir)
        children[step] = directories
        for (const directory of directories) {
          absolutes[directory.relPath] = directory.absolutePath
        }
      }
      setChildrenByRel(children)
      setAbsoluteByRel(absolutes)
      setExpanded(new Set(chain))
      setSelectedRel(chain[chain.length - 1])
      setPathDraft(absolutes[chain[chain.length - 1]] ?? normalized)
    } catch (error) {
      if (generation !== generationRef.current) return
      setPathDraft(rel ? `${normalizeForCompare(normalized)}/${rel}` : normalized)
      setLoadFailure(classifyLoadFailure(error))
    } finally {
      if (generation === generationRef.current) setRootLoading(false)
    }
  }, [])

  /** Load one directory's children on demand, for a chevron expand. */
  const loadChildren = useCallback(
    async (rel: string) => {
      const generation = generationRef.current
      const root = activeRoot
      setPendingRels((previous) => new Set(previous).add(rel))
      try {
        const entries = await listWorkspaceDir(root, rel || undefined)
        if (generation !== generationRef.current) return
        const directories = entries.filter((entry) => entry.isDir)
        setChildrenByRel((previous) => ({ ...previous, [rel]: directories }))
        setAbsoluteByRel((previous) => {
          const next = { ...previous }
          for (const directory of directories) next[directory.relPath] = directory.absolutePath
          return next
        })
      } catch (error) {
        if (generation !== generationRef.current) return
        // A single unreadable subdirectory must not blank the whole tree: mark
        // it empty so the row stops spinning and the rest stays usable.
        setChildrenByRel((previous) => ({ ...previous, [rel]: [] }))
        setLoadFailure(classifyLoadFailure(error))
      } finally {
        if (generation === generationRef.current) {
          setPendingRels((previous) => {
            const next = new Set(previous)
            next.delete(rel)
            return next
          })
        }
      }
    },
    [activeRoot]
  )

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void (async () => {
      // An old Host answers `unknown_command` here, which resolves to an empty
      // list rather than throwing. Empty means "this Host did not say", so the
      // fallback below still has to run.
      const reported = await listWorkspaceRoots()
      if (cancelled) return
      setRoots(reported)
      const requested = initialPath?.trim()
      if (requested) {
        const containing = reported.find((root) => relativeToRoot(root.path, requested) !== null)
        await openRoot(
          containing?.path ?? requested,
          containing ? relativeToRoot(containing.path, requested)! : ROOT_REL
        )
        return
      }
      if (reported.length > 0) {
        await openRoot(reported[0].path)
        return
      }
      try {
        const fallback = await defaultExportDir()
        if (!cancelled) await openRoot(fallback)
      } catch (error) {
        if (!cancelled) setLoadFailure(classifyLoadFailure(error))
      }
    })()
    return () => {
      cancelled = true
      generationRef.current += 1
    }
  }, [initialPath, openRoot, open])

  const handleExpandedChange = useCallback(
    (next: Set<string>) => {
      setExpanded(next)
      for (const rel of next) {
        if (!(rel in childrenByRel) && !pendingRels.has(rel)) void loadChildren(rel)
      }
    },
    [childrenByRel, loadChildren, pendingRels]
  )

  const handleSelect = useCallback(
    (rel: string) => {
      setSelectedRel(rel)
      setPathDraft(absoluteByRel[rel] ?? activeRoot)
      if (!expanded.has(rel)) {
        setExpanded((previous) => new Set(previous).add(rel))
        if (!(rel in childrenByRel) && !pendingRels.has(rel)) void loadChildren(rel)
      }
    },
    [absoluteByRel, activeRoot, childrenByRel, expanded, loadChildren, pendingRels]
  )

  const submitPath = useCallback(
    (raw: string) => {
      const target = raw.trim()
      if (!target) return
      const containing = roots.find((root) => relativeToRoot(root.path, target) !== null)
      if (containing) {
        void openRoot(containing.path, relativeToRoot(containing.path, target) ?? ROOT_REL)
        return
      }
      // Not inside anything the Host declared. Try it anyway as its own root:
      // a desktop Host browses any absolute path the local user names, and only
      // the Host can say whether this one is refused.
      void openRoot(target)
    },
    [openRoot, roots]
  )

  const parent = parentDirectory(activeRoot)
  const confinedToRoot = roots.some((root) => samePath(root.path, activeRoot))
  const busy = rootLoading || pendingRels.size > 0
  const chosenPath = absoluteByRel[selectedRel] ?? activeRoot

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0 sm:max-w-xl">
        <DialogHeader className="border-b px-6 py-5 pr-12">
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 px-6">
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              submitPath(pathDraft)
            }}
          >
            <Input
              value={pathDraft}
              onChange={(event) => setPathDraft(event.target.value)}
              aria-label={t("pathLabel")}
              placeholder={t("pathPlaceholder")}
              className="font-mono text-xs"
            />
            <Button type="submit" variant="secondary" disabled={!pathDraft.trim() || busy}>
              {t("go")}
            </Button>
          </form>

          {roots.length > 0 ? (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">{t("rootsLabel")}</p>
              <ul className="flex flex-wrap gap-1.5">
                {roots.map((root) => (
                  <li key={root.path}>
                    <Button
                      type="button"
                      size="sm"
                      variant={samePath(root.path, activeRoot) ? "secondary" : "ghost"}
                      className="h-auto max-w-full flex-col items-start gap-0 px-2 py-1 text-left"
                      disabled={busy}
                      onClick={() => void openRoot(root.path)}
                      aria-label={t("openRootAction", { path: root.path })}
                    >
                      <span className="w-full truncate font-mono text-xs">{root.path}</span>
                      <span className="w-full truncate text-[0.7rem] font-normal text-muted-foreground">
                        {root.source === "headless-workspaces-dir"
                          ? t("rootHeadless")
                          : t("rootDesktop")}
                      </span>
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-2 py-1.5">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={!parent || confinedToRoot || busy}
              aria-label={t("up")}
              title={confinedToRoot ? t("upConfined") : t("up")}
              onClick={() => parent && void openRoot(parent)}
            >
              <ArrowUpIcon className="size-4" />
            </Button>
            <span className="min-w-0 flex-1 truncate font-mono text-xs" title={chosenPath}>
              {chosenPath || pathDraft}
            </span>
          </div>

          <ScrollArea className="h-64 rounded-md border">
            {rootLoading ? (
              <div className="flex h-64 items-center justify-center gap-2 text-sm text-muted-foreground">
                <Spinner className="size-4" />
                {t("loading")}
              </div>
            ) : loadFailure ? (
              <div className="flex h-64 flex-col items-center justify-center gap-1.5 px-6 text-center text-sm">
                <span className="text-destructive">
                  {loadFailure.kind === "refused" ? t("loadRefused") : t("loadError")}
                </span>
                {loadFailure.detail ? (
                  <span className="font-mono text-xs break-all text-muted-foreground">
                    {loadFailure.detail}
                  </span>
                ) : null}
                {roots.length > 0 ? (
                  <div className="flex flex-wrap justify-center gap-1.5 pt-1">
                    {roots.map((root) => (
                      <Button
                        key={root.path}
                        type="button"
                        size="sm"
                        variant="secondary"
                        className="max-w-full font-mono text-xs"
                        onClick={() => void openRoot(root.path)}
                      >
                        <span className="truncate">{root.path}</span>
                      </Button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : (
              <FileTree
                className={cn("border-0 bg-transparent")}
                expanded={expanded}
                selectedPath={selectedRel}
                onSelect={handleSelect}
                onExpandedChange={handleExpandedChange}
                aria-label={t("folderList")}
              >
                <FileTreeFolder
                  path={ROOT_REL}
                  name={displayName(ROOT_REL, activeRoot)}
                  aria-label={t("openFolder", { name: activeRoot })}
                >
                  {expanded.has(ROOT_REL) ? (
                    <FolderNodes
                      rel={ROOT_REL}
                      activeRoot={activeRoot}
                      childrenByRel={childrenByRel}
                      expanded={expanded}
                      pendingRels={pendingRels}
                    />
                  ) : null}
                </FileTreeFolder>
              </FileTree>
            )}
          </ScrollArea>
        </div>

        <DialogFooter className="border-t bg-muted/20 px-6 py-4">
          <Button
            type="button"
            disabled={!chosenPath || busy || Boolean(loadFailure)}
            onClick={() => {
              onSelect(chosenPath)
              onOpenChange(false)
            }}
          >
            {t("chooseCurrent")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default WorkspaceFolderPicker
