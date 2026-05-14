/**
 * @jest-environment jsdom
 */

import {
  PluginWorkflowIntegration,
  getPluginWorkflowIntegration,
  resetPluginWorkflowIntegration,
  usePluginWorkflowIntegration,
} from "./workflow-integration"
import { usePluginStore } from "@/stores/plugin"
import type { PluginMessage } from "@/types/plugin"

// Mock dependencies
const mockHooksManager = {
  dispatchStreamStart: jest.fn(),
  dispatchStreamChunk: jest.fn(),
  dispatchStreamEnd: jest.fn(),
  dispatchChatError: jest.fn(),
  dispatchTokenUsage: jest.fn(),
  dispatchWorkflowStart: jest.fn(),
  dispatchWorkflowStepComplete: jest.fn(),
  dispatchWorkflowComplete: jest.fn(),
  dispatchWorkflowError: jest.fn(),
  dispatchExportTransform: jest.fn().mockResolvedValue("transformed"),
  dispatchExportStart: jest.fn().mockResolvedValue(undefined),
  dispatchExportComplete: jest.fn(),
  dispatchRAGContextRetrieved: jest.fn(),
  dispatchDocumentsIndexed: jest.fn(),
  dispatchVectorSearch: jest.fn(),
  dispatchShortcut: jest.fn().mockResolvedValue(false),
}

jest.mock("../messaging/hooks-system", () => ({
  getPluginEventHooks: jest.fn(() => mockHooksManager),
}))

jest.mock("@/stores/plugin", () => ({
  usePluginStore: {
    getState: jest.fn(() => ({
      plugins: {
        "test-plugin": {
          status: "enabled",
          hooks: {
            onChatRequest: jest.fn().mockResolvedValue([{ role: "user", content: "transformed" }]),
          },
        },
        "disabled-plugin": {
          status: "disabled",
          hooks: { onChatRequest: jest.fn() },
        },
      },
    })),
  },
}))

jest.mock("../core/logger", () => ({
  loggers: {
    manager: {
      error: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
    },
    workflow: {
      error: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    },
  },
}))

