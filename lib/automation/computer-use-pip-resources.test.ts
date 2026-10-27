/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react"
import {
  loadComputerUsePipPreference,
  resetComputerUsePipResources,
  useComputerUsePipClock,
  useComputerUsePipStreamSlot,
  useComputerUsePipStreamTransport,
  createComputerUsePipStreamTransport,
} from "./computer-use-pip-resources"
import { useSandboxDesktopStream } from "@/hooks/automation/use-sandbox-desktop-stream"
import { sandboxClient, type SandboxStreamGrant } from "./sandbox-client"

afterEach(() => {
  resetComputerUsePipResources()
  jest.restoreAllMocks()
  jest.useRealTimers()
})

function usePreview(connectionId: string, active: boolean) {
  const allowed = useComputerUsePipStreamSlot(connectionId, active)
  const transport = useComputerUsePipStreamTransport(allowed, connectionId)
  return useSandboxDesktopStream(connectionId, allowed, transport)
}

it("waits for confirmed close before handing the actual stream hook to another view", async () => {
  jest.useFakeTimers()
  let grantNumber = 0
  const open = jest.spyOn(sandboxClient, "streamOpen").mockImplementation(
    async () =>
      ({
        viewerId: `v-${++grantNumber}`,
        role: "viewer",
        url: "http://localhost/stream",
      }) as SandboxStreamGrant
  )
  let confirmClose!: () => void
  const close = jest
    .spyOn(sandboxClient, "streamClose")
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          confirmClose = resolve
        })
    )
    .mockResolvedValue(undefined)
  const first = renderHook(({ active }) => usePreview("desktop", active), {
    initialProps: { active: true },
  })
  const second = renderHook(() => usePreview("desktop", true))
  await act(async () => {
    jest.advanceTimersByTime(0)
  })
  expect(first.result.current.grant?.viewerId).toBe("v-1")
  first.rerender({ active: false })
  await act(async () => {
    jest.advanceTimersByTime(0)
  })
  expect(close).toHaveBeenCalledTimes(1)
  expect(open).toHaveBeenCalledTimes(1)
  await act(async () => confirmClose())
  expect(open).toHaveBeenCalledTimes(2)
  expect(second.result.current.grant?.viewerId).toBe("v-2")
  first.unmount()
  second.unmount()
})

it("cancels an in-flight open on unmount and closes it before a successor opens", async () => {
  jest.useFakeTimers()
  let finishOpen!: (grant: SandboxStreamGrant) => void
  const open = jest
    .spyOn(sandboxClient, "streamOpen")
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOpen = resolve
        })
    )
    .mockResolvedValue({
      viewerId: "next",
      role: "viewer",
      url: "http://localhost/stream",
    } as SandboxStreamGrant)
  const close = jest.spyOn(sandboxClient, "streamClose").mockResolvedValue(undefined)
  const first = renderHook(() => usePreview("desktop", true))
  await act(async () => {
    jest.advanceTimersByTime(0)
  })
  first.unmount()
  const next = renderHook(() => usePreview("desktop", true))
  await act(async () => {
    jest.advanceTimersByTime(0)
  })
  expect(open).toHaveBeenCalledTimes(1)
  await act(async () =>
    finishOpen({
      viewerId: "late",
      role: "viewer",
      url: "http://localhost/stream",
    } as SandboxStreamGrant)
  )
  expect(close).toHaveBeenCalledWith("desktop", "late")
  expect(open).toHaveBeenCalledTimes(2)
  expect(next.result.current.grant?.viewerId).toBe("next")
  next.unmount()
})

it("single-flights settings reads", async () => {
  const load = jest.fn(async () => ({ alwaysHidePictureInPicture: false }))
  await Promise.all([loadComputerUsePipPreference(load), loadComputerUsePipPreference(load)])
  expect(load).toHaveBeenCalledTimes(1)
})

