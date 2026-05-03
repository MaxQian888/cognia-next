"use client"

/**
 * Model manager — placeholder.
 *
 * Cognia's `model-manager.tsx` drives the native model-download flow
 * (catalog browsing, download progress, ETA, file size, source/category
 * indexing). cognia-next deferred the Tauri side per the provider port
 * plan; this placeholder keeps callers compiling until the native
 * commands ship.
 */

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"

export function ModelManager() {
  return (
    <div className="p-4">
      <Alert>
        <AlertTitle>Native model downloads deferred</AlertTitle>
        <AlertDescription className="text-xs">
          Browsing and downloading model files (gguf etc.) requires the native model-download Tauri
          commands, which are on the cognia-next roadmap but not in this release. For Ollama and LM
          Studio you can still pull models from the local provider tab using their own UI.
        </AlertDescription>
      </Alert>
    </div>
  )
}

export default ModelManager
