/** @jest-environment jsdom */
import { getComputerUsePipHost, subscribeComputerUsePipHost } from "./use-computer-use-pip-host"
import { act, renderHook } from "@testing-library/react"
import { useComputerUsePipHost } from "./use-computer-use-pip-host"

it("shares host observation and ignores scrolls in unrelated panes", () => {
  const frames: FrameRequestCallback[] = []
  jest.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.push(callback)
    return frames.length
  })
  jest.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {})
  const rect = jest
    .spyOn(Element.prototype, "getBoundingClientRect")
    .mockReturnValue({ x: 0, y: 0, width: 500, height: 400 } as DOMRect)
  const first = document.createElement("div"),
    second = document.createElement("div")
  document.body.append(first, second)
  const offA = subscribeComputerUsePipHost(first, jest.fn())
  const offAgain = subscribeComputerUsePipHost(first, jest.fn())
  const offB = subscribeComputerUsePipHost(second, jest.fn())
  expect(getComputerUsePipHost(first).visible).toBe(true)
  rect.mockClear()
  for (let i = 0; i < 100; i++) first.dispatchEvent(new Event("scroll"))
  expect(frames).toHaveLength(1)
  frames.shift()!(0)
  expect(rect).toHaveBeenCalledTimes(1)
  offA()
  offAgain()
  offB()
  first.remove()
  second.remove()
  jest.restoreAllMocks()
})

it("pauses synchronously when the document hides, and cancels pending work on disposal", () => {
  const frames: FrameRequestCallback[] = []
  jest.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.push(callback)
    return frames.length
  })
  const cancel = jest.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {})
  jest
    .spyOn(Element.prototype, "getBoundingClientRect")
    .mockReturnValue({ x: 0, y: 0, width: 500, height: 400 } as DOMRect)
  const visibility = jest.spyOn(document, "visibilityState", "get").mockReturnValue("visible")
  const host = document.createElement("div")
  document.body.append(host)
  const notify = jest.fn(),
    off = subscribeComputerUsePipHost(host, notify)
  visibility.mockReturnValue("hidden")
  document.dispatchEvent(new Event("visibilitychange"))
  expect(getComputerUsePipHost(host).visible).toBe(false)
  expect(frames).toHaveLength(0)
  visibility.mockReturnValue("visible")
  document.dispatchEvent(new Event("visibilitychange"))
  frames.shift()!(0)
  expect(getComputerUsePipHost(host).visible).toBe(true)
  window.dispatchEvent(new Event("resize"))
  off()
  expect(cancel).toHaveBeenCalled()
  host.remove()
  jest.restoreAllMocks()
})

it("tracks host style and obstacle mutations without frame-driven observer rebuilds", async () => {
  const frames: FrameRequestCallback[] = []
  jest.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.push(callback)
    return frames.length
  })
  jest.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {})
  jest
    .spyOn(Element.prototype, "getBoundingClientRect")
    .mockReturnValue({ x: 0, y: 0, width: 500, height: 400 } as DOMRect)
  const host = document.createElement("div")
  document.body.append(host)
  const off = subscribeComputerUsePipHost(host, jest.fn())
  host.style.display = "none"
  await Promise.resolve()
  frames.shift()!(0)
  expect(getComputerUsePipHost(host).visible).toBe(false)
  host.style.display = "block"
  await Promise.resolve()
  frames.shift()!(0)
  expect(getComputerUsePipHost(host).visible).toBe(true)
  const obstacle = document.createElement("div")
  obstacle.setAttribute("data-computer-use-pip-obstacle", "")
  host.append(obstacle)
  await Promise.resolve()
  frames.shift()!(0)
  expect(getComputerUsePipHost(host).obstacles).toHaveLength(1)
  obstacle.remove()
  await Promise.resolve()
  frames.shift()!(0)
  expect(getComputerUsePipHost(host).obstacles).toHaveLength(0)
  off()
  host.remove()
  jest.restoreAllMocks()
})

it("keeps idle hosts unobserved until enabled", () => {
  const rect = jest
    .spyOn(Element.prototype, "getBoundingClientRect")
    .mockReturnValue({ x: 0, y: 0, width: 500, height: 400 } as DOMRect)
  const host = document.createElement("div"),
    child = document.createElement("div")
  host.setAttribute("data-computer-use-pip-host", "")
  host.append(child)
  document.body.append(host)
  const hook = renderHook(({ enabled }) => useComputerUsePipHost(enabled), {
    initialProps: { enabled: false },
  })
  act(() => hook.result.current.ref(child))
  expect(rect).not.toHaveBeenCalled()
  hook.rerender({ enabled: true })
  expect(hook.result.current.geometry.visible).toBe(true)
  hook.unmount()
  host.remove()
  jest.restoreAllMocks()
})
