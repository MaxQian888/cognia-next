/**
 * Plugin Workflow Integration
 *
 * Integrates plugins with the agent and workflow systems.
 */

import { usePluginStore } from "@/stores/plugin-runtime"
import { getPluginEventHooks } from "../messaging/hooks-system"
import type { PluginMessage } from "@/types/plugin"
import type { PluginHooksAll } from "@/types/plugin/plugin-hooks"
import { loggers } from "../core/logger"

/**
 * Workflow integration for plugins
 *
 * Provides methods to integrate plugin hooks with the agent workflow system.
 */
export class PluginWorkflowIntegration {
  private hooksManager = getPluginEventHooks()

  /**
   * Process a message through plugin hooks before sending
   */
  async processMessageBeforeSend(message: PluginMessage, model: string): Promise<PluginMessage[]> {
    const store = usePluginStore.getState()
    let messages: PluginMessage[] = [message]

    // Apply onChatRequest hooks to transform messages
    for (const [pluginId, plugin] of Object.entries(store.plugins)) {
      if (plugin.status !== "enabled" || !plugin.hooks) continue

      const hooks = plugin.hooks as PluginHooksAll
      if (hooks.onChatRequest) {
        try {
          const transformed = await hooks.onChatRequest(messages, model)
          if (Array.isArray(transformed)) {
            messages = transformed
          }
        } catch (error) {
          loggers.manager.error(
            `[WorkflowIntegration] Error in onChatRequest for ${pluginId}:`,
            error
          )
        }
      }
    }

    return messages
  }

  /**
   * Notify plugins when streaming starts
   */
  notifyStreamStart(sessionId: string) {
    this.hooksManager.dispatchStreamStart(sessionId)
  }

  /**
   * Notify plugins of streaming chunks
   */
  notifyStreamChunk(sessionId: string, chunk: string, fullContent: string) {
    this.hooksManager.dispatchStreamChunk(sessionId, chunk, fullContent)
  }

  /**
   * Notify plugins when streaming ends
   */
  notifyStreamEnd(sessionId: string, finalContent: string) {
    this.hooksManager.dispatchStreamEnd(sessionId, finalContent)
  }

  /**
   * Notify plugins of chat errors
   */
  notifyChatError(sessionId: string, error: Error) {
    this.hooksManager.dispatchChatError(sessionId, error)
  }

  /**
   * Notify plugins of token usage
   */
  notifyTokenUsage(
    sessionId: string,
    usage: { prompt: number; completion: number; total: number }
  ) {
    this.hooksManager.dispatchTokenUsage(sessionId, usage)
  }

  /**
   * Notify plugins when a workflow starts
   */
  notifyWorkflowStart(workflowId: string, name: string) {
    this.hooksManager.dispatchWorkflowStart(workflowId, name)
  }

  /**
   * Notify plugins when a workflow step completes
   */
  notifyWorkflowStepComplete(workflowId: string, stepIndex: number, result: unknown) {
    this.hooksManager.dispatchWorkflowStepComplete(workflowId, stepIndex, result)
  }

  /**
   * Notify plugins when a workflow completes
   */
  notifyWorkflowComplete(workflowId: string, success: boolean, result?: unknown) {
    this.hooksManager.dispatchWorkflowComplete(workflowId, success, result)
  }

  /**
   * Notify plugins when a workflow errors
   */
  notifyWorkflowError(workflowId: string, error: Error) {
    this.hooksManager.dispatchWorkflowError(workflowId, error)
  }

  /**
   * Process export content through plugin hooks
   */
  async processExportContent(content: string, format: string): Promise<string> {
    return this.hooksManager.dispatchExportTransform(content, format)
  }

  /**
   * Notify plugins when export starts
   */
  async notifyExportStart(sessionId: string, format: string) {
    await this.hooksManager.dispatchExportStart(sessionId, format)
  }

  /**
   * Notify plugins when export completes
   */
  notifyExportComplete(sessionId: string, format: string, success: boolean) {
    this.hooksManager.dispatchExportComplete(sessionId, format, success)
  }

  /**
   * Notify plugins when RAG context is retrieved
   */
  notifyRAGContextRetrieved(
    sessionId: string,
    sources: { id: string; content: string; score: number }[]
  ) {
    this.hooksManager.dispatchRAGContextRetrieved(sessionId, sources)
  }

  /**
   * Notify plugins when documents are indexed
   */
  notifyDocumentsIndexed(collection: string, count: number) {
    this.hooksManager.dispatchDocumentsIndexed(collection, count)
  }

  /**
   * Notify plugins when a vector search is performed
   */
  notifyVectorSearch(collection: string, query: string, resultCount: number) {
    this.hooksManager.dispatchVectorSearch(collection, query, resultCount)
  }

  /**
   * Check if a shortcut is handled by any plugin
   */
  async handleShortcut(shortcut: string): Promise<boolean> {
    return this.hooksManager.dispatchShortcut(shortcut)
  }
}

// Singleton instance
let workflowIntegration: PluginWorkflowIntegration | null = null

/**
 * Get the workflow integration instance
 */
export function getPluginWorkflowIntegration(): PluginWorkflowIntegration {
  if (!workflowIntegration) {
    workflowIntegration = new PluginWorkflowIntegration()
  }
  return workflowIntegration
}

/**
 * Reset the workflow integration (for testing)
 */
export function resetPluginWorkflowIntegration() {
  workflowIntegration = null
}

/**
 * React hook to access workflow integration
 */
export function usePluginWorkflowIntegration(): PluginWorkflowIntegration {
  return getPluginWorkflowIntegration()
}
