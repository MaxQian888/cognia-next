"use client"

import { memo } from "react"
import { cn } from "@/lib/utils"
import { Kbd, KbdGroup } from "@/components/ui/kbd"

interface KbdInlineProps {
  children: React.ReactNode
  className?: string
  variant?: "default" | "outline" | "ghost"
}

export const KbdInline = memo(function KbdInline({
  children,
  className,
  variant = "default",
}: KbdInlineProps) {
  const variantClasses = {
    default: "border border-border shadow-sm shadow-muted-foreground/20",
    outline: "border border-border bg-transparent",
    ghost: "bg-muted/50 border-transparent",
  }

  return <Kbd className={cn(variantClasses[variant], className)}>{children}</Kbd>
})

interface KeyboardShortcutProps {
  keys: string[]
  className?: string
  separator?: React.ReactNode
  variant?: "default" | "outline" | "ghost"
}

export const KeyboardShortcut = memo(function KeyboardShortcut({
  keys,
  className,
  separator = "+",
  variant = "default",
}: KeyboardShortcutProps) {
  return (
    <KbdGroup className={className}>
      {keys.map((key, index) => (
        <span key={index} className="inline-flex items-center">
          {index > 0 && <span className="mx-0.5 text-muted-foreground text-xs">{separator}</span>}
          <KbdInline variant={variant}>{formatKey(key)}</KbdInline>
        </span>
      ))}
    </KbdGroup>
  )
})

function formatKey(key: string): string {
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent)

  const keyMap: Record<string, { mac: string; other: string }> = {
    cmd: { mac: "⌘", other: "Ctrl" },
    command: { mac: "⌘", other: "Ctrl" },
    ctrl: { mac: "⌃", other: "Ctrl" },
    control: { mac: "⌃", other: "Ctrl" },
    alt: { mac: "⌥", other: "Alt" },
    option: { mac: "⌥", other: "Alt" },
    shift: { mac: "⇧", other: "Shift" },
    enter: { mac: "↵", other: "Enter" },
    return: { mac: "↵", other: "Enter" },
    tab: { mac: "⇥", other: "Tab" },
    backspace: { mac: "⌫", other: "Backspace" },
    delete: { mac: "⌦", other: "Del" },
    escape: { mac: "⎋", other: "Esc" },
    esc: { mac: "⎋", other: "Esc" },
    space: { mac: "␣", other: "Space" },
    up: { mac: "↑", other: "↑" },
    down: { mac: "↓", other: "↓" },
    left: { mac: "←", other: "←" },
    right: { mac: "→", other: "→" },
    pageup: { mac: "⇞", other: "PgUp" },
    pagedown: { mac: "⇟", other: "PgDn" },
    home: { mac: "↖", other: "Home" },
    end: { mac: "↘", other: "End" },
    capslock: { mac: "⇪", other: "CapsLock" },
  }

  const lowerKey = key.toLowerCase()
  if (keyMap[lowerKey]) {
    return isMac ? keyMap[lowerKey].mac : keyMap[lowerKey].other
  }

  if (key.length === 1) {
    return key.toUpperCase()
  }

  return key
}

export function parseShortcut(shortcut: string): string[] {
  return shortcut.split(/[+\s]+/).filter(Boolean)
}

export default KbdInline
