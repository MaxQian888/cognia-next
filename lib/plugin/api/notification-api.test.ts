/**
 * Tests for Notification Center Plugin API
 */

import { createNotificationCenterAPI, dispatchNotificationAction } from "./notification-api"

describe("Notification Center API", () => {
  const testPluginId = "test-plugin"

  beforeEach(() => {
    // Dismiss all notifications before each test
    const api = createNotificationCenterAPI(testPluginId)
    api.dismissAll()
  })

  describe("createNotificationCenterAPI", () => {
    it("should create an API object with all expected methods", () => {
      const api = createNotificationCenterAPI(testPluginId)

      expect(api).toBeDefined()
      expect(typeof api.create).toBe("function")
      expect(typeof api.update).toBe("function")
      expect(typeof api.dismiss).toBe("function")
      expect(typeof api.dismissAll).toBe("function")
      expect(typeof api.getAll).toBe("function")
      expect(typeof api.onAction).toBe("function")
      expect(typeof api.createProgress).toBe("function")
    })
  })

  describe("create", () => {
    it("should create a notification and return ID", () => {
      const api = createNotificationCenterAPI(testPluginId)

      const id = api.create({
        title: "Test Notification",
        message: "This is a test",
      })

      expect(id).toBeDefined()
      expect(typeof id).toBe("string")
      expect(id.startsWith(`${testPluginId}:`)).toBe(true)
    })

    it("should create notification with custom type", () => {
      const api = createNotificationCenterAPI(testPluginId)

      api.create({
        title: "Warning",
        message: "This is a warning",
        type: "warning",
      })

      const all = api.getAll()
      expect(all.length).toBe(1)
      expect(all[0].type).toBe("warning")
    })

    it("should create notification with actions", () => {
      const api = createNotificationCenterAPI(testPluginId)

      api.create({
        title: "With Actions",
        message: "Has actions",
        actions: [
          { label: "Action 1", action: "action-1" },
          { label: "Action 2", action: "action-2" },
        ],
      })

      const all = api.getAll()
      expect(all[0].actions?.length).toBe(2)
    })

    it("should create persistent notification", () => {
      const api = createNotificationCenterAPI(testPluginId)

      api.create({
        title: "Persistent",
        message: "Will not auto-dismiss",
        persistent: true,
      })

      const all = api.getAll()
      expect(all[0].persistent).toBe(true)
    })

    it("should default to info type", () => {
      const api = createNotificationCenterAPI(testPluginId)

      api.create({
        title: "Default Type",
        message: "Should be info",
      })

      const all = api.getAll()
      expect(all[0].type).toBe("info")
    })
  })

  describe("update", () => {
    it("should update an existing notification", () => {
      const api = createNotificationCenterAPI(testPluginId)

      const id = api.create({
        title: "Original Title",
        message: "Original message",
      })

      api.update(id, {
        title: "Updated Title",
        message: "Updated message",
      })

      const all = api.getAll()
      const notification = all.find((n) => n.id === id)
      expect(notification?.title).toBe("Updated Title")
      expect(notification?.message).toBe("Updated message")
    })

    it("should update progress", () => {
      const api = createNotificationCenterAPI(testPluginId)

      const id = api.create({
        title: "Progress",
        message: "Loading...",
        progress: 0,
      })

      api.update(id, { progress: 50 })

      const all = api.getAll()
      const notification = all.find((n) => n.id === id)
      expect(notification?.progress).toBe(50)
    })

    it("should not throw for non-existent notification", () => {
      const api = createNotificationCenterAPI(testPluginId)

      expect(() => {
        api.update("non-existent-id", { title: "New Title" })
      }).not.toThrow()
    })
  })

  describe("dismiss", () => {
    it("should dismiss a notification by ID", () => {
      const api = createNotificationCenterAPI(testPluginId)

      const id = api.create({
        title: "To Dismiss",
        message: "Will be dismissed",
        persistent: true,
      })

      expect(api.getAll().length).toBe(1)

      api.dismiss(id)

      expect(api.getAll().length).toBe(0)
    })
  })

  describe("dismissAll", () => {
    it("should dismiss all notifications for this plugin", () => {
      const api = createNotificationCenterAPI(testPluginId)

      api.create({ title: "Notification 1", message: "Msg 1", persistent: true })
      api.create({ title: "Notification 2", message: "Msg 2", persistent: true })
      api.create({ title: "Notification 3", message: "Msg 3", persistent: true })

      expect(api.getAll().length).toBe(3)

      api.dismissAll()

      expect(api.getAll().length).toBe(0)
    })

    it("should not affect other plugins notifications", () => {
      const api1 = createNotificationCenterAPI("plugin-1")
      const api2 = createNotificationCenterAPI("plugin-2")

      api1.create({ title: "Plugin 1", message: "Msg", persistent: true })
      api2.create({ title: "Plugin 2", message: "Msg", persistent: true })

      api1.dismissAll()

      expect(api1.getAll().length).toBe(0)
      expect(api2.getAll().length).toBe(1)

      // Cleanup
      api2.dismissAll()
    })
  })

  describe("getAll", () => {
    it("should return only this plugins notifications", () => {
      const api1 = createNotificationCenterAPI("plugin-a")
      const api2 = createNotificationCenterAPI("plugin-b")

      api1.create({ title: "A1", message: "Msg", persistent: true })
      api1.create({ title: "A2", message: "Msg", persistent: true })
      api2.create({ title: "B1", message: "Msg", persistent: true })

      expect(api1.getAll().length).toBe(2)
      expect(api2.getAll().length).toBe(1)

      // Cleanup
      api1.dismissAll()
      api2.dismissAll()
    })
  })

  describe("onAction", () => {
    it("should register action handler", () => {
      const api = createNotificationCenterAPI(testPluginId)
      const handler = jest.fn()

      const unsubscribe = api.onAction(handler)

      expect(typeof unsubscribe).toBe("function")
    })

    it("should unsubscribe when cleanup is called", () => {
      const api = createNotificationCenterAPI(testPluginId)
      const handler = jest.fn()

      const unsubscribe = api.onAction(handler)
      unsubscribe()

      // Should not throw
      dispatchNotificationAction("some-id", "some-action")
      // Handler should not have been called after unsubscribe
    })
  })

  describe("createProgress", () => {
    it("should create a progress notification", () => {
      const api = createNotificationCenterAPI(testPluginId)

      const progress = api.createProgress("Uploading", "Starting upload...")

      expect(progress.id).toBeDefined()
      expect(typeof progress.update).toBe("function")
      expect(typeof progress.complete).toBe("function")
      expect(typeof progress.error).toBe("function")

      const all = api.getAll()
      expect(all.length).toBe(1)
      expect(all[0].progress).toBe(0)
      expect(all[0].persistent).toBe(true)
    })

    it("should update progress value", () => {
      const api = createNotificationCenterAPI(testPluginId)

      const progress = api.createProgress("Processing", "Working...")
      progress.update(50, "Halfway done")

      const all = api.getAll()
      expect(all[0].progress).toBe(50)
      expect(all[0].message).toBe("Halfway done")
    })

    it("should clamp progress between 0 and 100", () => {
      const api = createNotificationCenterAPI(testPluginId)

      const progress = api.createProgress("Test", "Testing...")

      progress.update(-10)
      let all = api.getAll()
      expect(all[0].progress).toBe(0)

      progress.update(150)
      all = api.getAll()
      expect(all[0].progress).toBe(100)
    })

    it("should complete progress notification", () => {
      jest.useFakeTimers()
      const api = createNotificationCenterAPI(testPluginId)

      const progress = api.createProgress("Download", "Downloading...")
      progress.complete("Download complete!")

      let all = api.getAll()
      expect(all[0].progress).toBe(100)
      expect(all[0].type).toBe("success")
      expect(all[0].message).toBe("Download complete!")

      // Should auto-dismiss after 3 seconds
      jest.advanceTimersByTime(3500)
      all = api.getAll()
      expect(all.length).toBe(0)

      jest.useRealTimers()
    })

    it("should handle error in progress notification", () => {
      jest.useFakeTimers()
      const api = createNotificationCenterAPI(testPluginId)

      const progress = api.createProgress("Upload", "Uploading...")
      progress.error("Upload failed!")

      let all = api.getAll()
      expect(all[0].type).toBe("error")
      expect(all[0].message).toBe("Upload failed!")
      expect(all[0].persistent).toBe(false)

      // Should auto-dismiss after 5 seconds
      jest.advanceTimersByTime(5500)
      all = api.getAll()
      expect(all.length).toBe(0)

      jest.useRealTimers()
    })
  })

  describe("dispatchNotificationAction", () => {
    it("should call all registered action handlers", () => {
      const api1 = createNotificationCenterAPI("plugin-x")
      const api2 = createNotificationCenterAPI("plugin-y")
      const handler1 = jest.fn()
      const handler2 = jest.fn()

      api1.onAction(handler1)
      api2.onAction(handler2)

      dispatchNotificationAction("notification-id", "test-action")

      expect(handler1).toHaveBeenCalledWith("notification-id", "test-action")
      expect(handler2).toHaveBeenCalledWith("notification-id", "test-action")

      // Cleanup
      api1.dismissAll()
      api2.dismissAll()
    })
  })
})
