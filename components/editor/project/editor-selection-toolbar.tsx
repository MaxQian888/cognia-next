"use client"

// The capsule that floats over a text selection in the project editor: bring
// the selected lines into the conversation, ask the file's AI panel about
// them, or comment on them. The same three things the right-click menu and the
// context workbench offer — one gesture away, where the selection is.
//
// It sits in the editor's own box (absolutely positioned from Monaco's
// scrolled-visible coordinates) so it scrolls, resizes and splits with the
// editor group it belongs to. Hidden while a mouse drag is still extending the
// selection, while the editor text is not focused, and when neither end of the
// selection is on screen.

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { MessageSquareIcon, MessageSquarePlusIcon, SparklesIcon } from "lucide-react"

import { Button } from "@/components/ui/button"

interface EditorPosition {
  lineNumber: number
  column: number
}

interface Disposable {
  dispose(): void
}

/** The slice of a Monaco code editor the toolbar reads. */
export interface SelectionToolbarEditor {
  getSelection(): {
    isEmpty(): boolean
    getStartPosition(): EditorPosition
    getEndPosition(): EditorPosition
  } | null
  getScrolledVisiblePosition(
    position: EditorPosition
  ): { top: number; left: number; height: number } | null
  getLayoutInfo(): { width: number; height: number }
  hasTextFocus(): boolean
  onDidChangeCursorSelection(listener: () => void): Disposable
  onDidScrollChange(listener: () => void): Disposable
  onDidLayoutChange(listener: () => void): Disposable
  onDidFocusEditorText(listener: () => void): Disposable
  onDidBlurEditorText(listener: () => void): Disposable
  onMouseDown(listener: () => void): Disposable
  onMouseUp(listener: () => void): Disposable
}

export interface EditorSelectionActions {
  /** Stage the selection as a chat context chip. */
  onAddToChat: () => void
  /** Open the file's AI panel on the selection. Omitted: no button. */
  onAskAi?: () => void
  /** Open the file's comments panel anchored to the selection. Omitted: no button. */
  onComment?: () => void
}

/** Gap between the toolbar and the selected line. */
const GAP_PX = 6
/** The capsule's height (`h-8` buttons plus its padding). */
const TOOLBAR_HEIGHT_PX = 36
/** Room kept free for the capsule at the right edge (vertical scrollbar + minimap side). */
const RIGHT_RESERVE_PX = 260
const EDGE_PX = 4

export interface ToolbarPlacement {
  top: number
  left: number
}

/**
 * Where the toolbar goes for the editor's current state, or null when it must
 * not show. Above the selection's first line when that line is on screen, else
 * below its last line, else nowhere — a toolbar pinned to a selection the user
 * cannot see would float over unrelated code.
 */
export function placeSelectionToolbar(editor: SelectionToolbarEditor): ToolbarPlacement | null {
  if (!editor.hasTextFocus()) return null
  const selection = editor.getSelection()
  if (!selection || selection.isEmpty()) return null
  const { width, height } = editor.getLayoutInfo()
  const clampLeft = (left: number) =>
    Math.max(EDGE_PX, Math.min(left, Math.max(EDGE_PX, width - RIGHT_RESERVE_PX)))
  const visible = (top: number) => top >= 0 && top <= height

  const start = editor.getScrolledVisiblePosition(selection.getStartPosition())
  if (start && visible(start.top) && start.top - GAP_PX - TOOLBAR_HEIGHT_PX >= 0) {
    return { top: start.top - GAP_PX - TOOLBAR_HEIGHT_PX, left: clampLeft(start.left) }
  }
  const end = editor.getScrolledVisiblePosition(selection.getEndPosition())
  if (end && visible(end.top)) {
    const below = end.top + end.height + GAP_PX
    // At the very bottom there is no room below: overlap the last line instead
    // of leaving the box.
    return {
      top: Math.min(below, Math.max(EDGE_PX, height - TOOLBAR_HEIGHT_PX - EDGE_PX)),
      left: clampLeft(end.left),
    }
  }
  if (start && visible(start.top)) {
    // First line visible but hugging the top edge: drop below it.
    return { top: start.top + start.height + GAP_PX, left: clampLeft(start.left) }
  }
  return null
}

export function EditorSelectionToolbar({
  editor,
  actions,
}: {
  editor: SelectionToolbarEditor
  actions: EditorSelectionActions
}) {
  const t = useTranslations("projectEditor.selectionToolbar")
  const [placement, setPlacement] = useState<ToolbarPlacement | null>(null)

  useEffect(() => {
    let dragging = false
    const update = () => setPlacement(dragging ? null : placeSelectionToolbar(editor))
    const subscriptions = [
      editor.onDidChangeCursorSelection(update),
      editor.onDidScrollChange(update),
      editor.onDidLayoutChange(update),
      editor.onDidFocusEditorText(update),
      editor.onDidBlurEditorText(update),
      editor.onMouseDown(() => {
        dragging = true
        update()
      }),
      editor.onMouseUp(() => {
        dragging = false
        update()
      }),
    ]
    // A drag that ends outside the editor never reaches its own mouseup.
    const release = () => {
      if (!dragging) return
      dragging = false
      update()
    }
    window.addEventListener("mouseup", release)
    update()
    return () => {
      for (const subscription of subscriptions) subscription.dispose()
      window.removeEventListener("mouseup", release)
    }
  }, [editor])

  // Keep the editor focused (and its selection alive) through the click.
  const keepFocus = useCallback((event: React.MouseEvent) => event.preventDefault(), [])

  if (!placement) return null
  return (
    <div
      role="toolbar"
      aria-label={t("aria")}
      data-testid="editor-selection-toolbar"
      className="absolute z-20 flex items-center gap-0.5 rounded-lg border bg-popover p-0.5 text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95 duration-100"
      style={{ top: placement.top, left: placement.left }}
      onMouseDown={keepFocus}
    >
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-8 gap-1.5 px-2 text-xs"
        data-testid="editor-selection-add-to-chat"
        onClick={actions.onAddToChat}
      >
        <MessageSquarePlusIcon className="size-3.5" />
        {t("addToChat")}
      </Button>
      {actions.onAskAi ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-8 gap-1.5 px-2 text-xs"
          data-testid="editor-selection-ask-ai"
          onClick={actions.onAskAi}
        >
          <SparklesIcon className="size-3.5" />
          {t("askAi")}
        </Button>
      ) : null}
      {actions.onComment ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-8 gap-1.5 px-2 text-xs"
          data-testid="editor-selection-comment"
          onClick={actions.onComment}
        >
          <MessageSquareIcon className="size-3.5" />
          {t("comment")}
        </Button>
      ) : null}
    </div>
  )
}
