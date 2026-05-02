/**
 * Plugin Analytics Tests
 */

import {
  pluginAnalyticsStore,
  pluginLearningEngine,
  pluginHealthMonitor,
  type PluginUsageEvent,
} from "./analytics"

// Mock Tauri invoke
jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn().mockResolvedValue(null),
}))

describe("PluginAnalyticsStore", () => {
  beforeEach(async () => {
    await pluginAnalyticsStore.clear()
  })

  describe("recordEvent", () => {
    it("should record a usage event", async () => {
      const event: Omit<PluginUsageEvent, "timestamp"> = {
        pluginId: "test-plugin",
        eventType: "tool_call",
        toolName: "test_tool",
        success: true,
        duration: 100,
      }

      await pluginAnalyticsStore.recordEvent({ ...event, timestamp: Date.now() })

      const stats = pluginAnalyticsStore.getStats("test-plugin")
      expect(stats).toBeDefined()
      expect(stats?.totalCalls).toBe(1)
      expect(stats?.successfulCalls).toBe(1)
    })

    it("should track failed events", async () => {
      await pluginAnalyticsStore.recordEvent({
        pluginId: "test-plugin",
        eventType: "tool_call",
        toolName: "test_tool",
        success: false,
        errorMessage: "Test error",
        timestamp: Date.now(),
      })

      const stats = pluginAnalyticsStore.getStats("test-plugin")
      expect(stats?.failedCalls).toBe(1)
      expect(stats?.errorHistory).toHaveLength(1)
    })

    it("should calculate average duration", async () => {
      await pluginAnalyticsStore.recordEvent({
        pluginId: "test-plugin",
        eventType: "tool_call",
        success: true,
        duration: 100,
        timestamp: Date.now(),
      })

      await pluginAnalyticsStore.recordEvent({
        pluginId: "test-plugin",
        eventType: "tool_call",
        success: true,
        duration: 200,
        timestamp: Date.now(),
      })

      const stats = pluginAnalyticsStore.getStats("test-plugin")
      expect(stats?.averageDuration).toBe(150)
    })

    it("should track tool usage", async () => {
      await pluginAnalyticsStore.recordEvent({
        pluginId: "test-plugin",
        eventType: "tool_call",
        toolName: "tool_a",
        success: true,
        timestamp: Date.now(),
      })

      await pluginAnalyticsStore.recordEvent({
        pluginId: "test-plugin",
        eventType: "tool_call",
        toolName: "tool_a",
        success: true,
        timestamp: Date.now(),
      })

      await pluginAnalyticsStore.recordEvent({
        pluginId: "test-plugin",
        eventType: "tool_call",
        toolName: "tool_b",
        success: true,
        timestamp: Date.now(),
      })

      const stats = pluginAnalyticsStore.getStats("test-plugin")
      expect(stats?.toolUsage["tool_a"]?.callCount).toBe(2)
      expect(stats?.toolUsage["tool_b"]?.callCount).toBe(1)
    })
  })

  describe("getRecentEvents", () => {
    it("should return recent events", async () => {
      for (let i = 0; i < 5; i++) {
        await pluginAnalyticsStore.recordEvent({
          pluginId: "test-plugin",
          eventType: "tool_call",
          success: true,
          timestamp: Date.now() + i,
        })
      }

      const events = pluginAnalyticsStore.getRecentEvents("test-plugin")
      expect(events).toHaveLength(5)
    })

    it("should filter by plugin ID", async () => {
      await pluginAnalyticsStore.recordEvent({
        pluginId: "plugin-a",
        eventType: "tool_call",
        success: true,
        timestamp: Date.now(),
      })

      await pluginAnalyticsStore.recordEvent({
        pluginId: "plugin-b",
        eventType: "tool_call",
        success: true,
        timestamp: Date.now(),
      })

      const eventsA = pluginAnalyticsStore.getRecentEvents("plugin-a")
      const eventsB = pluginAnalyticsStore.getRecentEvents("plugin-b")

      expect(eventsA).toHaveLength(1)
      expect(eventsB).toHaveLength(1)
    })
  })
})

