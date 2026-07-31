import { renderHook, waitFor } from "@testing-library/react"
import { usePetStore } from "@/stores/pet/pet-store"
import { useSettingsStore } from "@/stores/settings"
import { usePetCareAlert } from "./use-pet-care-alert"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const notifyBecameUnwell = jest.fn().mockResolvedValue(true)
jest.mock("@/lib/pet/care/notify-care", () => ({
  notifyBecameUnwell: (...args: unknown[]) => notifyBecameUnwell(...args),
}))

function setCareAlerts(value: boolean | undefined) {
  useSettingsStore.setState({
    settings: { petSettings: { careAlerts: value } } as never,
  })
}

beforeEach(() => {
  notifyBecameUnwell.mockClear()
  usePetStore.setState({ careAlert: null })
  setCareAlerts(undefined)
})

describe("usePetCareAlert", () => {
  it("fires the notification when a care alert appears and clears the signal", async () => {
    const { rerender } = renderHook(() => usePetCareAlert(true))
    usePetStore.setState({ careAlert: { at: 1, petName: "Pip" } })
    rerender()
    await waitFor(() => expect(usePetStore.getState().careAlert).toBeNull())
    expect(notifyBecameUnwell).toHaveBeenCalledTimes(1)
    expect(notifyBecameUnwell).toHaveBeenCalledWith({
      title: "care.unwell.title",
      body: "care.unwell.body",
    })
  })

  it("uses the no-name body when the pet is unhatched", async () => {
    const { rerender } = renderHook(() => usePetCareAlert(true))
    usePetStore.setState({ careAlert: { at: 2, petName: null } })
    rerender()
    await waitFor(() => expect(notifyBecameUnwell).toHaveBeenCalled())
    expect(notifyBecameUnwell).toHaveBeenCalledWith({
      title: "care.unwell.title",
      body: "care.unwell.bodyNoName",
    })
  })

  it("does nothing when disabled", () => {
    const { rerender } = renderHook(() => usePetCareAlert(false))
    usePetStore.setState({ careAlert: { at: 3, petName: "Pip" } })
    rerender()
    expect(notifyBecameUnwell).not.toHaveBeenCalled()
    expect(usePetStore.getState().careAlert).not.toBeNull()
  })

  it("drains the signal without notifying when careAlerts is off", async () => {
    setCareAlerts(false)
    const { rerender } = renderHook(() => usePetCareAlert(true))
    usePetStore.setState({ careAlert: { at: 4, petName: "Pip" } })
    rerender()
    await waitFor(() => expect(usePetStore.getState().careAlert).toBeNull())
    expect(notifyBecameUnwell).not.toHaveBeenCalled()
  })

  it("fires only once for the same alert across re-renders", async () => {
    const { rerender } = renderHook(() => usePetCareAlert(true))
    usePetStore.setState({ careAlert: { at: 5, petName: "Pip" } })
    rerender()
    await waitFor(() => expect(notifyBecameUnwell).toHaveBeenCalledTimes(1))
    // Re-set the same `at` — the handled guard prevents a second fire.
    usePetStore.setState({ careAlert: { at: 5, petName: "Pip" } })
    rerender()
    expect(notifyBecameUnwell).toHaveBeenCalledTimes(1)
  })
})
