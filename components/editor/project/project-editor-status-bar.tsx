"use client"

// Status bar at the foot of the editor pane — the project editor's answer to
// VS Code's bottom strip. Left: git branch and the live diagnostics summary
// (clicking jumps to the next problem). Right: cursor position and selection
// size, language id, line ending, file size, and the dirty marker — each an
// answer to "what am I editing and what state is it in" that the tab strip
// alone can't carry.

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  AlertCircleIcon,
  AlertTriangleIcon,
  CheckIcon,
  CircleDotIcon,
  GitBranchIcon,
  InfoIcon,
  Trash2Icon,
} from "lucide-react"
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useMonacoMarkers, type EditorLike, type MonacoLike } from "@/hooks/use-monaco-markers"
import type { TextSelectionCoordinates } from "@/types/context-workbench"
import { cn } from "@/lib/utils"
import type { OpenFile } from "./use-project-editor"

interface Props {
  file: OpenFile
  /** Live cursor position, or null until the editor reports one. */
  cursor: { lineNumber: number; column: number } | null
  /** Current selection (used for the "N selected" readout). */
  selection?: TextSelectionCoordinates
  /** Monaco handles once mounted — feeds the diagnostics summary. */
  diagnostics: { monaco: MonacoLike; editor: EditorLike } | null
  /** Git branch for the file's root, when it lives in a repo. */
  branch?: string | null
  /**
   * Click handler for the sync-state chips (conflict / deleted-on-disk).
   * Without it they render inert.
   */
  onSyncAction?: () => void
  /**
   * Indentation menu model — present when a live model can take
   * `updateOptions`. Makes the indentation item a dropdown like VS Code's
   * "Select Indentation" (mode, size, and convert-in-place).
   */
  indent?: {
    insertSpaces: boolean
    tabSize: number
    onChange(opts: { insertSpaces: boolean; tabSize: number }): void
    onConvert(to: "spaces" | "tabs"): void
  } | null
  /** EOL toggle — present when the focused model can switch line endings. */
  onToggleEol?: (() => void) | null
  /** Click handler for the diagnostics counts — VS Code opens the Problems panel. */
  onProblemsClick: () => void
  /**
   * Language picker model — present once the Monaco language registry has
   * been captured. Renders VS Code's "Select Language Mode" popover.
   */
  language?: {
    value: string
    options: { id: string; label: string }[]
    onChange(id: string): void
  } | null
  density?: "compact" | "touch"
}

/** The workspace readers only ever decode UTF-8, so that is what is shown. */
const ENCODING = "UTF-8"