it("holds transport capacity after a failed close until its retry is confirmed", async () => {
  jest.useFakeTimers()
  let grantNumber = 0
  const open = jest.spyOn(sandboxClient, "streamOpen").mockImplementation(
    async () =>
      ({
        viewerId: `v-${++grantNumber}`,
        role: "viewer",
        url: "http://localhost/stream",
      }) as SandboxStreamGrant
  )
  const close = jest
    .spyOn(sandboxClient, "streamClose")
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue(undefined)
  const first = createComputerUsePipStreamTransport("first"),
    next = createComputerUsePipStreamTransport("next")
  const grant = await first.open("desktop")
  await expect(first.close("desktop", grant.viewerId)).rejects.toThrow("offline")
  const waiting = next.open("desktop")
  expect(open).toHaveBeenCalledTimes(1)
  await act(async () => {
    jest.advanceTimersByTime(1000)
  })
  const second = await waiting
  expect(close).toHaveBeenCalledTimes(2)
  expect(open).toHaveBeenCalledTimes(2)
  await next.close("desktop", second.viewerId)
})

it("keeps provider failure identity for the existing unavailable fallback", async () => {
  const error = { code: "stream-unavailable", message: "No stream provider" }
  jest.spyOn(sandboxClient, "streamOpen").mockRejectedValueOnce(error)
  await expect(createComputerUsePipStreamTransport("view").open("desktop")).rejects.toBe(error)
})

it("reserves only two native transports and queues a third until close settles", async () => {
  let grantNumber = 0
  const open = jest.spyOn(sandboxClient, "streamOpen").mockImplementation(
    async () =>
      ({
        viewerId: `v-${++grantNumber}`,
        role: "viewer",
        url: "http://localhost/stream",
      }) as SandboxStreamGrant
  )
  let confirm!: () => void
  jest
    .spyOn(sandboxClient, "streamClose")
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          confirm = resolve
        })
    )
    .mockResolvedValue(undefined)
  const transport = createComputerUsePipStreamTransport("owner")
  const first = await transport.open("a"),
    second = await transport.open("b")
  const third = transport.open("c")
  expect(open).toHaveBeenCalledTimes(2)
  const closing = transport.close("a", first.viewerId)
  expect(open).toHaveBeenCalledTimes(2)
  confirm()
  await closing
  const last = await third
  expect(open).toHaveBeenCalledTimes(3)
  await transport.close("b", second.viewerId)
  await transport.close("c", last.viewerId)
})

it("promotes a focused target while retaining the global stream bound", () => {
  const first = renderHook(() => useComputerUsePipStreamSlot("a", true))
  const second = renderHook(() => useComputerUsePipStreamSlot("b", true))
  const focused = renderHook(({ priority }) => useComputerUsePipStreamSlot("c", true, priority), {
    initialProps: { priority: false },
  })
  expect(focused.result.current).toBe(false)
  focused.rerender({ priority: true })
  expect(focused.result.current).toBe(true)
  expect(
    [first.result.current, second.result.current, focused.result.current].filter(Boolean)
  ).toHaveLength(2)
  first.unmount()
  second.unmount()
  focused.unmount()
})

it("shares one freshness clock and stops it after the last visible consumer", () => {
  jest.useFakeTimers()
  const first = renderHook(() => useComputerUsePipClock(true))
  const second = renderHook(() => useComputerUsePipClock(true))
  expect(jest.getTimerCount()).toBe(1)
  act(() => jest.advanceTimersByTime(1000))
  expect(first.result.current).toBe(second.result.current)
  first.unmount()
  second.unmount()
  expect(jest.getTimerCount()).toBe(0)
})

it("allows one decoder per target and two targets globally, handing off on hide", () => {
  const a = renderHook(({ active }) => useComputerUsePipStreamSlot("a", active), {
    initialProps: { active: true },
  })
  const duplicate = renderHook(() => useComputerUsePipStreamSlot("a", true))
  const b = renderHook(() => useComputerUsePipStreamSlot("b", true))
  const c = renderHook(() => useComputerUsePipStreamSlot("c", true))
  expect([a.result.current, duplicate.result.current, b.result.current, c.result.current]).toEqual([
    true,
    false,
    true,
    false,
  ])
  a.rerender({ active: false })
  expect(duplicate.result.current).toBe(true)
  duplicate.unmount()
  expect(c.result.current).toBe(true)
  a.unmount()
  b.unmount()
  c.unmount()
})
