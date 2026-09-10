jest.mock("./runner-host", () => ({ getHostRoomRunner: jest.fn() }))
jest.mock("./shell", () => ({ isCompanionShell: jest.fn(() => false) }))
jest.mock("@/lib/companion/room-send-client", () => ({ stopRoomTurn: jest.fn() }))

import { stopRoomMember } from "./stop-member"

it("stops the member on the host's runner, or asks the host from a companion", async () => {
  const stopMember = jest.fn(async () => undefined)
  const remote = jest.fn(async () => undefined)
  await stopRoomMember("room-1", "ava", {
    companion: () => false,
    host: () => ({ stopMember }),
    remote,
  })
  expect(stopMember).toHaveBeenCalledWith("room-1", "ava")
  expect(remote).not.toHaveBeenCalled()

  await stopRoomMember("room-1", "ava", {
    companion: () => true,
    host: () => ({ stopMember }),
    remote,
  })
  expect(remote).toHaveBeenCalledWith("room-1", "ava")
  expect(stopMember).toHaveBeenCalledTimes(1)
})
