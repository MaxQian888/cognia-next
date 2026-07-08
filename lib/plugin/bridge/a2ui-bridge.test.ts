/** @jest-environment jsdom */
/**
 * Tests for Plugin A2UI Bridge
 */

import React from "react"
import { render, screen } from "@testing-library/react"
import { PluginA2UIBridge } from "./a2ui-bridge"
import type { PluginA2UIComponent, A2UITemplateDef } from "@/types/plugin"
import type { PluginRegistry } from "../core/registry"
import type { PluginLifecycleHooks } from "../messaging/hooks-system"

const mockRegisterCatalogComponent = jest.fn()
const mockUnregisterCatalogComponent = jest.fn()

const mockCreateSurface = jest.fn()
const mockProcessMessage = jest.fn()
const mockA2UISubscribe = jest.fn()

const mockRegisterPluginComponent = jest.fn()
const mockUnregisterPluginComponent = jest.fn()

let actionHandler:
  | ((action: {
      surfaceId: string
      action: string
      componentId: string
      data?: Record<string, unknown>
    }) => void)
  | null = null
let dataChangeHandler:
  | ((change: { surfaceId: string; path: string; value: unknown }) => void)
  | null = null

jest.mock("@/lib/a2ui/catalog", () => ({
  registerComponent: (...args: unknown[]) => mockRegisterCatalogComponent(...args),
  unregisterComponent: (...args: unknown[]) => mockUnregisterCatalogComponent(...args),
}))

jest.mock("@/stores/a2ui", () => ({
  useA2UIStore: {
    getState: () => ({
      createSurface: mockCreateSurface,
      processMessage: mockProcessMessage,
    }),
    subscribe: (...args: unknown[]) => mockA2UISubscribe(...args),
  },
}))

jest.mock("@/stores/plugin-runtime", () => ({
  usePluginStore: {
    getState: () => ({
      registerPluginComponent: mockRegisterPluginComponent,
      unregisterPluginComponent: mockUnregisterPluginComponent,
    }),
  },
}))

jest.mock("@/lib/a2ui/events", () => ({
  globalEventEmitter: {
    onAction: (handler: typeof actionHandler) => {
      actionHandler = handler
      return () => {
        actionHandler = null
      }
    },
    onDataChange: (handler: typeof dataChangeHandler) => {
      dataChangeHandler = handler
      return () => {
        dataChangeHandler = null
      }
    },
  },
}))

const mockManagerLoggerError = jest.fn()
jest.mock("../core/logger", () => ({
  loggers: {
    manager: {
      warn: jest.fn(),
      error: (...args: unknown[]) => mockManagerLoggerError(...args),
    },
  },
}))

function createMockRegistry(): jest.Mocked<PluginRegistry> {
  return {
    registerComponent: jest.fn(),
    unregisterComponent: jest.fn(),
    registerTemplate: jest.fn(),
    unregisterTemplate: jest.fn(),
    getTemplate: jest.fn(),
    getAllTemplates: jest.fn().mockReturnValue([]),
    getTemplatesByCategory: jest.fn().mockReturnValue([]),
  } as unknown as jest.Mocked<PluginRegistry>
}

function createMockHooksManager(): jest.Mocked<PluginLifecycleHooks> {
  return {
    dispatchOnA2UISurfaceCreate: jest.fn(),
    dispatchOnA2UISurfaceDestroy: jest.fn(),
    dispatchOnA2UIAction: jest.fn().mockResolvedValue(undefined),
    dispatchOnA2UIDataChange: jest.fn(),
  } as unknown as jest.Mocked<PluginLifecycleHooks>
}

function createMockComponent(): PluginA2UIComponent {
  return {
    type: "PluginWidget",
    pluginId: "plugin-a",
    metadata: {
      type: "PluginWidget",
      name: "Plugin Widget",
      description: "Widget from plugin",
    },
    component: () => React.createElement("div", { "data-testid": "plugin-component" }),
  }
}

