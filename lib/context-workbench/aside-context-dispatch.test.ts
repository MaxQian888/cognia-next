import { createAsideContextDispatch } from "./aside-context-dispatch"

const cursor = { parentMessageId: "p1", tailFingerprint: "fingerprint" }

it.each([true, false])(
  "advances only after both dispatch and SDK identity (identity first: %s)",
  async (identityFirst) => {
    const persist = jest.fn().mockResolvedValue(undefined)
    const dispatch = createAsideContextDispatch(cursor, persist)
    if (identityFirst) await dispatch.acknowledgeSdk("sdk")
    else await dispatch.dispatched()
    expect(persist).not.toHaveBeenCalled()
    if (identityFirst) await dispatch.dispatched()
    else await dispatch.acknowledgeSdk("sdk")
    expect(persist).toHaveBeenCalledWith({ ...cursor, sdkSessionId: "sdk" })
    await dispatch.acknowledgeSdk("sdk")
    expect(persist).toHaveBeenCalledTimes(1)
  }
)

it("does not acknowledge context for a rejected dispatch even if an identity arrived", async () => {
  const persist = jest.fn()
  const dispatch = createAsideContextDispatch(cursor, persist, "old")
  await dispatch.acknowledgeSdk("new")
  dispatch.cancel()
  await dispatch.dispatched()
  expect(persist).not.toHaveBeenCalled()
})

it("records the new SDK identity rather than a stale resume id", async () => {
  const persist = jest.fn().mockResolvedValue(undefined)
  const dispatch = createAsideContextDispatch(cursor, persist, "old")
  await dispatch.acknowledgeSdk("new")
  await dispatch.dispatched()
  expect(persist).toHaveBeenCalledWith({ ...cursor, sdkSessionId: "new" })
})

it("ignores a late SDK identity from a replaced turn", async () => {
  const persist = jest.fn().mockResolvedValue(undefined)
  const dispatch = createAsideContextDispatch(cursor, persist, undefined, "current")
  await dispatch.dispatched()
  await dispatch.acknowledgeSdk("stale-sdk", "previous")
  expect(persist).not.toHaveBeenCalled()
  await dispatch.acknowledgeSdk("new-sdk", "current")
  expect(persist).toHaveBeenCalledWith({ ...cursor, sdkSessionId: "new-sdk" })
})
