"use client"

const WINDOW_SCOPE_KEY = "cognia-context-workbench-window-scope-v1"

interface TauriWindowMetadata {
  __TAURI_INTERNALS__?: {
    metadata?: {
      currentWebview?: { label?: string }
      currentWindow?: { label?: string }
    }
  }
}

export function getContextWorkbenchWindowScope(): string {
  if (typeof window === "undefined") return "server"
  const metadata = (window as unknown as TauriWindowMetadata).__TAURI_INTERNALS__?.metadata
  const tauriLabel = metadata?.currentWebview?.label ?? metadata?.currentWindow?.label
  if (tauriLabel) return `tauri:${tauriLabel}`

  const existing = window.sessionStorage.getItem(WINDOW_SCOPE_KEY)
  if (existing) return existing
  const created = `browser:${crypto.randomUUID()}`
  window.sessionStorage.setItem(WINDOW_SCOPE_KEY, created)
  return created
}

export function useContextWorkbenchInstanceId(hostKey: string): string {
  return `${getContextWorkbenchWindowScope()}:${hostKey}`
}
