jest.mock("./runtime", () => ({ notify: jest.fn().mockResolvedValue("center-id") }))
jest.mock("./action-registry", () => ({ registerNotificationCommand: jest.fn(() => () => {}) }))
jest.mock("@/lib/plugin/api/notification-api", () => ({ setToastDispatcher: jest.fn() }))

import { notify } from "./runtime"
import { registerNotificationCommand } from "./action-registry"
import { setToastDispatcher } from "@/lib/plugin/api/notification-api"
import { installPluginNotificationBridge, __resetPluginBridgeForTesting } from "./plugin-bridge"

const mockNotify = notify as jest.Mock
const mockRegister = registerNotificationCommand as jest.Mock
const mockSetDispatcher = setToastDispatcher as jest.Mock

type Dispatcher = (o: {
  id: string
  pluginId: string
  title: string
  message: string
  type: "info" | "success" | "warning" | "error"
  duration?: number
  action?: { label: string; onClick: () => void }
}) => void

function lastDispatcher(): Dispatcher {
  return mockSetDispatcher.mock.calls.at(-1)![0] as Dispatcher
}

beforeEach(() => {
  jest.clearAllMocks()
  __resetPluginBridgeForTesting()
})

it("installs a dispatcher that routes plugin notifications to the center", () => {
  installPluginNotificationBridge()
  lastDispatcher()({
    id: "plugin-x:abc",
    pluginId: "plugin-x",
    title: "Hi",
    message: "Body",
    type: "warning",
    duration: 5000,
  })
  expect(mockNotify).toHaveBeenCalledWith(
    expect.objectContaining({
      source: "plugin",
      pluginId: "plugin-x",
      level: "warning",
      title: "Hi",
      body: "Body",
      dedupeKey: "plugin-x:abc",
      groupKey: "plugin-x",
    })
  )
})

it("registers the action closure as a serializable command", () => {
  installPluginNotificationBridge()
  const onClick = jest.fn()
  lastDispatcher()({
    id: "p:1",
    pluginId: "p",
    title: "T",
    message: "M",
    type: "info",
    action: { label: "Open", onClick },
  })
  expect(mockRegister).toHaveBeenCalledWith("plugin:p:1:0", expect.any(Function))
  const handler = mockRegister.mock.calls[0][1] as () => void
  handler()
  expect(onClick).toHaveBeenCalledTimes(1)
  expect(mockNotify.mock.calls[0][0].actions).toEqual([
    { id: "0", label: "Open", command: "plugin:p:1:0" },
  ])
})

it("is idempotent — installs the dispatcher only once", () => {
  installPluginNotificationBridge()
  installPluginNotificationBridge()
  expect(mockSetDispatcher).toHaveBeenCalledTimes(1)
})
