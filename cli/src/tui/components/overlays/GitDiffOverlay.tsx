import { parseMouseEvent, mouseEventPosition } from "../../input/mouse"
import { absoluteTopLeft } from "../../input/element-position"
import { usePanelClick } from "../../input/use-panel-click"
import React from "react"
import { Box, Text, type DOMElement } from "ink"
import { useCriticalInput } from "../../input/input-router"
import { useCliLocale, useCliTranslations } from "../../i18n"
import {
  gitDiffFileStats,
  gitDiffFileBody,
  type GitDiffReview,
  type GitDiffScope,
} from "../../runtime/git-diff"
import { useScreenReader } from "../../render/context"
import { useTheme } from "../../theme/context"
import { DocumentViewer } from "./DocumentViewer"

/** Keep one terminal row per path, including filenames with tabs/newlines. */
const displayPath = (path: string) => JSON.stringify(path).slice(1, -1)

export interface GitDiffOverlayProps {
  review: GitDiffReview
  status?: "loading" | "failed"
  onClose: () => void
  onCopy?: (body: string) => void
  onRefresh?: () => void
  columns?: number
  viewportRows?: number
}

/** File-oriented review reuses the pager's full source search and copy behavior. */
export function GitDiffOverlay({
  review,
  status,
  onClose,
  onCopy,
  onRefresh,
  columns = 80,
  viewportRows = 24,
}: GitDiffOverlayProps) {
  const locale = useCliLocale()
  const t = useCliTranslations("cliUiDiff")
  const theme = useTheme()
  const screenReader = useScreenReader()
  const [scope, setScope] = React.useState<GitDiffScope>(review.baseRef ? "branch" : "all")
  const listRef = React.useRef<DOMElement | null>(null)
  const [query, setQuery] = React.useState("")
  const [searchDraft, setSearchDraft] = React.useState<string | null>(null)
  const [selectedPath, setSelectedPath] = React.useState<string | null>(null)
  const [focus, setFocus] = React.useState<"files" | "patch">("files")
  const scopes: GitDiffScope[] = [
    "all",
    "staged",
    "unstaged",
    "untracked",
    ...(review.baseRef ? ["branch" as const] : []),
  ]
  const scopedFiles = review.files.filter((file) => gitDiffFileBody(file, scope).trim())
  const files = scopedFiles.filter((file) =>
    file.path.toLocaleLowerCase().includes(query.toLocaleLowerCase())
  )
  const index = Math.max(
    0,
    files.findIndex((entry) => entry.path === selectedPath)
  )
  const selectIndex = (next: number) => setSelectedPath(files[next]?.path ?? null)
  const file = files[index]
  const wide = columns >= 110 && !screenReader
  const width = Math.max(5, columns - 1)
  const listWidth = wide ? Math.min(38, Math.floor(width / 3)) : width
  const listRows = Math.max(1, viewportRows - 6)
  const start = Math.floor(index / listRows) * listRows
  const scopeLabel = t(scope, { ref: review.baseRef ?? "" })

  const handleMouse = usePanelClick({
    boxRef: listRef,
    headerRows: 1,
    borderRows: screenReader ? 0 : 1,
    hasAboveMore: false,
    visibleCount: Math.min(listRows, files.length - start),
    onPick: (offset) => {
      selectIndex(start + offset)
      setFocus(wide ? "files" : "patch")
    },
    onWheel: (dir) =>
      selectIndex(Math.max(0, Math.min(files.length - 1, index + (dir === "up" ? -1 : 1)))),
  })
  const statsByPath = React.useMemo(
    () => new Map(review.files.map((entry) => [entry.path, gitDiffFileStats(entry, scope)])),
    [review, scope]
  )
  const stats = file ? statsByPath.get(file.path) : undefined

  useCriticalInput(
    (input, key) => {
      if (handleMouse(input)) return
      if (searchDraft !== null) {
        if (key.escape) return setSearchDraft(null)
        if (key.return) {
          setQuery(searchDraft.trim())
          setSelectedPath(null)
          setSearchDraft(null)
          return
        }
        if (key.backspace || key.delete) return setSearchDraft((value) => value?.slice(0, -1) ?? "")
        if (input && !key.ctrl && !key.meta && !key.tab)
          setSearchDraft((value) => (value ?? "") + input)
        return
      }
      if (key.ctrl && input === "r") return onRefresh?.()
      if (focus === "files" && input === "/") return setSearchDraft(query)
      if (focus === "files" && key.escape && query) {
        setQuery("")
        setSelectedPath(null)
        return
      }
      if (key.ctrl && (key.leftArrow || key.rightArrow)) {
        const next =
          (scopes.indexOf(scope) + (key.rightArrow ? 1 : -1) + scopes.length) % scopes.length
        setScope(scopes[next])
        setSelectedPath(null)
        return
      }
      if (key.tab) return setFocus(focus === "files" && file ? "patch" : "files")
      if (key.escape || input === "q") return onClose()
      if (input === "r") return onRefresh?.()
      if (key.downArrow) selectIndex(Math.max(0, Math.min(index + 1, files.length - 1)))
      if (key.upArrow) selectIndex(Math.max(0, index - 1))
      if (key.pageDown) selectIndex(Math.max(0, Math.min(files.length - 1, index + listRows)))
      if (key.pageUp) selectIndex(Math.max(0, index - listRows))
      if (input === "g") setSelectedPath(null)
      if (input === "G") selectIndex(Math.max(0, files.length - 1))
      if (key.return && file) setFocus("patch")
    },
    {
      shouldHandle: (input, key) => {
        const mouse = parseMouseEvent(input)
        if (mouse && wide) {
          const pos = absoluteTopLeft(listRef.current)
          const point = mouseEventPosition(input)
          return Boolean(
            pos &&
            point &&
            point.col - 1 >= pos.left &&
            point.col - 1 < pos.left + listWidth &&
            point.row - 1 >= pos.top &&
            point.row - 1 < pos.top + viewportRows - 2
          )
        }
        return (
          searchDraft !== null ||
          focus === "files" ||
          key.tab ||
          Boolean(key.ctrl && (key.leftArrow || key.rightArrow || input === "r"))
        )
      },
    }
  )

  const showList = wide || focus === "files" || !file
  const showPatch = Boolean(file) && (wide || focus === "patch")
  return (
    <Box flexDirection="column" width={width} height={viewportRows} overflow="hidden">
      <Text bold color={theme.accent} wrap="truncate-end">
        {t("title")} · {scopeLabel} ·{" "}
        {status && !review.files.length
          ? t(status)
          : t(files.length === 1 ? "file" : "files", { count: files.length })}
        {stats
          ? ` · ${t("selectedFile")} +${stats.additions} −${stats.deletions} · ${file?.untrackedDirectory ? t("directory") : stats.binary ? t("binary") : t("hunks", { count: stats.hunks })}`
          : ""}
      </Text>
      <Box flexDirection={wide ? "row" : "column"} height={Math.max(1, viewportRows - 2)}>
        {showList && (
          <Box
            ref={listRef}
            flexDirection="column"
            width={listWidth}
            borderStyle={screenReader ? undefined : "round"}
            borderColor={focus === "files" ? theme.accent : theme.border}
            overflow="hidden"
          >
            <Text color={theme.muted} wrap="truncate-end">
              {searchDraft !== null
                ? t("pathSearch", { query: searchDraft })
                : t("pathFilter", { query: query || t("allPaths") })}
            </Text>
            {files.length === 0 && (
              <Text color={theme.muted}>
                {t(status && !review.files.length ? status : query ? "noMatches" : "empty")}
              </Text>
            )}
            {files.slice(start, start + listRows).map((entry, offset) => (
              <Text
                key={entry.path}
                color={start + offset === index ? theme.accent : undefined}
                wrap="truncate-middle"
              >
                {start + offset === index ? "› " : "  "}
                {displayPath(entry.path)}
                {entry.untrackedDirectory
                  ? `  ${t("directory")}`
                  : `  +${statsByPath.get(entry.path)!.additions} −${statsByPath.get(entry.path)!.deletions}`}
              </Text>
            ))}
            {(!status || review.files.length > 0) && (
              <Text color={theme.muted} wrap="truncate-end">
                {t("pages", {
                  page: files.length ? Math.floor(index / listRows) + 1 : 0,
                  pages: Math.ceil(files.length / listRows),
                  shown: files.length,
                  total: scopedFiles.length,
                })}
              </Text>
            )}
          </Box>
        )}
        {showPatch && file && (
          <DocumentViewer
            key={`${scope}:${file.path}`}
            title={displayPath(file.path)}
            body={gitDiffFileBody(file, scope, locale)}
            format="text"
            lang="diff"
            columns={wide ? width - listWidth : width}
            viewportRows={Math.max(1, viewportRows - 2)}
            onCopy={onCopy}
            onClose={() => setFocus("files")}
          />
        )}
      </Box>
      <Text color={theme.muted} wrap="truncate-end">
        {t(focus === "files" ? "navigation" : "detailNavigation")}
        {focus === "files" && onRefresh ? ` · ${t("refresh")}` : ""}
      </Text>
    </Box>
  )
}