describe("PluginA2UIBridge", () => {
  let registry: jest.Mocked<PluginRegistry>
  let hooksManager: jest.Mocked<PluginLifecycleHooks>
  let bridge: PluginA2UIBridge

  beforeEach(() => {
    jest.clearAllMocks()
    actionHandler = null
    dataChangeHandler = null

    mockA2UISubscribe.mockImplementation(() => jest.fn())

    registry = createMockRegistry()
    hooksManager = createMockHooksManager()

    bridge = new PluginA2UIBridge({
      registry,
      hooksManager,
      contextResolver: () => undefined,
    })
  })

  it("registers plugin component into catalog and registry", () => {
    const component = createMockComponent()

    bridge.registerComponent("plugin-a", component)

    expect(mockRegisterCatalogComponent).toHaveBeenCalledWith(
      "PluginWidget",
      expect.any(Function),
      expect.objectContaining({ description: "Widget from plugin" })
    )
    expect(registry.registerComponent).toHaveBeenCalledWith("plugin-a", component)
    expect(mockRegisterPluginComponent).toHaveBeenCalledWith("plugin-a", component)
  })

  it("renders explicit fallback when plugin context is missing", () => {
    const component = createMockComponent()
    bridge.registerComponent("plugin-a", component)

    const wrappedComponent = mockRegisterCatalogComponent.mock.calls[0]?.[1] as React.ComponentType<
      Record<string, unknown>
    >
    render(
      React.createElement(wrappedComponent, {
        component: { id: "c1", component: "PluginWidget" },
        surfaceId: "surface-1",
        dataModel: {},
        onAction: jest.fn(),
        onDataChange: jest.fn(),
        renderChild: jest.fn(),
      })
    )

    expect(screen.getByRole("alert")).toHaveTextContent("plugin context is missing")
    expect(mockManagerLoggerError).toHaveBeenCalled()
  })

  it("forwards action and data-change events to plugin hooks", async () => {
    actionHandler?.({
      surfaceId: "surface-1",
      action: "submit",
      componentId: "btn-1",
      data: { ok: true },
    })
    dataChangeHandler?.({
      surfaceId: "surface-1",
      path: "/form/name",
      value: "Alice",
    })

    await Promise.resolve()

    expect(hooksManager.dispatchOnA2UIAction).toHaveBeenCalledWith({
      surfaceId: "surface-1",
      action: "submit",
      componentId: "btn-1",
      data: { ok: true },
    })
    expect(hooksManager.dispatchOnA2UIDataChange).toHaveBeenCalledWith({
      surfaceId: "surface-1",
      path: "/form/name",
      value: "Alice",
    })
  })

  it("creates template surface and emits surfaceReady", () => {
    const template: A2UITemplateDef = {
      id: "invoice",
      name: "Invoice",
      surfaceType: "panel",
      components: [{ id: "root", component: "Text", text: "hello" }],
      dataModel: { currency: "USD" },
    }
    registry.getTemplate.mockReturnValue(template)

    bridge.createSurfaceFromTemplate("plugin-a:invoice", "surface-invoice", { amount: 123 })

    expect(mockCreateSurface).toHaveBeenCalledWith("surface-invoice", "panel", { title: "Invoice" })
    expect(mockProcessMessage).toHaveBeenNthCalledWith(1, {
      type: "updateComponents",
      surfaceId: "surface-invoice",
      components: template.components,
    })
    expect(mockProcessMessage).toHaveBeenNthCalledWith(2, {
      type: "dataModelUpdate",
      surfaceId: "surface-invoice",
      data: { currency: "USD", amount: 123 },
      merge: false,
    })
    expect(mockProcessMessage).toHaveBeenNthCalledWith(3, {
      type: "surfaceReady",
      surfaceId: "surface-invoice",
    })
  })

  it("cleans up plugin templates by prefixed template id", () => {
    const template: A2UITemplateDef = {
      id: "analytics",
      name: "Analytics",
      surfaceType: "inline",
      components: [],
    }
    bridge.registerTemplate("plugin-a", template)
    bridge.unregisterPluginTemplates("plugin-a")

    expect(registry.registerTemplate).toHaveBeenCalledWith("plugin-a", template)
    expect(registry.unregisterTemplate).toHaveBeenCalledWith("plugin-a:analytics")
  })
})
