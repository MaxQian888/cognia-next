/**
 * @jest-environment jsdom
 */

import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { DEFAULT_GLANCE_PANEL_SETTINGS } from "@/lib/glance/presets"
import type { GlanceRequestBody } from "@/lib/glance/requests"
import {
  GLANCE_SNAPSHOT_VERSION,
  type GlancePetSlice,
  type GlanceSnapshotV1,
} from "@/lib/glance/snapshot"

import { GlanceProvider, type GlanceContextValue } from "../glance-context"
import { GlancePetModule } from "./glance-pet-module"

const NOW = 1_700_000_000_000

function makePet(overrides: Partial<GlancePetSlice> = {}): GlancePetSlice {
  return {
    updatedAt: NOW,
    enabled: true,
    mood: "happy",
    condition: "well",
    energy: 64,
    moodLevel: 82,
    bond: 20,
    ...overrides,
  }
}

function makeSnapshot(pet: GlancePetSlice | null): GlanceSnapshotV1 {
  return {
    version: GLANCE_SNAPSHOT_VERSION,
    epoch: 1,
    revision: 1,
    generatedAt: NOW,
    config: DEFAULT_GLANCE_PANEL_SETTINGS,
    workspace: null,
    when: {} as GlanceSnapshotV1["when"],
    actions: [],
    fleet: null,
    usage: null,
    quota: null,
    agenda: null,
    activity: null,
    recents: null,
    pet,
  }
}

function setup(
  pet: GlancePetSlice | null,
  size: "compact" | "standard" = "standard",
  sendImpl?: (body: GlanceRequestBody) => Promise<string | null>
) {
  const route = jest.fn<void, [GlanceRequestBody]>()
  const send = jest.fn<Promise<string | null>, [GlanceRequestBody]>(sendImpl ?? (async () => null))
  const value: GlanceContextValue = {
    snapshot: makeSnapshot(pet),
    platform: "desktop",
    width: "standard",
    now: NOW,
    send,
    route,
  }
  const utils = render(
    <GlanceProvider value={value}>
      <GlancePetModule size={size} />
    </GlanceProvider>
  )
  return { ...utils, route, send, user: userEvent.setup() }
}

