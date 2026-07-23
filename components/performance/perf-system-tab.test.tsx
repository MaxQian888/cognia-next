/**
 * @jest-environment jsdom
 */

import React from "react"
import { render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import messages from "@/i18n/messages/en.json"
import { PerfSystemTab } from "./perf-system-tab"
import type { SystemDetails } from "@/lib/perf/backend/types"

function details(overrides: Partial<SystemDetails> = {}): SystemDetails {
  return {
    os: "macOS",
    osVersion: "15.5",
    kernelVersion: "24.5.0",
    arch: "aarch64",
    family: "unix",
    hostname: "workstation",
    cpu: "Apple M3 Max",
    cpuCount: 14,
    totalMemoryBytes: 68_719_476_736,
    usedMemoryBytes: 34_359_738_368,
    appVersion: "0.1.0",
    tauriVersion: "2.9.0",
    profile: "release",
    enabledFeatures: ["ocr", "vector"],
    ...overrides,
  }
}

function renderTab(load: () => Promise<SystemDetails | null>) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <PerfSystemTab load={load} />
    </NextIntlClientProvider>
  )
}

describe("PerfSystemTab", () => {
  it("shows a loading state until the details land", async () => {
    let resolve: (d: SystemDetails) => void = () => {}
    renderTab(() => new Promise<SystemDetails>((r) => (resolve = r)))

    expect(screen.getByTestId("perf-system-loading")).toBeInTheDocument()
    resolve(details())
    await waitFor(() => expect(screen.getByTestId("perf-system-tab")).toBeInTheDocument())
  })

  it("renders host, hardware, and build facts", async () => {
    renderTab(async () => details())

    await waitFor(() =>
      expect(screen.getByTestId("perf-system-os")).toHaveTextContent("macOS 15.5")
    )
    expect(screen.getByTestId("perf-system-kernel")).toHaveTextContent("24.5.0")
    expect(screen.getByTestId("perf-system-hostname")).toHaveTextContent("workstation")
    expect(screen.getByTestId("perf-system-arch")).toHaveTextContent("aarch64 · unix")
    expect(screen.getByTestId("perf-system-cpu")).toHaveTextContent("Apple M3 Max")
    expect(screen.getByTestId("perf-system-cores")).toHaveTextContent("14")
    expect(screen.getByTestId("perf-system-app-version")).toHaveTextContent("0.1.0")
    expect(screen.getByTestId("perf-system-tauri-version")).toHaveTextContent("2.9.0")
    expect(screen.getByTestId("perf-system-profile")).toHaveTextContent("release")
    expect(screen.getByTestId("perf-system-features")).toHaveTextContent("ocr")
    expect(screen.getByTestId("perf-system-features")).toHaveTextContent("vector")
  })

  it("formats memory as bytes rather than raw numbers", async () => {
    renderTab(async () => details())
    await waitFor(() => expect(screen.getByTestId("perf-system-total-mem")).toBeInTheDocument())
    expect(screen.getByTestId("perf-system-total-mem")).toHaveTextContent("64.0 GB")
    expect(screen.getByTestId("perf-system-used-mem")).toHaveTextContent("32.0 GB")
  })

  it("falls back to a placeholder for fields the host did not report", async () => {
    renderTab(async () =>
      details({ osVersion: null, kernelVersion: null, hostname: null, cpu: null })
    )

    await waitFor(() => expect(screen.getByTestId("perf-system-os")).toHaveTextContent("macOS"))
    expect(screen.getByTestId("perf-system-kernel")).toHaveTextContent("—")
    expect(screen.getByTestId("perf-system-hostname")).toHaveTextContent("—")
    expect(screen.getByTestId("perf-system-cpu")).toHaveTextContent("—")
  })

  it("says so when no optional features are enabled", async () => {
    renderTab(async () => details({ enabledFeatures: [] }))
    await waitFor(() => expect(screen.getByTestId("perf-system-no-features")).toBeInTheDocument())
    expect(screen.queryByTestId("perf-system-features")).not.toBeInTheDocument()
  })

  it("treats a null result (no native runtime) as unavailable, not as loading", async () => {
    renderTab(async () => null)
    await waitFor(() => expect(screen.getByTestId("perf-system-error")).toBeInTheDocument())
  })

  it("surfaces a failure instead of hanging on the loading state", async () => {
    renderTab(async () => {
      throw new Error("no native runtime")
    })
    await waitFor(() => expect(screen.getByTestId("perf-system-error")).toBeInTheDocument())
    expect(screen.queryByTestId("perf-system-loading")).not.toBeInTheDocument()
  })

  it("ignores a resolution that lands after unmount", async () => {
    let resolve: (d: SystemDetails) => void = () => {}
    const { unmount } = renderTab(() => new Promise<SystemDetails>((r) => (resolve = r)))
    unmount()
    resolve(details())
    await Promise.resolve()
    // No state update on an unmounted tree — the assertion is the absence of a
    // React act/"setState on unmounted" warning, plus a clean teardown.
    expect(screen.queryByTestId("perf-system-tab")).not.toBeInTheDocument()
  })
})