describe("PluginWorkflowIntegration", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    resetPluginWorkflowIntegration()
  })

  describe("getPluginWorkflowIntegration", () => {
    it("should return singleton instance", () => {
      const instance1 = getPluginWorkflowIntegration()
      const instance2 = getPluginWorkflowIntegration()
      expect(instance1).toBe(instance2)
    })
  })

  describe("resetPluginWorkflowIntegration", () => {
    it("should reset the singleton", () => {
      const instance1 = getPluginWorkflowIntegration()
      resetPluginWorkflowIntegration()
      const instance2 = getPluginWorkflowIntegration()
      expect(instance1).not.toBe(instance2)
    })
  })

  describe("usePluginWorkflowIntegration", () => {
    it("should return integration instance", () => {
      const instance = usePluginWorkflowIntegration()
      expect(instance).toBeInstanceOf(PluginWorkflowIntegration)
    })
  })

  describe("PluginWorkflowIntegration class", () => {
    let integration: PluginWorkflowIntegration

    beforeEach(() => {
      integration = getPluginWorkflowIntegration()
    })

    describe("processMessageBeforeSend", () => {
      it("should process messages through enabled plugins", async () => {
        const message: PluginMessage = { id: "msg-1", role: "user", content: "test" }
        const result = await integration.processMessageBeforeSend(message, "gpt-4")

        expect(result).toEqual([{ role: "user", content: "transformed" }])
      })

      it("should skip disabled plugins", async () => {
        ;(usePluginStore.getState as jest.Mock).mockReturnValueOnce({
          plugins: {
            "disabled-plugin": {
              status: "disabled",
              hooks: { onChatRequest: jest.fn() },
            },
          },
        })

        const message: PluginMessage = { id: "msg-2", role: "user", content: "test" }
        const result = await integration.processMessageBeforeSend(message, "gpt-4")

        expect(result).toEqual([message])
      })
    })

    describe("notifyStreamStart", () => {
      it("should dispatch stream start event", () => {
        integration.notifyStreamStart("session-1")
        expect(mockHooksManager.dispatchStreamStart).toHaveBeenCalledWith("session-1")
      })
    })

    describe("notifyStreamChunk", () => {
      it("should dispatch stream chunk event", () => {
        integration.notifyStreamChunk("session-1", "chunk", "full content")
        expect(mockHooksManager.dispatchStreamChunk).toHaveBeenCalledWith(
          "session-1",
          "chunk",
          "full content"
        )
      })
    })

    describe("notifyStreamEnd", () => {
      it("should dispatch stream end event", () => {
        integration.notifyStreamEnd("session-1", "final content")
        expect(mockHooksManager.dispatchStreamEnd).toHaveBeenCalledWith(
          "session-1",
          "final content"
        )
      })
    })

    describe("notifyChatError", () => {
      it("should dispatch chat error event", () => {
        const error = new Error("Test error")
        integration.notifyChatError("session-1", error)
        expect(mockHooksManager.dispatchChatError).toHaveBeenCalledWith("session-1", error)
      })
    })

    describe("notifyTokenUsage", () => {
      it("should dispatch token usage event", () => {
        const usage = { prompt: 100, completion: 200, total: 300 }
        integration.notifyTokenUsage("session-1", usage)
        expect(mockHooksManager.dispatchTokenUsage).toHaveBeenCalledWith("session-1", usage)
      })
    })

    describe("notifyWorkflowStart", () => {
      it("should dispatch workflow start event", () => {
        integration.notifyWorkflowStart("workflow-1", "Test Workflow")
        expect(mockHooksManager.dispatchWorkflowStart).toHaveBeenCalledWith(
          "workflow-1",
          "Test Workflow"
        )
      })
    })

    describe("notifyWorkflowStepComplete", () => {
      it("should dispatch workflow step complete event", () => {
        integration.notifyWorkflowStepComplete("workflow-1", 0, { result: "success" })
        expect(mockHooksManager.dispatchWorkflowStepComplete).toHaveBeenCalledWith(
          "workflow-1",
          0,
          { result: "success" }
        )
      })
    })

    describe("notifyWorkflowComplete", () => {
      it("should dispatch workflow complete event", () => {
        integration.notifyWorkflowComplete("workflow-1", true, { data: "result" })
        expect(mockHooksManager.dispatchWorkflowComplete).toHaveBeenCalledWith("workflow-1", true, {
          data: "result",
        })
      })
    })

    describe("notifyWorkflowError", () => {
      it("should dispatch workflow error event", () => {
        const error = new Error("Workflow failed")
        integration.notifyWorkflowError("workflow-1", error)
        expect(mockHooksManager.dispatchWorkflowError).toHaveBeenCalledWith("workflow-1", error)
      })
    })

    describe("processExportContent", () => {
      it("should process export content", async () => {
        const result = await integration.processExportContent("content", "markdown")
        expect(result).toBe("transformed")
        expect(mockHooksManager.dispatchExportTransform).toHaveBeenCalledWith("content", "markdown")
      })
    })

    describe("notifyExportStart", () => {
      it("should notify export start", async () => {
        await integration.notifyExportStart("session-1", "markdown")
        expect(mockHooksManager.dispatchExportStart).toHaveBeenCalledWith("session-1", "markdown")
      })
    })

    describe("notifyExportComplete", () => {
      it("should notify export complete", () => {
        integration.notifyExportComplete("session-1", "markdown", true)
        expect(mockHooksManager.dispatchExportComplete).toHaveBeenCalledWith(
          "session-1",
          "markdown",
          true
        )
      })
    })

    describe("notifyRAGContextRetrieved", () => {
      it("should notify RAG context retrieved", () => {
        const sources = [{ id: "1", content: "test", score: 0.9 }]
        integration.notifyRAGContextRetrieved("session-1", sources)
        expect(mockHooksManager.dispatchRAGContextRetrieved).toHaveBeenCalledWith(
          "session-1",
          sources
        )
      })
    })

    describe("notifyDocumentsIndexed", () => {
      it("should notify documents indexed", () => {
        integration.notifyDocumentsIndexed("collection-1", 10)
        expect(mockHooksManager.dispatchDocumentsIndexed).toHaveBeenCalledWith("collection-1", 10)
      })
    })

    describe("notifyVectorSearch", () => {
      it("should notify vector search", () => {
        integration.notifyVectorSearch("collection-1", "query", 5)
        expect(mockHooksManager.dispatchVectorSearch).toHaveBeenCalledWith(
          "collection-1",
          "query",
          5
        )
      })
    })

    describe("handleShortcut", () => {
      it("should handle shortcut", async () => {
        const result = await integration.handleShortcut("Ctrl+S")
        expect(result).toBe(false)
        expect(mockHooksManager.dispatchShortcut).toHaveBeenCalledWith("Ctrl+S")
      })
    })
  })
})
