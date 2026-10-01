import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

let mockLocale = "en"
const mockProviders: Array<{ locale: string; messages: Record<string, unknown> }> = []
jest.mock("next-intl", () => ({
  useLocale: () => mockLocale,
  useTimeZone: () => "Asia/Shanghai",
  useTranslations: () => (key: string) => key,
  NextIntlClientProvider: (props: {
    locale: string
    messages: Record<string, unknown>
    children: React.ReactNode
  }) => {
    mockProviders.push(props)
    return props.children
  },
}))
jest.mock("@/i18n/messages", () => ({ loadMessages: jest.fn() }))
jest.mock("@/components/ui/loading-states", () => ({
  PageLoading: () => <div role="status">loading</div>,
}))
import { loadMessages } from "@/i18n/messages"
import { FullMessagesGate } from "./full-messages-gate"
const load = loadMessages as jest.Mock

beforeEach(() => {
  mockLocale = "en"
  mockProviders.length = 0
  load.mockReset()
})

it("waits for the complete selected catalog before mounting translated children", async () => {
  let resolve!: (value: unknown) => void
  load.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r
      })
  )
  render(
    <FullMessagesGate>
      <div>workspace</div>
    </FullMessagesGate>
  )
  expect(screen.queryByText("workspace")).not.toBeInTheDocument()
  expect(screen.getByRole("status")).toBeInTheDocument()
  expect(load).toHaveBeenCalledWith("en")
  await act(async () => {
    resolve({ chat: { title: "Chat" } })
  })
  expect(screen.getByText("workspace")).toBeInTheDocument()
})

it("loads only Chinese for a Chinese user and includes plugin messages", async () => {
  mockLocale = "zh-CN"
  load.mockResolvedValue({ chat: { title: "聊天" } })
  render(
    <FullMessagesGate additionalMessages={{ "zh-CN": { plugin: { title: "插件" } } }}>
      workspace
    </FullMessagesGate>
  )
  await screen.findByText("workspace")
  expect(load.mock.calls).toEqual([["zh-CN"]])
  expect(mockProviders.at(-1)?.messages).toEqual({
    chat: { title: "聊天" },
    plugin: { title: "插件" },
  })
})

it("offers a working retry without mounting incomplete UI on chunk failure", async () => {
  load.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ chat: {} })
  render(<FullMessagesGate>workspace</FullMessagesGate>)
  await screen.findByRole("alert")
  expect(screen.queryByText("workspace")).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "retryLanguage" }))
  await screen.findByText("workspace")
  expect(load).toHaveBeenCalledTimes(2)
  expect(screen.queryByRole("alert")).not.toBeInTheDocument()
})

it("ignores stale requests and switches Chinese back to English without remounting children", async () => {
  let resolveChinese!: (value: unknown) => void
  load.mockResolvedValueOnce({ greeting: "Hello" })
  let mounts = 0
  function Child() {
    const React = jest.requireActual("react")
    React.useEffect(() => {
      mounts++
    }, [])
    return <div>workspace</div>
  }
  const { rerender } = render(
    <FullMessagesGate>
      <Child />
    </FullMessagesGate>
  )
  await screen.findByText("workspace")
  load.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveChinese = resolve
      })
  )
  mockLocale = "zh-CN"
  rerender(
    <FullMessagesGate>
      <Child />
    </FullMessagesGate>
  )
  expect(mockProviders.at(-1)?.locale).toBe("en")
  mockLocale = "en"
  load.mockResolvedValueOnce({ greeting: "Hello again" })
  rerender(
    <FullMessagesGate>
      <Child />
    </FullMessagesGate>
  )
  await waitFor(() => expect(mockProviders.at(-1)?.messages.greeting).toBe("Hello again"))
  await act(async () => {
    resolveChinese({ greeting: "你好" })
  })
  expect(mockProviders.at(-1)?.locale).toBe("en")
  expect(mounts).toBe(1)
})

it("does not download SSR English before the boot locale and settings have resolved", async () => {
  const { LocaleReadyContext } = await import("./full-messages-gate")
  load.mockResolvedValue({ greeting: "你好" })
  const { rerender } = render(
    <LocaleReadyContext.Provider value={false}>
      <FullMessagesGate ready={false}>workspace</FullMessagesGate>
    </LocaleReadyContext.Provider>
  )
  expect(load).not.toHaveBeenCalled()
  mockLocale = "zh-CN"
  rerender(
    <LocaleReadyContext.Provider value={true}>
      <FullMessagesGate ready={false}>workspace</FullMessagesGate>
    </LocaleReadyContext.Provider>
  )
  expect(load).not.toHaveBeenCalled()
  rerender(
    <LocaleReadyContext.Provider value={true}>
      <FullMessagesGate ready>workspace</FullMessagesGate>
    </LocaleReadyContext.Provider>
  )
  await screen.findByText("workspace")
  expect(load.mock.calls).toEqual([["zh-CN"]])
})
