/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import type { DeviceRow } from "@/lib/devices/types"
import type { SystemDetails } from "@/lib/perf/backend/types"
import en from "@/i18n/messages/en.json"

import { HostSystemSection } from "./host-system-section"

const UBUNTU: SystemDetails = {
  os: "Ubuntu",
  osVersion: "24.04.1 LTS",
  kernelVersion: "6.8.0-51-generic",
  arch: "x64",
  family: "node",
  hostname: "VM-0-12-ubuntu",
  cpu: "Intel(R) Xeon(R) Platinum 8255C",
  cpuCount: 4,
  totalMemoryBytes: 8 * 1024 ** 3,
  usedMemoryBytes: 3 * 1024 ** 3,
  appVersion: "unknown",
  tauriVersion: "unsupported",
  profile: "production",
  enabledFeatures: [],
}

const row = {
  ref: "companion:host-1",
  kind: "remote-host",
  runtime: { isRoutingTarget: true },
} as unknown as DeviceRow

function renderSection(load: (ref: string) => Promise<SystemDetails>) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <HostSystemSection row={row} load={load} />
    </NextIntlClientProvider>
  )
}

it("shows what the Host runs on, read over its management channel", async () => {
  const load = jest.fn().mockResolvedValue(UBUNTU)
  renderSection(load)
  expect(screen.getByTestId("host-system-status")).toHaveTextContent(/Reading/)
  await waitFor(() =>
    expect(screen.getByTestId("host-system-os")).toHaveTextContent("Ubuntu 24.04.1 LTS")
  )
  expect(load).toHaveBeenCalledWith("companion:host-1")
  const section = screen.getByTestId("host-system")
  for (const fact of [
    "6.8.0-51-generic",
    "VM-0-12-ubuntu",
    "x64",
    "Intel(R) Xeon(R) Platinum 8255C",
  ]) {
    expect(section).toHaveTextContent(fact)
  }
  expect(screen.getByTestId("host-system-memory")).toHaveTextContent("3.0 GB in use of 8.0 GB")
})

it("says why it could not read, and reads again on request", async () => {
  const load = jest
    .fn()
    .mockRejectedValueOnce(new Error("forbidden"))
    .mockResolvedValueOnce({ ...UBUNTU, hostname: null, cpu: null })
  renderSection(load)
  await waitFor(() =>
    expect(screen.getByTestId("host-system-status")).toHaveTextContent(/forbidden/)
  )
  fireEvent.click(screen.getByTestId("host-system-refresh"))
  await waitFor(() => expect(screen.getByTestId("host-system")).toHaveTextContent("—"))
  expect(load).toHaveBeenCalledTimes(2)
})
