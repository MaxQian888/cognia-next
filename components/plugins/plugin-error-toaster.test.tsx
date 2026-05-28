import { act, render } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"
import zhMessages from "@/i18n/messages/zh-CN.json"

import { PluginErrorToaster } from "./plugin-error-toaster"
import { PLUGIN_ERROR_EVENT, type PluginErrorEventDetail } from "@/lib/plugin/error-bus"

jest.mock("sonner", () => ({
  toast: {
    error: jest.fn(),
    warning: jest.fn(),
  },
}))
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sonner = require("sonner") as {
  toast: { error: jest.Mock; warning: jest.Mock }
}

function renderToaster(locale: "en" | "zh-CN" = "en") {
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === "en" ? enMessages : zhMessages}>
      <PluginErrorToaster />
    </NextIntlClientProvider>
  )
}

function fireEvent(detail: PluginErrorEventDetail) {
  act(() => {
    window.dispatchEvent(new CustomEvent(PLUGIN_ERROR_EVENT, { detail }))
  })
}

const baseDetail: PluginErrorEventDetail = {
  pluginId: "com.example.foo",
  pluginName: "Foo Plugin",
  stage: "install",
  message: "registry blew up",
  severity: "error",
  recoverable: false,
}

beforeEach(() => {
  sonner.toast.error.mockReset()
  sonner.toast.warning.mockReset()
})

describe("PluginErrorToaster", () => {
  it("renders nothing in the DOM (side-effect-only listener)", () => {
    const { container } = renderToaster()
    expect(container.firstChild).toBeNull()
  })

  it("fires sonner.error on severity=error with the stage-specific EN title", () => {
    renderToaster("en")
    fireEvent(baseDetail)
    expect(sonner.toast.error).toHaveBeenCalledTimes(1)
    expect(sonner.toast.warning).not.toHaveBeenCalled()
    const [title, options] = sonner.toast.error.mock.calls[0]
    expect(title).toContain("Foo Plugin")
    expect(title.toLowerCase()).toContain("install")
    expect(options.description).toBe("registry blew up")
    expect(options.id).toBe("com.example.foo::install::registry blew up")
  })

  it("fires sonner.warning on severity=warning", () => {
    renderToaster("en")
    fireEvent({ ...baseDetail, severity: "warning", stage: "wasm-preload" })
    expect(sonner.toast.warning).toHaveBeenCalledTimes(1)
    expect(sonner.toast.error).not.toHaveBeenCalled()
    const [title] = sonner.toast.warning.mock.calls[0]
    expect(title).toContain("WASM")
    expect(title).toContain("Foo Plugin")
  })

  it("falls back to pluginId when pluginName is missing", () => {
    renderToaster("en")
    fireEvent({ ...baseDetail, pluginName: undefined })
    const [title] = sonner.toast.error.mock.calls[0]
    expect(title).toContain("com.example.foo")
  })

  // Locale switching is next-intl's job and asserted by `pnpm lint:i18n`
  // (key parity) + the catalog itself; the zh-CN copy lives next to the en
  // entry in `i18n/messages/zh-CN.json`. Keeping a zh-CN render test here
  // is brittle because next-intl resolves messages from the static import
  // at module-load time in this jest setup.

  it("dedupes back-to-back identical events within the 2s window", () => {
    renderToaster()
    fireEvent(baseDetail)
    fireEvent(baseDetail)
    fireEvent(baseDetail)
    expect(sonner.toast.error).toHaveBeenCalledTimes(1)
  })

  it("does not dedupe across different stages even with the same plugin/message", () => {
    renderToaster()
    fireEvent(baseDetail)
    fireEvent({ ...baseDetail, stage: "config" })
    expect(sonner.toast.error).toHaveBeenCalledTimes(2)
  })

  it("does not dedupe across different plugins", () => {
    renderToaster()
    fireEvent(baseDetail)
    fireEvent({ ...baseDetail, pluginId: "com.example.bar", pluginName: "Bar" })
    expect(sonner.toast.error).toHaveBeenCalledTimes(2)
  })

  it("uses a longer toast duration for non-recoverable errors", () => {
    renderToaster()
    fireEvent({ ...baseDetail, recoverable: false })
    fireEvent({ ...baseDetail, recoverable: true, message: "transient" })
    const [, firstOpts] = sonner.toast.error.mock.calls[0]
    const [, secondOpts] = sonner.toast.error.mock.calls[1]
    expect(firstOpts.duration).toBeGreaterThan(secondOpts.duration)
  })

  it("ignores events with empty pluginId", () => {
    renderToaster()
    act(() => {
      window.dispatchEvent(
        new CustomEvent(PLUGIN_ERROR_EVENT, {
          detail: { ...baseDetail, pluginId: "" },
        })
      )
    })
    expect(sonner.toast.error).not.toHaveBeenCalled()
  })
})
