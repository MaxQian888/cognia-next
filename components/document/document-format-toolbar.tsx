/**
 * Cognia compat shim — markdown format toolbar. The full Cognia
 * toolbar exposes ~12 formatting actions (bold, italic, code, lists,
 * etc.) bound to the active editor. cognia-next ports the same
 * surface using the FORMAT_ACTION_MAP from `@/lib/canvas/constants`
 * so user-facing parity is preserved.
 */

"use client"

import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import {
  Bold,
  Italic,
  Underline,
  Strikethrough,
  Code,
  Quote,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Link as LinkIcon,
  Minus,
} from "lucide-react"

export type FormatAction =
  | "bold"
  | "italic"
  | "underline"
  | "strikethrough"
  | "codeBlock"
  | "quote"
  | "heading1"
  | "heading2"
  | "heading3"
  | "bulletList"
  | "numberedList"
  | "link"
  | "horizontalRule"

interface DocumentFormatToolbarProps {
  onAction: (action: FormatAction) => void
  className?: string
}

const ACTIONS: Array<{ action: FormatAction; icon: React.ReactNode; label: string }> = [
  { action: "bold", icon: <Bold className="h-3.5 w-3.5" />, label: "Bold" },
  { action: "italic", icon: <Italic className="h-3.5 w-3.5" />, label: "Italic" },
  { action: "underline", icon: <Underline className="h-3.5 w-3.5" />, label: "Underline" },
  {
    action: "strikethrough",
    icon: <Strikethrough className="h-3.5 w-3.5" />,
    label: "Strikethrough",
  },
  { action: "codeBlock", icon: <Code className="h-3.5 w-3.5" />, label: "Code block" },
  { action: "quote", icon: <Quote className="h-3.5 w-3.5" />, label: "Quote" },
  { action: "heading1", icon: <Heading1 className="h-3.5 w-3.5" />, label: "Heading 1" },
  { action: "heading2", icon: <Heading2 className="h-3.5 w-3.5" />, label: "Heading 2" },
  { action: "heading3", icon: <Heading3 className="h-3.5 w-3.5" />, label: "Heading 3" },
  { action: "bulletList", icon: <List className="h-3.5 w-3.5" />, label: "Bullet list" },
  {
    action: "numberedList",
    icon: <ListOrdered className="h-3.5 w-3.5" />,
    label: "Numbered list",
  },
  { action: "link", icon: <LinkIcon className="h-3.5 w-3.5" />, label: "Link" },
  {
    action: "horizontalRule",
    icon: <Minus className="h-3.5 w-3.5" />,
    label: "Horizontal rule",
  },
]

export function DocumentFormatToolbar({ onAction, className }: DocumentFormatToolbarProps) {
  return (
    <div className={cn("flex items-center gap-0.5 rounded-md border bg-muted/20 p-1", className)}>
      {ACTIONS.map(({ action, icon, label }) => (
        <Tooltip key={action} delayDuration={300}>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={() => onAction(action)}
              aria-label={label}
            >
              {icon}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{label}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  )
}
