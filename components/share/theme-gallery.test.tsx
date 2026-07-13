import { render, screen, fireEvent } from "@testing-library/react"
import { ThemeGallery } from "./theme-gallery"
import { THEME_LIST } from "@/lib/export/html/syntax-themes"

describe("ThemeGallery", () => {
  it("renders a radio swatch for every theme", () => {
    render(<ThemeGallery value="arknights" onChange={() => {}} />)
    const group = screen.getByTestId("theme-gallery")
    expect(group).toHaveAttribute("role", "radiogroup")
    for (const th of THEME_LIST) {
      expect(screen.getByTestId(`theme-swatch-${th.id}`)).toBeInTheDocument()
    }
  })

  it("marks the selected swatch aria-checked and tabbable", () => {
    render(<ThemeGallery value="genshin" onChange={() => {}} />)
    const selected = screen.getByTestId("theme-swatch-genshin")
    expect(selected).toHaveAttribute("aria-checked", "true")
    expect(selected).toHaveAttribute("tabindex", "0")
    expect(screen.getByTestId("theme-swatch-arknights")).toHaveAttribute("aria-checked", "false")
  })

  it("calls onChange when a swatch is clicked", () => {
    const onChange = jest.fn()
    render(<ThemeGallery value="arknights" onChange={onChange} />)
    fireEvent.click(screen.getByTestId("theme-swatch-cyberpunk"))
    expect(onChange).toHaveBeenCalledWith("cyberpunk")
  })

  it("moves the selection with arrow keys", () => {
    const onChange = jest.fn()
    render(<ThemeGallery value={THEME_LIST[0].id} onChange={onChange} />)
    fireEvent.keyDown(screen.getByTestId(`theme-swatch-${THEME_LIST[0].id}`), { key: "ArrowRight" })
    expect(onChange).toHaveBeenCalledWith(THEME_LIST[1].id)
  })

  it("wraps to the last theme with ArrowLeft from the first", () => {
    const onChange = jest.fn()
    render(<ThemeGallery value={THEME_LIST[0].id} onChange={onChange} />)
    fireEvent.keyDown(screen.getByTestId(`theme-swatch-${THEME_LIST[0].id}`), { key: "ArrowLeft" })
    expect(onChange).toHaveBeenCalledWith(THEME_LIST[THEME_LIST.length - 1].id)
  })

  it("jumps to first/last with Home/End", () => {
    const onChange = jest.fn()
    render(<ThemeGallery value="light" onChange={onChange} />)
    fireEvent.keyDown(screen.getByTestId("theme-swatch-light"), { key: "End" })
    expect(onChange).toHaveBeenCalledWith(THEME_LIST[THEME_LIST.length - 1].id)
    fireEvent.keyDown(screen.getByTestId("theme-swatch-light"), { key: "Home" })
    expect(onChange).toHaveBeenCalledWith(THEME_LIST[0].id)
  })

  it("flags themes that ship a wallpaper", () => {
    render(<ThemeGallery value="arknights" onChange={() => {}} />)
    // arknights has a wallpaper badge; light (plain document theme) does not.
    expect(screen.getByTestId("theme-swatch-arknights").querySelector("svg")).not.toBeNull()
    expect(screen.getByTestId("theme-swatch-light").querySelector("svg")).toBeNull()
  })
})
