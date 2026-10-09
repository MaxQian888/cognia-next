jest.mock("@/lib/sync/host-invalidate", () => ({ publishSyncInvalidate: jest.fn() }))

import { publishSyncInvalidate } from "@/lib/sync/host-invalidate"
import {
  __resetPetControllerPresenceForTesting,
  isPetControllerPresent,
  markPetControllerPresent,
} from "./controller-presence"

const publishMock = publishSyncInvalidate as jest.Mock

beforeEach(() => {
  __resetPetControllerPresenceForTesting()
  publishMock.mockReset()
})

describe("pet controller presence", () => {
  it("is absent until the controller subscribes, and absent again after", () => {
    expect(isPetControllerPresent()).toBe(false)
    const release = markPetControllerPresent()
    expect(isPetControllerPresent()).toBe(true)
    release()
    expect(isPetControllerPresent()).toBe(false)
  })

  it("survives an overlapping remount: the surviving subscription keeps it present", () => {
    const first = markPetControllerPresent()
    const second = markPetControllerPresent()
    first()
    expect(isPetControllerPresent()).toBe(true)
    second()
    expect(isPetControllerPresent()).toBe(false)
  })

  it("ignores a release called twice", () => {
    const first = markPetControllerPresent()
    const second = markPetControllerPresent()
    first()
    first()
    expect(isPetControllerPresent()).toBe(true)
    second()
  })

  it("invalidates the pet profile for paired devices on each edge only", () => {
    const a = markPetControllerPresent()
    expect(publishMock).toHaveBeenCalledTimes(1)
    expect(publishMock).toHaveBeenLastCalledWith("petProfile")

    // An overlapping remount changes nothing a phone can observe.
    const b = markPetControllerPresent()
    b()
    expect(publishMock).toHaveBeenCalledTimes(1)

    a()
    expect(publishMock).toHaveBeenCalledTimes(2)
    expect(publishMock).toHaveBeenLastCalledWith("petProfile")

    // A repeated release is not a second edge.
    a()
    expect(publishMock).toHaveBeenCalledTimes(2)
  })
})
