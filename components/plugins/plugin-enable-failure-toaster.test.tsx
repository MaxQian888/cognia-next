import { act, render } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"
import zhMessages from "@/i18n/messages/zh-CN.json"

import { PluginEnableFailureToaster } from "./plugin-enable-failure-toaster"
import {
  PLUGIN_ENABLE_FAILED_EVENT,
  type PluginEnableFailedEventDetail,
} from "@/lib/plugin/error-bus"

// Capture toast.error calls — sonner's actual side effect (DOM toast)
// happens in <Toaster /> which we don't mount; this jest.mock lets us
// assert on the (title, options) payload directly.
jest.mock("sonner", () => ({
  toast: {
    error: jest.fn(),
  },
}))
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sonner = require("sonner") as { toast: { error: jest.Mock } }

function renderToaster(locale: "en" | "zh-CN" = "en") {
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === "en" ? enMessages : zhMessages}>
      <PluginEnableFailureToaster />
    </NextIntlClientProvider>
  )
}

function fireEvent(detail: PluginEnableFailedEventDetail) {
  act(() => {
    window.dispatchEvent(new CustomEvent(PLUGIN_ENABLE_FAILED_EVENT, { detail }))
  })
}

const sampleDetail: PluginEnableFailedEventDetail = {
  pluginId: "com.example.foo",
  pluginName: "Foo Plugin",
  errorMessage: "registry blew up",
  reason: "manual",
}

beforeEach(() => {
  sonner.toast.error.mockReset()
})

describe("PluginEnableFailureToaster", () => {
  it("renders nothing in the DOM (it's a side-effect-only listener)", () => {
    const { container } = renderToaster()
    expect(container.firstChild).toBeNull()
  })

  it("fires an EN sonner toast when the CustomEvent arrives", () => {
    renderToaster("en")
    fireEvent(sampleDetail)
    expect(sonner.toast.error).toHaveBeenCalledTimes(1)
    const [title, options] = sonner.toast.error.mock.calls[0]
    expect(title).toContain("Foo Plugin")
    expect(options.description).toContain("Foo Plugin")
    expect(options.description).toContain("registry blew up")
    expect(options.id).toBe("com.example.foo::registry blew up")
  })

  it("interpolates pluginName + errorMessage into the message catalog", () => {
    // Locale-switching is next-intl's job and exercised by
    // `pnpm lint:i18n` (key parity) + the catalog itself. This test
    // only asserts our component plumbs the interpolation values
    // through `t()` correctly — the zh-CN copy lives in
    // `i18n/messages/zh-CN.json` next to the en entry.
    renderToaster("en")
    fireEvent({
      pluginId: "com.example.foo",
      pluginName: "Custom Display Name",
      errorMessage: "very specific failure",
      reason: "manual",
    })
    const [title, options] = sonner.toast.error.mock.calls[0]
    expect(title).toContain("Custom Display Name")
    expect(options.description).toContain("Custom Display Name")
    expect(options.description).toContain("very specific failure")
  })

  it("dedupes back-to-back identical events within the 2s window", () => {
    renderToaster()
    fireEvent(sampleDetail)
    fireEvent(sampleDetail)
    fireEvent(sampleDetail)
    expect(sonner.toast.error).toHaveBeenCalledTimes(1)
  })

  it("does not dedupe different plugins firing in quick succession", () => {
    renderToaster()
    fireEvent(sampleDetail)
    fireEvent({ ...sampleDetail, pluginId: "com.example.bar", pluginName: "Bar Plugin" })
    expect(sonner.toast.error).toHaveBeenCalledTimes(2)
  })

  it("does not dedupe different error messages from the same plugin", () => {
    renderToaster()
    fireEvent(sampleDetail)
    fireEvent({ ...sampleDetail, errorMessage: "another failure" })
    expect(sonner.toast.error).toHaveBeenCalledTimes(2)
  })

  it("ignores events with missing detail.pluginId", () => {
    renderToaster()
    act(() => {
      window.dispatchEvent(
        new CustomEvent(PLUGIN_ENABLE_FAILED_EVENT, {
          detail: { pluginId: "", pluginName: "", errorMessage: "", reason: "manual" },
        })
      )
    })
    expect(sonner.toast.error).not.toHaveBeenCalled()
  })
})