describe("GlancePetModule", () => {
  it("shows a loading line, still routable to the pet page, while the slice is null", async () => {
    const { route, user } = setup(null)
    expect(screen.getByText("Reading the pet…")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Open pet" }))
    expect(route).toHaveBeenCalledWith({ kind: "open-owner", owner: "pet" })
  })

  it("says the pet is off when disabled and offers no care buttons", () => {
    setup(makePet({ enabled: false }))
    expect(screen.getByText("The pet is turned off")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Feed" })).not.toBeInTheDocument()
  })

  describe("compact", () => {
    it("shows the mood and the short needs line", () => {
      setup(makePet(), "compact")
      expect(screen.getByText("Happy")).toBeInTheDocument()
      expect(screen.getByText("Mood 82% · energy 64%")).toBeInTheDocument()
      expect(screen.queryByRole("button", { name: "Feed" })).not.toBeInTheDocument()
    })

    it("shows the unwell condition instead of the mood", () => {
      setup(makePet({ condition: "unwell", mood: "tired" }), "compact")
      expect(screen.getByText("Not feeling well")).toBeInTheDocument()
      expect(screen.queryByText("Tired")).not.toBeInTheDocument()
    })

    it("routes to the pet page", async () => {
      const { route, user } = setup(makePet(), "compact")
      await user.click(screen.getByRole("button", { name: "Open pet" }))
      expect(route).toHaveBeenCalledWith({ kind: "open-owner", owner: "pet" })
    })

    it("renders no mood text when the mood is unknown", () => {
      setup(makePet({ mood: null, condition: null }), "compact")
      expect(screen.getByText("Mood 82% · energy 64%")).toBeInTheDocument()
    })
  })

  describe("standard", () => {
    it("shows mood, energy and bond meters", () => {
      setup(makePet())
      expect(screen.getByRole("meter", { name: "Mood" })).toHaveAttribute("aria-valuenow", "82")
      expect(screen.getByRole("meter", { name: "Energy" })).toHaveAttribute("aria-valuenow", "64")
      expect(screen.getByRole("meter", { name: "Bond" })).toHaveAttribute("aria-valuenow", "20")
      expect(screen.getByText("82%")).toBeInTheDocument()
    })

    it("shows the mood in the header and swaps in the unwell condition", () => {
      const { unmount } = setup(makePet())
      const section = screen.getByRole("region", { name: "Pet" })
      expect(within(section).getByText("Happy")).toBeInTheDocument()
      unmount()
      setup(makePet({ condition: "unwell" }))
      expect(screen.getByText("Not feeling well")).toBeInTheDocument()
    })

    it("opens the pet page from the header link", async () => {
      const { route, user } = setup(makePet())
      await user.click(screen.getByRole("button", { name: "Open pet" }))
      expect(route).toHaveBeenCalledWith({ kind: "open-owner", owner: "pet" })
    })

    it.each([
      ["Feed", "pet.feed"],
      ["Play", "pet.play"],
      ["Sleep", "pet.sleep"],
    ] as const)("sends pet-care for %s", async (label, command) => {
      const { send, route, user } = setup(makePet())
      await user.click(screen.getByRole("button", { name: label }))
      expect(send).toHaveBeenCalledWith({ kind: "pet-care", command })
      // Care runs in place: it does not route anywhere (the panel stays open).
      expect(route).not.toHaveBeenCalled()
    })

    it("disables every care button while a command is pending, then re-enables", async () => {
      let resolve!: (value: string | null) => void
      const pending = new Promise<string | null>((r) => {
        resolve = r
      })
      const { send, user } = setup(makePet(), "standard", () => pending)
      await user.click(screen.getByRole("button", { name: "Feed" }))
      for (const label of ["Feed", "Play", "Sleep"]) {
        expect(screen.getByRole("button", { name: label })).toBeDisabled()
      }
      // A second click while pending is ignored.
      await user.click(screen.getByRole("button", { name: "Play" }))
      expect(send).toHaveBeenCalledTimes(1)

      await act(async () => {
        resolve(null)
      })
      await waitFor(() => expect(screen.getByRole("button", { name: "Feed" })).toBeEnabled())
      expect(screen.getByRole("button", { name: "Play" })).toBeEnabled()
      expect(screen.queryByText("That didn't work. Try again.")).not.toBeInTheDocument()
    })

    it("shows the failure message when send resolves an error key", async () => {
      const { user } = setup(makePet(), "standard", async () => "errors.commandUnavailable")
      await user.click(screen.getByRole("button", { name: "Feed" }))
      expect(await screen.findByText("That didn't work. Try again.")).toBeInTheDocument()
      expect(screen.getByRole("button", { name: "Feed" })).toBeEnabled()
    })

    it("clears the failure message when the next command is sent", async () => {
      const send = jest
        .fn<Promise<string | null>, [GlanceRequestBody]>()
        .mockResolvedValueOnce("errors.requestFailed")
        .mockResolvedValueOnce(null)
      const { user } = setup(makePet(), "standard", send)
      await user.click(screen.getByRole("button", { name: "Feed" }))
      await screen.findByText("That didn't work. Try again.")
      await user.click(screen.getByRole("button", { name: "Play" }))
      await waitFor(() =>
        expect(screen.queryByText("That didn't work. Try again.")).not.toBeInTheDocument()
      )
      expect(send).toHaveBeenLastCalledWith({ kind: "pet-care", command: "pet.play" })
    })

    it("uses a warn meter for a low need", () => {
      setup(makePet({ energy: 10 }))
      expect(screen.getByRole("meter", { name: "Energy" }).firstElementChild).toHaveClass(
        "bg-warning"
      )
      expect(screen.getByRole("meter", { name: "Mood" }).firstElementChild).not.toHaveClass(
        "bg-warning"
      )
    })
  })
})