function formatBytes(size: number | undefined): string | null {
  if (size === undefined) return null
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

export function ProjectEditorStatusBar({
  file,
  cursor,
  selection,
  diagnostics,
  branch,
  onSyncAction,
  indent,
  onToggleEol,
  onProblemsClick,
  language,
  density = "compact",
}: Props) {
  const t = useTranslations("projectEditor")
  const { summary } = useMonacoMarkers(diagnostics?.monaco, diagnostics?.editor)
  const [langOpen, setLangOpen] = useState(false)

  const dirty = file.draftContent !== file.savedContent
  const eol = useMemo(
    () => (file.draftContent.includes("\r\n") ? "CRLF" : "LF"),
    [file.draftContent]
  )
  const size = formatBytes(file.sizeBytes)
  const selectedChars =
    selection && selection.kind === "text" ? Math.max(0, selection.end - selection.start) : 0

  // The bar spans the editor column of a workbench that lives in the chat's
  // right dock, so it is often 300–450px wide. Items fold away by priority as
  // that column narrows, VS Code-style — passive readouts first (size,
  // encoding, branch, selection count), then the line-ending and indentation
  // controls, whose actions the command palette also carries. Problems, the
  // cursor, the language picker and the sync/dirty markers always stay; the
  // markers shed their words for their icons.
  return (
    <div
      className={cn(
        "@container/status flex h-6 min-w-0 shrink-0 items-center gap-1 overflow-hidden border-t bg-muted/30 px-2 text-[11px] text-muted-foreground select-none",
        density === "touch" && "h-8 text-xs"
      )}
      data-testid="project-editor-status-bar"
      role="contentinfo"
      aria-label={t("statusBar.aria")}
    >
      {branch ? (
        <span
          className="hidden min-w-0 items-center gap-1 @md/status:flex"
          title={branch}
          data-testid="status-branch"
        >
          <GitBranchIcon className="size-3 shrink-0" />
          <span className="max-w-32 truncate">{branch}</span>
        </span>
      ) : null}
      {diagnostics && summary.errors + summary.warnings + summary.infos > 0 ? (
        <button
          type="button"
          className="flex shrink-0 items-center gap-2 rounded-sm px-1 hover:bg-accent"
          onClick={onProblemsClick}
          title={t("statusBar.problemsTooltip")}
          data-testid="status-problems"
        >
          {summary.errors > 0 ? (
            <span className="flex items-center gap-0.5 text-red-500">
              <AlertCircleIcon className="size-3" />
              {summary.errors}
            </span>
          ) : null}
          {summary.warnings > 0 ? (
            <span className="flex items-center gap-0.5 text-amber-500">
              <AlertTriangleIcon className="size-3" />
              {summary.warnings}
            </span>
          ) : null}
          {summary.infos > 0 ? (
            <span className="flex items-center gap-0.5">
              <InfoIcon className="size-3" />
              {summary.infos}
            </span>
          ) : null}
        </button>
      ) : null}

      <span className="ml-auto flex shrink-0 items-center gap-2.5 whitespace-nowrap tabular-nums">
        {cursor ? (
          <span data-testid="status-cursor">
            {t("statusBar.position", { line: cursor.lineNumber, col: cursor.column })}
            {selectedChars > 0 ? (
              <span className="ml-1 hidden text-muted-foreground/70 @md/status:inline">
                {t("statusBar.selected", { count: selectedChars })}
              </span>
            ) : null}
          </span>
        ) : null}
        {size ? (
          <span className="hidden @xl/status:inline" data-testid="status-size">
            {size}
          </span>
        ) : null}
        {indent ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="hidden rounded-sm px-1 hover:bg-accent @xs/status:inline"
                title={t("statusBar.changeIndentation")}
                data-testid="status-indentation"
              >
                {indent.insertSpaces
                  ? t("statusBar.indentSpaces", { size: indent.tabSize })
                  : t("statusBar.indentTabs", { size: indent.tabSize })}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" data-testid="status-indentation-menu">
              <DropdownMenuCheckboxItem
                checked={indent.insertSpaces}
                onCheckedChange={() =>
                  indent.onChange({ insertSpaces: true, tabSize: indent.tabSize })
                }
              >
                {t("statusBar.indentUsingSpaces")}
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={!indent.insertSpaces}
                onCheckedChange={() =>
                  indent.onChange({ insertSpaces: false, tabSize: indent.tabSize })
                }
              >
                {t("statusBar.indentUsingTabs")}
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              <DropdownMenuRadioGroup
                value={String(indent.tabSize)}
                onValueChange={(v) =>
                  indent.onChange({ insertSpaces: indent.insertSpaces, tabSize: Number(v) })
                }
              >
                {[2, 4, 8].map((size) => (
                  <DropdownMenuRadioItem key={size} value={String(size)}>
                    {t("statusBar.tabSize", { size })}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => indent.onConvert("spaces")}>
                {t("statusBar.convertToSpaces")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => indent.onConvert("tabs")}>
                {t("statusBar.convertToTabs")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        <span className="hidden @lg/status:inline" data-testid="status-encoding">
          {ENCODING}
        </span>
        {onToggleEol ? (
          <button
            type="button"
            className="hidden rounded-sm px-1 hover:bg-accent @sm/status:inline"
            onClick={onToggleEol}
            title={t("statusBar.changeEol")}
            data-testid="status-eol"
          >
            {eol}
          </button>
        ) : (
          <span className="hidden @sm/status:inline" data-testid="status-eol">
            {eol}
          </span>
        )}
        {language ? (
          <Popover open={langOpen} onOpenChange={setLangOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="rounded-sm px-1 font-mono hover:bg-accent"
                title={t("statusBar.changeLanguage")}
                data-testid="status-language"
              >
                {language.value}
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-56 p-0" data-testid="status-language-picker">
              <Command>
                <CommandInput placeholder={t("statusBar.languagePlaceholder")} />
                <CommandList className="max-h-60">
                  <CommandEmpty>{t("statusBar.noLanguage")}</CommandEmpty>
                  {language.options.map((option) => (
                    <CommandItem
                      key={option.id}
                      value={`${option.label} ${option.id}`}
                      onSelect={() => {
                        language.onChange(option.id)
                        setLangOpen(false)
                      }}
                      data-testid={`status-language-option-${option.id}`}
                    >
                      <CheckIcon
                        className={cn(
                          "size-3.5",
                          option.id === language.value ? "opacity-100" : "opacity-0"
                        )}
                      />
                      {option.label}
                    </CommandItem>
                  ))}
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        ) : (
          <span className="font-mono" data-testid="status-language">
            {file.monacoLanguage}
          </span>
        )}
        {file.deletedOnDisk ? (
          <button
            type="button"
            className={cn(
              "flex items-center gap-0.5 text-destructive",
              onSyncAction && "rounded-sm px-1 hover:bg-accent"
            )}
            onClick={onSyncAction}
            disabled={!onSyncAction}
            title={t("statusBar.deletedOnDisk")}
            aria-label={t("statusBar.deletedOnDisk")}
            data-testid="status-deleted"
          >
            <Trash2Icon className="size-3" />
            <span className="hidden @md/status:inline">{t("statusBar.deletedOnDisk")}</span>
          </button>
        ) : file.externallyChanged ? (
          <button
            type="button"
            className={cn(
              "flex items-center gap-0.5 text-amber-500",
              onSyncAction && "rounded-sm px-1 hover:bg-accent"
            )}
            onClick={onSyncAction}
            disabled={!onSyncAction}
            title={t("statusBar.externallyChanged")}
            aria-label={t("statusBar.externallyChanged")}
            data-testid="status-external"
          >
            <AlertTriangleIcon className="size-3" />
            <span className="hidden @md/status:inline">{t("statusBar.externallyChanged")}</span>
          </button>
        ) : null}
        {dirty ? (
          <span
            className="flex items-center gap-0.5 text-amber-500"
            title={t("statusBar.unsaved")}
            role="img"
            aria-label={t("statusBar.unsaved")}
            data-testid="status-dirty"
          >
            <CircleDotIcon className="size-3" />
            <span className="hidden @md/status:inline" aria-hidden>
              {t("statusBar.unsaved")}
            </span>
          </span>
        ) : null}
      </span>
    </div>
  )
}
