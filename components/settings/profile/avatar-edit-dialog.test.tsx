/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
}))

jest.mock("sonner", () => ({
  toast: { error: jest.fn() },
}))

// Replace the radix Slider with a plain range input so we can drive
// onValueChange deterministically without layout/pointer geometry.
jest.mock("@/components/ui/slider", () => ({
  Slider: ({
    value,
    onValueChange,
    disabled,
  }: {
    value: number[]
    onValueChange: (v: number[]) => void
    disabled?: boolean
  }) => (
    <input
      type="range"
      data-testid="avatar-edit-zoom"
      disabled={disabled}
      value={value[0]}
      onChange={(e) => onValueChange([Number(e.target.value)])}
    />
  ),
}))

jest.mock("@/lib/profile/avatar-image", () => ({
  encodeAvatarRegion: jest.fn(() => "data:image/webp;base64,ZZ"),
}))

import { toast } from "sonner"
import { encodeAvatarRegion } from "@/lib/profile/avatar-image"

import { AvatarEditDialog } from "./avatar-edit-dialog"

const mockEncode = encodeAvatarRegion as jest.Mock
const mockToastError = (toast as unknown as { error: jest.Mock }).error

beforeAll(() => {
  if (!URL.createObjectURL) {
    Object.defineProperty(URL, "createObjectURL", { value: () => "blob:mock", writable: true })
  }
  if (!URL.revokeObjectURL) {
    Object.defineProperty(URL, "revokeObjectURL", { value: () => undefined, writable: true })
  }
})

beforeEach(() => {
  jest.clearAllMocks()
  mockEncode.mockReturnValue("data:image/webp;base64,ZZ")
})

const pngFile = () => new File([new Uint8Array([1])], "a.png", { type: "image/png" })

const renderDialog = (overrides: Partial<React.ComponentProps<typeof AvatarEditDialog>> = {}) => {
  const onCancel = jest.fn()
  const onConfirm = jest.fn().mockResolvedValue(undefined)
  render(
    <AvatarEditDialog file={pngFile()} onCancel={onCancel} onConfirm={onConfirm} {...overrides} />
  )
  return { onCancel, onConfirm }
}

/** Fire the preview <img> load event with the given intrinsic dimensions. */
const loadImage = (w: number, h: number) => {
  const img = screen.getByTestId("avatar-edit-image") as HTMLImageElement
  Object.defineProperty(img, "naturalWidth", { value: w, configurable: true })
  Object.defineProperty(img, "naturalHeight", { value: h, configurable: true })
  fireEvent.load(img)
  return img
}

const clickSave = async () => {
  await act(async () => {
    fireEvent.click(screen.getByTestId("avatar-edit-save"))
  })
}

// jsdom here has no `PointerEvent`, so `fireEvent.pointerXxx` drops clientX.
// Dispatch real MouseEvents typed as pointer events (with a pointerId) — React
// reads coordinates from the native event reliably.
const drag = async (fromX: number, toX: number, y = 100) => {
  const viewport = screen.getByTestId("avatar-edit-viewport")
  const make = (type: string, x: number) => {
    const ev = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true })
    Object.assign(ev, { pointerId: 1 })
    return ev
  }
  await act(async () => {
    viewport.dispatchEvent(make("pointerdown", fromX))
    viewport.dispatchEvent(make("pointermove", toX))
    viewport.dispatchEvent(make("pointerup", toX))
  })
}

