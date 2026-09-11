import React from "react"
import { Box, Text, type DOMElement } from "ink"
import { absoluteTopLeft } from "../../input/element-position"
import { parseMouseEvent, mouseEventPosition } from "../../input/mouse"
import { useCriticalInput } from "../../input/input-router"
import { useCliLocale, useCliTranslations } from "../../i18n"
import { useScreenReader } from "../../render/context"
import { useTheme } from "../../theme/context"
import { readSkillFile } from "../../runtime/view-controller"
import type { DocumentFormat } from "../../state/types"
import { DocumentViewer } from "./DocumentViewer"

type SkillFile = { relPath: string; absPath: string }
type FileBody = { body: string; format: DocumentFormat; lang?: string }
type TreeEntry = { path: string; name: string; depth: number; file?: SkillFile }

export interface SkillFilesOverlayProps {
  title: string
  root: string
  files: SkillFile[]
  columns?: number
  viewportRows?: number
  onClose: () => void
  readFile?: (
    root: string,
    path: string,
    locale?: import("../../i18n").CliLocale
  ) => Promise<FileBody>
}

/** Keep the directory browser mounted while the existing pager owns file content. */
export function SkillFilesOverlay({
  title,
  root,
  files,
  columns = 80,
  viewportRows = 24,
  onClose,
  readFile = readSkillFile,
}: SkillFilesOverlayProps) {
  const locale = useCliLocale()
  const t = useCliTranslations("cliUiCommands")
  const theme = useTheme()
  const bodyRef = React.useRef<DOMElement | null>(null)
  const screenReader = useScreenReader()
  const initial = files.find((file) => file.relPath === "SKILL.md") ?? files[0]
  const [selected, setSelected] = React.useState(initial?.relPath ?? "")
  const [opened, setOpened] = React.useState(initial)
  const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set())
  const [focus, setFocus] = React.useState<"tree" | "preview">("tree")
  const [loaded, setLoaded] = React.useState<{
    file: SkillFile
    root: string
    document: FileBody | null
    error: string | null
  } | null>(null)
  const currentLoad = loaded?.file === opened && loaded?.root === root ? loaded : null
  const document = currentLoad?.document ?? null
  const error = currentLoad?.error ?? null
  const entries = React.useMemo(() => {
    const nodes = new Map<string, TreeEntry>()
    for (const file of files) {
      const parts = file.relPath.split("/")
      parts.forEach((name, depth) => {
        const path = parts.slice(0, depth + 1).join("/")
        nodes.set(path, { path, name, depth, file: depth === parts.length - 1 ? file : undefined })
      })
    }
    const children = (parent: string): TreeEntry[] =>
      [...nodes.values()]
        .filter((node) => node.path.slice(0, Math.max(0, node.path.lastIndexOf("/"))) === parent)
        .sort(
          (a, b) =>
            Number(Boolean(a.file)) - Number(Boolean(b.file)) || a.name.localeCompare(b.name)
        )
        .flatMap((node) => [
          node,
          ...(!node.file && expanded.has(node.path) ? children(node.path) : []),
        ])
    return children("")
  }, [files, expanded])
  const index = Math.max(
    0,
    entries.findIndex((entry) => entry.path === selected)
  )
  const current = entries[index]
  const width = Math.max(5, columns - 1)
  const wide = columns >= 100 && !screenReader
  const treeWidth = wide ? Math.min(38, Math.floor(width / 3)) : width
  const bodyRows = Math.max(1, viewportRows - 2)
  const listRows = Math.max(1, bodyRows - (screenReader ? 0 : 2) - 1)
  const start = Math.max(0, index - listRows + 1)

  React.useEffect(() => {
    let active = true
    if (opened) {
      void readFile(root, opened.absPath, locale).then(
        (value) => {
          if (active) setLoaded({ file: opened, root, document: value, error: null })
        },
        (reason: unknown) => {
          if (active)
            setLoaded({
              file: opened,
              root,
              document: null,
              error: reason instanceof Error ? reason.message : String(reason),
            })
        }
      )
    }
    return () => {
      active = false
    }
  }, [root, opened, readFile, locale])

  const toggle = (path: string, open: boolean) =>
    setExpanded((previous) => {
      const next = new Set(previous)
      if (open) next.add(path)
      else next.delete(path)
      return next
    })
  const mousePane = (input: string): "tree" | "preview" | null => {
    const mouse = mouseEventPosition(input)
    const pos = absoluteTopLeft(bodyRef.current)
    if (!mouse || !pos) return null
    const x = mouse.col - 1 - pos.left
    const y = mouse.row - 1 - pos.top
    if (x < 0 || x >= width || y < 0 || y >= bodyRows) return null
    return wide ? (x < treeWidth ? "tree" : "preview") : focus
  }

  useCriticalInput(
    (input, key) => {
      const mouse = parseMouseEvent(input)
      if (mouse) {
        const pane = mousePane(input)
        if (mouse.kind === "click" && pane) {
          setFocus(pane)
          if (pane === "tree") {
            const pos = absoluteTopLeft(bodyRef.current)!
            const row = mouse.row - 1 - pos.top - (screenReader ? 0 : 1) - 1
            const entry = row >= 0 && row < listRows ? entries[start + row] : undefined
            if (entry) {
              setSelected(entry.path)
              if (entry.file) setOpened({ ...entry.file })
              else toggle(entry.path, !expanded.has(entry.path))
            }
          }
        } else if (mouse.kind === "wheel" && pane === "tree" && entries.length) {
          setSelected(
            entries[
              Math.max(0, Math.min(entries.length - 1, index + (mouse.dir === "up" ? -3 : 3)))
            ].path
          )
        }
        return
      }
      if (key.tab) return setFocus(focus === "tree" && opened ? "preview" : "tree")
      if (key.escape || input === "q") {
        if (focus === "preview") setFocus("tree")
        else onClose()
        return
      }
      if (focus === "preview" || !current) return
      if (key.upArrow) setSelected(entries[Math.max(0, index - 1)].path)
      if (key.downArrow) setSelected(entries[Math.min(entries.length - 1, index + 1)].path)
      if (key.pageUp) setSelected(entries[Math.max(0, index - listRows)].path)
      if (key.pageDown) setSelected(entries[Math.min(entries.length - 1, index + listRows)].path)
      if (input === "g") setSelected(entries[0].path)
      if (input === "G") setSelected(entries[entries.length - 1].path)
      if (key.leftArrow) {
        if (!current.file && expanded.has(current.path)) toggle(current.path, false)
        else if (current.depth) setSelected(current.path.slice(0, current.path.lastIndexOf("/")))
      }
      if (key.rightArrow && !current.file) {
        if (expanded.has(current.path) && entries[index + 1]?.depth > current.depth)
          setSelected(entries[index + 1].path)
        else toggle(current.path, true)
      }
      if (key.return) {
        if (current.file) {
          setOpened({ ...current.file })
          setFocus("preview")
        } else toggle(current.path, !expanded.has(current.path))
      }
    },
    {
      shouldHandle: (input, key) => {
        const mouse = parseMouseEvent(input)
        if (mouse) return !(mouse.kind === "wheel" && mousePane(input) === "preview" && document)
        return focus === "tree" || key.tab || !document
      },
    }
  )

  return (
    <Box flexDirection="column" width={width} height={viewportRows} overflow="hidden">
      <Text bold color={theme.accent} wrap="truncate-end">
        {title}
      </Text>
      <Box ref={bodyRef} flexDirection={wide ? "row" : "column"} height={bodyRows}>
        {(wide || focus === "tree") && (
          <Box
            flexDirection="column"
            width={treeWidth}
            height={bodyRows}
            borderStyle={screenReader ? undefined : "round"}
            borderColor={focus === "tree" ? theme.accent : theme.borderSubtle}
            paddingX={screenReader ? 0 : 1}
            overflow="hidden"
          >
            <Text bold color={focus === "tree" ? theme.accent : theme.muted} wrap="truncate-end">
              {t("skillFiles.files", { count: files.length })}
            </Text>
            {entries.length === 0 && <Text>{t("skillFiles.empty")}</Text>}
            {entries.slice(start, start + listRows).map((entry) => (
              <Text
                key={entry.path}
                color={entry.path === current?.path ? theme.accent : undefined}
                bold={entry.path === opened?.relPath || !entry.file}
                inverse={entry.path === current?.path && focus === "tree"}
                wrap="truncate-middle"
              >
                {entry.path === current?.path ? "› " : "  "}
                {(screenReader ? "  " : "│ ").repeat(entry.depth)}
                {entry.file ? "" : expanded.has(entry.path) ? "▾ " : "▸ "}
                {entry.name}
                {entry.file ? "" : "/"}
              </Text>
            ))}
          </Box>
        )}
        {(wide || focus === "preview") &&
          opened &&
          (document ? (
            <DocumentViewer
              key={opened.absPath}
              focused={focus === "preview"}
              title={opened.relPath}
              {...document}
              columns={wide ? width - treeWidth : width}
              viewportRows={bodyRows}
              onClose={() => setFocus("tree")}
            />
          ) : (
            <Box
              width={wide ? width - treeWidth : width}
              height={bodyRows}
              flexDirection="column"
              overflow="hidden"
            >
              <Text wrap="truncate-end">{opened.relPath}</Text>
              <Text color={error ? theme.danger : theme.muted} wrap="truncate-end">
                {error ? t("skillFiles.readError", { error }) : t("skillFiles.loading")}
              </Text>
            </Box>
          ))}
      </Box>
      <Text color={theme.muted} wrap="truncate-end">
        {t(focus === "tree" ? "skillFiles.navigation" : "skillFiles.previewNavigation")}
      </Text>
    </Box>
  )
}
