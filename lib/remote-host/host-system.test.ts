/** @jest-environment jsdom */
import type { RemoteHostTarget } from "@/lib/remote-host/target-transport"
import { closeManagementChannel } from "@/lib/remote-host/management-channel"

import { hostOsLabel, readHostSystemDetails } from "./host-system"

const HOST = "host-system-test"
const call = jest.fn()

function deps() {
  return {
    channel: {
      openTarget: async () =>
        ({
          host: { id: HOST, label: "Cognia云主机" },
          transport: { call, subscribe: jest.fn(() => () => undefined) },
          close: jest.fn(),
        }) as unknown as RemoteHostTarget,
    },
  }
}

beforeEach(() => call.mockReset())
afterEach(() => closeManagementChannel(HOST))

it("reads the Host's system details over its management channel", async () => {
  call.mockResolvedValue({ os: "Ubuntu", osVersion: "24.04", cpuCount: 4 })
  await expect(readHostSystemDetails(HOST, deps())).resolves.toMatchObject({ os: "Ubuntu" })
  expect(call).toHaveBeenCalledWith("perf_system_details")
})

it("names the operating system on one line", () => {
  expect(hostOsLabel({ os: "Ubuntu", osVersion: "24.04.1 LTS" })).toBe("Ubuntu 24.04.1 LTS")
  expect(hostOsLabel({ os: "linux", osVersion: null })).toBe("linux")
  expect(hostOsLabel({ os: " ", osVersion: "" })).toBeNull()
})