describe("AvatarEditDialog", () => {
  it("renders nothing when no file is provided", () => {
    render(<AvatarEditDialog file={null} onCancel={() => {}} onConfirm={() => {}} />)
    expect(screen.queryByTestId("avatar-edit-dialog")).not.toBeInTheDocument()
  })

  it("disables save until the image has loaded", () => {
    renderDialog()
    expect(screen.getByTestId("avatar-edit-save")).toBeDisabled()
    expect(screen.getByTestId("avatar-edit-zoom")).toBeDisabled()
  })

  it("center-crops a wide image to a square region on save", async () => {
    const { onConfirm } = renderDialog()
    loadImage(512, 256) // base=1, centered offset.x = -128
    await clickSave()
    expect(mockEncode).toHaveBeenCalledWith(expect.anything(), { sx: 128, sy: 0, size: 256 })
    expect(onConfirm).toHaveBeenCalledWith("data:image/webp;base64,ZZ")
  })

  it("center-crops a tall image to a square region on save", async () => {
    renderDialog()
    loadImage(256, 512) // centered offset.y = -128
    await clickSave()
    expect(mockEncode).toHaveBeenCalledWith(expect.anything(), { sx: 0, sy: 128, size: 256 })
  })

  it("zooms around the viewport center and shrinks the crop region", async () => {
    renderDialog()
    loadImage(256, 256) // square, offset (0,0)
    fireEvent.change(screen.getByTestId("avatar-edit-zoom"), { target: { value: "2" } })
    await clickSave()
    // scale 2 → size 128, recentred crop at (64,64).
    expect(mockEncode).toHaveBeenCalledWith(expect.anything(), { sx: 64, sy: 64, size: 128 })
  })

  it("pans the crop region when the viewport is dragged", async () => {
    renderDialog()
    loadImage(512, 256) // offset.x = -128, room to pan in x
    await drag(100, 150) // dx = +50 → offset.x = -78 → sx = 78
    await clickSave()
    expect(mockEncode).toHaveBeenCalledWith(expect.anything(), { sx: 78, sy: 0, size: 256 })
  })

  it("clamps panning so the viewport stays covered", async () => {
    renderDialog()
    loadImage(512, 256)
    await drag(0, 500) // over-drag right clamps offset.x to 0 → sx = 0
    await clickSave()
    expect(mockEncode).toHaveBeenCalledWith(expect.anything(), { sx: 0, sy: 0, size: 256 })
  })

  it("ignores pointer/zoom interaction before the image loads", () => {
    renderDialog()
    const viewport = screen.getByTestId("avatar-edit-viewport")
    // No natural dimensions yet — these must be no-ops, not throws.
    fireEvent.pointerDown(viewport, { clientX: 10, clientY: 10, pointerId: 1 })
    fireEvent.pointerMove(viewport, { clientX: 20, clientY: 20, pointerId: 1 })
    fireEvent.change(screen.getByTestId("avatar-edit-zoom"), { target: { value: "2" } })
    expect(screen.getByTestId("avatar-edit-dialog")).toBeInTheDocument()
  })

  it("ignores a pointer move that has no active drag", () => {
    renderDialog()
    loadImage(256, 256)
    const viewport = screen.getByTestId("avatar-edit-viewport")
    // Move without a preceding pointer-down: dragRef is null.
    fireEvent.pointerMove(viewport, { clientX: 50, clientY: 50, pointerId: 1 })
    expect(screen.getByTestId("avatar-edit-dialog")).toBeInTheDocument()
  })

  it("cancels via the cancel button", () => {
    const { onCancel } = renderDialog()
    loadImage(256, 256)
    fireEvent.click(screen.getByTestId("avatar-edit-cancel"))
    expect(onCancel).toHaveBeenCalled()
  })

  it("aborts with a toast when the image has zero dimensions", () => {
    const { onCancel } = renderDialog()
    loadImage(0, 0)
    expect(mockToastError).toHaveBeenCalledWith("avatarProcessFailed")
    expect(onCancel).toHaveBeenCalled()
  })

  it("toasts and keeps the dialog open when encoding fails", async () => {
    mockEncode.mockImplementation(() => {
      throw new Error("avatar image too large after downscale")
    })
    const { onConfirm } = renderDialog()
    loadImage(256, 256)
    await clickSave()
    expect(mockToastError).toHaveBeenCalledWith("avatarProcessFailed")
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it("blocks closing while saving, then settles", async () => {
    let release!: () => void
    const onConfirm = jest.fn(() => new Promise<void>((r) => (release = r)))
    const onCancel = jest.fn()
    render(<AvatarEditDialog file={pngFile()} onCancel={onCancel} onConfirm={onConfirm} />)
    loadImage(256, 256)
    await clickSave()
    // Mid-save: both actions disabled and Escape is swallowed.
    expect(screen.getByTestId("avatar-edit-save")).toBeDisabled()
    expect(screen.getByTestId("avatar-edit-cancel")).toBeDisabled()
    fireEvent.keyDown(document, { key: "Escape" })
    expect(onCancel).not.toHaveBeenCalled()
    await act(async () => {
      release()
    })
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1))
  })

  it("requests close on Escape when idle", async () => {
    const { onCancel } = renderDialog()
    loadImage(256, 256)
    fireEvent.keyDown(document, { key: "Escape" })
    await waitFor(() => expect(onCancel).toHaveBeenCalled())
  })
})