describe("PluginLearningEngine", () => {
  beforeEach(async () => {
    await pluginAnalyticsStore.clear()
  })

  describe("generateInsights", () => {
    it("should generate warning for high error rate", async () => {
      // Record 15 events, 8 failures (>50% error rate)
      for (let i = 0; i < 15; i++) {
        await pluginAnalyticsStore.recordEvent({
          pluginId: "error-prone-plugin",
          eventType: "tool_call",
          success: i < 7,
          timestamp: Date.now(),
        })
      }

      const insights = pluginLearningEngine.generateInsights()
      const errorInsight = insights.find(
        (i) => i.pluginId === "error-prone-plugin" && i.type === "warning"
      )

      expect(errorInsight).toBeDefined()
      expect(errorInsight?.title).toContain("Error Rate")
    })

    it("should generate achievement for high usage", async () => {
      // Record 101 successful events
      for (let i = 0; i < 101; i++) {
        await pluginAnalyticsStore.recordEvent({
          pluginId: "popular-plugin",
          eventType: "tool_call",
          success: true,
          timestamp: Date.now(),
        })
      }

      const insights = pluginLearningEngine.generateInsights()
      const achievement = insights.find(
        (i) => i.pluginId === "popular-plugin" && i.type === "achievement"
      )

      expect(achievement).toBeDefined()
      expect(achievement?.title).toContain("Power User")
    })
  })

  describe("generateRecommendations", () => {
    it("should recommend plugins based on capability usage", async () => {
      // Record tool usage to establish pattern
      for (let i = 0; i < 20; i++) {
        await pluginAnalyticsStore.recordEvent({
          pluginId: "existing-plugin",
          eventType: "tool_call",
          toolName: "data_tool",
          success: true,
          timestamp: Date.now(),
        })
      }

      const recommendations = pluginLearningEngine.generateRecommendations(
        ["existing-plugin"],
        [
          { id: "new-tool-plugin", capabilities: ["tools"], description: "More data tools" },
          { id: "component-plugin", capabilities: ["components"], description: "UI components" },
        ]
      )

      expect(recommendations.length).toBeGreaterThan(0)
    })
  })
})

describe("PluginHealthMonitor", () => {
  beforeEach(async () => {
    await pluginAnalyticsStore.clear()
  })

  describe("checkHealth", () => {
    it("should return healthy status for new plugin", () => {
      const health = pluginHealthMonitor.checkHealth("new-plugin")

      expect(health.status).toBe("healthy")
      expect(health.score).toBe(100)
      expect(health.issues).toHaveLength(0)
    })

    it("should detect high error rate", async () => {
      // Record 10 events, 6 failures (60% error rate)
      for (let i = 0; i < 10; i++) {
        await pluginAnalyticsStore.recordEvent({
          pluginId: "unhealthy-plugin",
          eventType: "tool_call",
          success: i < 4,
          timestamp: Date.now(),
        })
      }

      const health = pluginHealthMonitor.checkHealth("unhealthy-plugin")

      // Status can be 'unhealthy' or 'degraded' depending on thresholds
      expect(["unhealthy", "degraded"]).toContain(health.status)
      expect(health.score).toBeLessThan(100)
      expect(health.issues.some((i) => i.code === "HIGH_ERROR_RATE")).toBe(true)
    })

    it("should detect slow response time", async () => {
      // Record events with high duration
      for (let i = 0; i < 5; i++) {
        await pluginAnalyticsStore.recordEvent({
          pluginId: "slow-plugin",
          eventType: "tool_call",
          success: true,
          duration: 15000, // 15 seconds
          timestamp: Date.now(),
        })
      }

      const health = pluginHealthMonitor.checkHealth("slow-plugin")

      expect(health.issues.some((i) => i.code === "SLOW_RESPONSE")).toBe(true)
    })
  })
})
