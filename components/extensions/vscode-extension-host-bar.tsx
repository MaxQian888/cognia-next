"use client"

/**
 * The extension rail: where VS Code extensions' webview panels and views
 * appear, mounted beside the main content by the desktop shell.
 *
 * Renders nothing until an extension shows a webview, so the rail takes no
 * room in a window without one. Terminals are not here: extensions' terminals
 * are tabs in the terminal dock.
 */

import { cn } from "@/lib/utils"

import { useVscodeWebviews, VscodeExtensionPanel } from "./vscode-extension-panel"

export interface VscodeExtensionHostBarProps {
  className?: string
}

export function VscodeExtensionHostBar({ className }: VscodeExtensionHostBarProps = {}) {
  const { webviews } = useVscodeWebviews()
  if (webviews.length === 0) return null
  return (
    <div
      data-testid="vscode-extension-host-bar"
      className={cn("flex h-full min-h-0 w-full flex-col", className)}
    >
      <VscodeExtensionPanel />
    </div>
  )
}
