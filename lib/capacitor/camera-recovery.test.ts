/** @jest-environment jsdom */
import {
  beginCameraRecovery,
  handleRestoredCameraResult,
  subscribeCameraRecovery,
} from "./camera-recovery"

let mockScope = "account-a-target-a"
jest.mock("@/lib/db/schema", () => ({ getDb: () => ({ name: mockScope }) }))
jest.mock("./app", () => ({ subscribeRestoredResult: jest.fn(async () => () => {}) }))

const target = { kind: "chat" as const, id: "session-a" }
const restored = {
  pluginId: "Camera",
  methodName: "getPhoto",
  success: true,
  data: { webPath: "https://localhost/_capacitor_file_/photo.jpg", format: "jpeg" },
}
const tick = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

beforeEach(() => {
  localStorage.clear()
  mockScope = "account-a-target-a"
})

it("retains a restored URI until the original scoped destination acknowledges it once", async () => {
  const finish = await beginCameraRecovery(target, "getPhoto")
  handleRestoredCameraResult(restored)
  mockScope = "account-b-target-a"
  const wrong = jest.fn(async () => true)
  const offWrong = subscribeCameraRecovery(target, wrong)
  await tick()
  expect(wrong).not.toHaveBeenCalled()
  offWrong()
  mockScope = "account-a-target-a"
  const accept = jest.fn(async () => true)
  const off = subscribeCameraRecovery(target, accept)
  await tick()
  expect(accept).toHaveBeenCalledWith(
    { kind: "photo", photo: { uri: restored.data.webPath, format: "jpeg" } },
    expect.any(Function)
  )
  off()
  const offAgain = subscribeCameraRecovery(target, accept)
  await tick()
  expect(accept).toHaveBeenCalledTimes(1)
  offAgain()
  finish()
})

it("ignores unrelated methods, clears cancellations and ordinary completion", async () => {
  const finish = await beginCameraRecovery(target, "getPhoto")
  handleRestoredCameraResult({ ...restored, methodName: "pickImages" })
  finish()
  handleRestoredCameraResult(restored)
  const accept = jest.fn(async () => true)
  const off = subscribeCameraRecovery(target, accept)
  await tick()
  expect(accept).not.toHaveBeenCalled()
  const finish2 = await beginCameraRecovery(target, "getPhoto")
  handleRestoredCameraResult({ ...restored, success: false, error: { message: "User cancelled" } })
  await tick()
  expect(accept).not.toHaveBeenCalled()
  finish2()
  off()
})

it("routes restored native failures to their destination instead of dropping them", async () => {
  const finish = await beginCameraRecovery(target, "getPhoto")
  handleRestoredCameraResult({ ...restored, success: false, error: { message: "Camera failed" } })
  const accept = jest.fn(async () => true)
  const off = subscribeCameraRecovery(target, accept)
  await tick()
  expect(accept).toHaveBeenCalledWith({ kind: "error" }, expect.any(Function))
  off()
  finish()
})

it("caps restored album results and retains refused delivery for a later mount", async () => {
  const finish = await beginCameraRecovery(target, "pickImages", 1)
  handleRestoredCameraResult({
    ...restored,
    methodName: "pickImages",
    data: { photos: [restored.data, restored.data] },
  })
  const reject = jest.fn(async () => false)
  const off = subscribeCameraRecovery(target, reject)
  await tick()
  off()
  expect(reject).toHaveBeenCalledWith(
    { kind: "photos", photos: [{ uri: restored.data.webPath, format: "jpeg" }] },
    expect.any(Function)
  )
  const accept = jest.fn(async () => true)
  const off2 = subscribeCameraRecovery(target, accept)
  await tick()
  off2()
  finish()
  expect(accept).toHaveBeenCalledTimes(1)
})

it("does not deliver to an unmounted subscriber while scope loads", async () => {
  const finish = await beginCameraRecovery(target, "getPhoto")
  handleRestoredCameraResult(restored)
  const accept = jest.fn(async () => true)
  const off = subscribeCameraRecovery(target, accept)
  off()
  await tick()
  expect(accept).not.toHaveBeenCalled()
  finish()
})

it("invalidates an async consumer when the account or host changes", async () => {
  const finish = await beginCameraRecovery(target, "getPhoto")
  handleRestoredCameraResult(restored)
  let current: (() => boolean) | undefined
  const off = subscribeCameraRecovery(target, async (_result, isCurrent) => {
    current = isCurrent
    return false
  })
  await tick()
  expect(current?.()).toBe(true)
  mockScope = "account-a-target-b"
  expect(current?.()).toBe(false)
  off()
  finish()
})

it("claims a restored event only once when two destinations mount together", async () => {
  const finish = await beginCameraRecovery(target, "getPhoto")
  handleRestoredCameraResult(restored)
  const accept = jest.fn(async () => {
    await tick()
    return true
  })
  const off1 = subscribeCameraRecovery(target, accept)
  const off2 = subscribeCameraRecovery(target, accept)
  await tick()
  await tick()
  expect(accept).toHaveBeenCalledTimes(1)
  off1()
  off2()
  finish()
})

it("hands a refused in-flight receipt to a remounted destination", async () => {
  const finish = await beginCameraRecovery(target, "getPhoto")
  handleRestoredCameraResult(restored)
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const offOld = subscribeCameraRecovery(target, async (_result, isCurrent) => {
    await pending
    return isCurrent()
  })
  await tick()
  offOld()
  const accept = jest.fn(async () => true)
  const offNew = subscribeCameraRecovery(target, accept)
  await tick()
  expect(accept).not.toHaveBeenCalled()
  release()
  await tick()
  await tick()
  expect(accept).toHaveBeenCalledTimes(1)
  offNew()
  finish()
})
