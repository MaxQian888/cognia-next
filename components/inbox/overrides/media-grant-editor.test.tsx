/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"

import { resolveMediaModelPolicy, type MediaModelGrant } from "@/lib/connectors/media-model-gate"

import { MediaGrantEditor } from "./media-grant-editor"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

const NOW = 1_700_000_000_000

function Harness({
  initial,
  providers = ["anthropic", "openai"],
  effectiveProvider,
  onValue,
}: {
  initial?: MediaModelGrant
  providers?: string[]
  effectiveProvider?: string
  onValue?: (next: MediaModelGrant | undefined) => void
}) {
  const [value, setValue] = useState<MediaModelGrant | undefined>(initial)
  return (
    <MediaGrantEditor
      value={value}
      onChange={(next) => {
        setValue(next)
        onValue?.(next)
      }}
      providers={providers}
      effectiveProvider={effectiveProvider}
      now={NOW}
    />
  )
}

it("starts off, with nothing to configure", () => {
  render(<Harness />)
  expect(screen.getByTestId("conv-override-media-grant")).not.toBeChecked()
  expect(screen.queryByTestId("media-grant-duration")).not.toBeInTheDocument()
})

/**
 * A grant with no providers is read by the resolver as no grant at all, so
 * switching on has to seed one — otherwise the switch says yes and nothing
 * changes.
 */
it("seeds the grant with the provider this conversation runs on", async () => {
  const user = userEvent.setup()
  const seen: Array<MediaModelGrant | undefined> = []
  render(<Harness effectiveProvider="openai" onValue={(v) => seen.push(v)} />)

  await user.click(screen.getByTestId("conv-override-media-grant"))

  expect(seen.at(-1)?.providers).toEqual(["openai"])
  expect(
    resolveMediaModelPolicy({
      adapter: {},
      override: { mediaModelGrant: seen.at(-1), providerOverride: "openai" },
      now: NOW,
    })
  ).toBe("allow_cloud_binary")
})

it("defaults to an expiry rather than a permanent grant", async () => {
  const user = userEvent.setup()
  const seen: Array<MediaModelGrant | undefined> = []
  render(<Harness effectiveProvider="anthropic" onValue={(v) => seen.push(v)} />)

  await user.click(screen.getByTestId("conv-override-media-grant"))
  expect(seen.at(-1)?.expiresAt).toBe(NOW + 24 * 3_600_000)
})

it("switching off revokes rather than leaving an inert grant behind", async () => {
  const user = userEvent.setup()
  const seen: Array<MediaModelGrant | undefined> = []
  render(
    <Harness
      initial={{ policy: "allow_cloud_binary", providers: ["anthropic"], grantedAt: NOW }}
      onValue={(v) => seen.push(v)}
    />
  )

  await user.click(screen.getByTestId("conv-override-media-grant"))
  expect(seen.at(-1)).toBeUndefined()
})

it("says so when the operator has deselected every provider", async () => {
  const user = userEvent.setup()
  render(
    <Harness initial={{ policy: "allow_cloud_binary", providers: ["anthropic"], grantedAt: NOW }} />
  )

  await user.click(screen.getByTestId("media-grant-provider-anthropic"))
  expect(screen.getByTestId("media-grant-empty")).toBeInTheDocument()
})

// An expired grant stays in the row — nothing sweeps it — so the screen has to
// distinguish "granted" from "was granted".
it("marks an expired grant instead of rendering it as in force", () => {
  render(
    <Harness
      initial={{
        policy: "allow_cloud_binary",
        providers: ["anthropic"],
        grantedAt: NOW - 48 * 3_600_000,
        expiresAt: NOW - 3_600_000,
      }}
    />
  )
  expect(screen.getByTestId("media-grant-expired")).toBeInTheDocument()
})

// A grant naming a provider that has since been removed from the catalogue
// still applies; hiding its row would leave it in the record and unrevocable.
it("keeps a granted provider visible after it leaves the catalogue", () => {
  render(
    <Harness
      providers={["anthropic"]}
      initial={{ policy: "allow_cloud_binary", providers: ["retired-vendor"], grantedAt: NOW }}
    />
  )
  expect(screen.getByTestId("media-grant-provider-retired-vendor")).toBeChecked()
})

it("re-stamps the grant when the duration changes", async () => {
  const user = userEvent.setup()
  const seen: Array<MediaModelGrant | undefined> = []
  render(
    <Harness
      initial={{
        policy: "allow_cloud_binary",
        providers: ["anthropic"],
        grantedAt: NOW - 100 * 3_600_000,
        expiresAt: NOW + 3_600_000,
      }}
      onValue={(v) => seen.push(v)}
    />
  )

  await user.click(screen.getByTestId("media-grant-duration"))
  await user.click(await screen.findByRole("option", { name: "duration_168" }))

  // "7 days" means seven days from this edit, not from a grant made last week.
  expect(seen.at(-1)?.grantedAt).toBe(NOW)
  expect(seen.at(-1)?.expiresAt).toBe(NOW + 168 * 3_600_000)
})

it("can drop the expiry entirely", async () => {
  const user = userEvent.setup()
  const seen: Array<MediaModelGrant | undefined> = []
  render(
    <Harness
      initial={{
        policy: "allow_cloud_binary",
        providers: ["anthropic"],
        grantedAt: NOW,
        expiresAt: NOW + 3_600_000,
      }}
      onValue={(v) => seen.push(v)}
    />
  )

  await user.click(screen.getByTestId("media-grant-duration"))
  await user.click(await screen.findByRole("option", { name: "duration_0" }))
  expect(seen.at(-1)?.expiresAt).toBeUndefined()
})

/**
 * Radix renders nothing when the value matches no item, so a stored span that
 * is not one of the presets used to leave the picker BLANK — which is exactly
 * what an expired grant looked like. Snapping it to the nearest preset would
 * misreport the deadline instead.
 */
it("reads out a stored duration that matches no preset", () => {
  render(
    <Harness
      initial={{
        policy: "allow_cloud_binary",
        providers: ["anthropic"],
        grantedAt: NOW - 48 * 3_600_000,
        expiresAt: NOW - 3_600_000,
      }}
    />
  )
  expect(screen.getByTestId("media-grant-duration")).toHaveTextContent(
    'duration_custom:{"hours":47}'
  )
})

it("shows a preset span as that preset, with no extra item", async () => {
  const user = userEvent.setup()
  render(
    <Harness
      initial={{
        policy: "allow_cloud_binary",
        providers: ["anthropic"],
        grantedAt: NOW,
        expiresAt: NOW + 24 * 3_600_000,
      }}
    />
  )
  expect(screen.getByTestId("media-grant-duration")).toHaveTextContent("duration_24")
  await user.click(screen.getByTestId("media-grant-duration"))
  expect(screen.queryByTestId("media-grant-duration-custom")).not.toBeInTheDocument()
})
