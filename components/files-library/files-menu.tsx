"use client"

/**
 * One menu model, two renderings (ADR-0223): an item's or folder's "⋯"
 * dropdown and its right-click context menu list the same entries in the same
 * order, because both are built from one `FilesMenuNode[]`. A change to what a
 * menu offers is made once, in the model.
 */

import type { ReactNode } from "react"
import type { LucideIcon } from "lucide-react"

import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu"
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu"

export type FilesMenuNode =
  | {
      type: "item"
      id: string
      label: string
      icon?: LucideIcon
      /** Drawn instead of `icon` (a color swatch). */
      leading?: ReactNode
      onSelect: () => void
      destructive?: boolean
      disabled?: boolean
      /** Shown dimmed after the label: a shortcut or why the entry is disabled. */
      hint?: string
      /** Marks the current choice in a picker submenu. */
      current?: boolean
    }
  | { type: "separator"; id: string }
  | { type: "submenu"; id: string; label: string; icon?: LucideIcon; children: FilesMenuNode[] }

export type FilesMenuKind = "dropdown" | "context"

const KITS = {
  dropdown: {
    Item: DropdownMenuItem,
    Separator: DropdownMenuSeparator,
    Shortcut: DropdownMenuShortcut,
    Sub: DropdownMenuSub,
    SubTrigger: DropdownMenuSubTrigger,
    SubContent: DropdownMenuSubContent,
  },
  context: {
    Item: ContextMenuItem,
    Separator: ContextMenuSeparator,
    Shortcut: ContextMenuShortcut,
    Sub: ContextMenuSub,
    SubTrigger: ContextMenuSubTrigger,
    SubContent: ContextMenuSubContent,
  },
} as const

export function FilesMenuNodes({
  nodes,
  kind,
  testIdPrefix,
}: {
  nodes: readonly FilesMenuNode[]
  kind: FilesMenuKind
  /** `data-testid` of each item is `${testIdPrefix}-${id}`. */
  testIdPrefix: string
}) {
  const kit = KITS[kind]
  return (
    <>
      {nodes.map((node) => {
        if (node.type === "separator") return <kit.Separator key={node.id} />
        if (node.type === "submenu") {
          const Icon = node.icon
          return (
            <kit.Sub key={node.id}>
              <kit.SubTrigger data-testid={`${testIdPrefix}-${node.id}`}>
                {Icon ? <Icon aria-hidden /> : null}
                {node.label}
              </kit.SubTrigger>
              <kit.SubContent>
                <FilesMenuNodes nodes={node.children} kind={kind} testIdPrefix={testIdPrefix} />
              </kit.SubContent>
            </kit.Sub>
          )
        }
        const Icon = node.icon
        return (
          <kit.Item
            key={node.id}
            variant={node.destructive ? "destructive" : "default"}
            disabled={node.disabled}
            aria-current={node.current ? "true" : undefined}
            onSelect={() => node.onSelect()}
            data-testid={`${testIdPrefix}-${node.id}`}
          >
            {node.leading ?? (Icon ? <Icon aria-hidden /> : null)}
            {node.label}
            {node.hint ? <kit.Shortcut>{node.hint}</kit.Shortcut> : null}
          </kit.Item>
        )
      })}
    </>
  )
}
