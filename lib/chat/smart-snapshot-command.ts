"use client"

import { registerCommand } from "@/lib/plugin/commands/registry"
import { useChatStore } from "@/stores/chat"
import { SMART_SNAPSHOT_COMMAND_ID } from "./smart-snapshot"

interface SnapshotComposer {
  textarea: () => HTMLTextAreaElement | null
  capture: () => Promise<void>
  title: string
}

const composers = new Set<SnapshotComposer>()
let disposeCommand: (() => void) | undefined
let lastFocused: { composer: SnapshotComposer; activeSessionId: string | null } | undefined

function composerRoot(composer: SnapshotComposer): HTMLElement | null {
  const textarea = composer.textarea()
  if (!textarea?.isConnected || textarea.disabled) return null
  const root = textarea.closest<HTMLElement>("[data-composer-root]") ?? textarea
  if (root.closest('[hidden], [inert], [aria-hidden="true"]')) return null
  for (let node: HTMLElement | null = textarea; node; node = node.parentElement) {
    const style = getComputedStyle(node)
    if (style.display === "none" || style.visibility === "hidden") return null
  }
  return root
}

function focusedComposer(target: EventTarget | null): SnapshotComposer | undefined {
  if (!(target instanceof Node)) return undefined
  return [...composers].reverse().find((composer) => composerRoot(composer)?.contains(target))
}

function rememberFocus(event: Event): void {
  const composer = focusedComposer(event.target)
  if (composer) {
    lastFocused = { composer, activeSessionId: useChatStore.getState().activeSessionId }
  }
}

async function captureInActiveComposer(): Promise<void> {
  const activeSessionId = useChatStore.getState().activeSessionId
  const focused = focusedComposer(document.activeElement)
  // Keep the last destination while a global shortcut runs from another app,
  // but stop using it when the user switches conversations elsewhere.
  const remembered =
    lastFocused?.activeSessionId === activeSessionId && composerRoot(lastFocused.composer)
      ? lastFocused.composer
      : undefined
  const active = [...composers].reverse().find((composer) => {
    const root = composerRoot(composer)
    return root && (root.dataset.composerSession ?? null) === activeSessionId
  })
  await (focused ?? remembered ?? active)?.capture()
}

/** Share one command across split panes, sidechats, and overlapping transitions. */
export function registerSmartSnapshotComposer(composer: SnapshotComposer): () => void {
  if (typeof document === "undefined") return () => {}
  const entry = { ...composer }
  composers.add(entry)
  if (!disposeCommand) {
    disposeCommand = registerCommand({
      id: SMART_SNAPSHOT_COMMAND_ID,
      pluginId: null,
      category: "Chat",
      title: composer.title,
      handler: captureInActiveComposer,
    })
    document.addEventListener("focusin", rememberFocus)
    document.addEventListener("pointerdown", rememberFocus, true)
  }
  return () => {
    composers.delete(entry)
    if (lastFocused?.composer === entry) lastFocused = undefined
    if (composers.size === 0) {
      disposeCommand?.()
      disposeCommand = undefined
      document.removeEventListener("focusin", rememberFocus)
      document.removeEventListener("pointerdown", rememberFocus, true)
    }
  }
}
