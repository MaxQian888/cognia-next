import { describe, expect, it } from "vitest"

import { MASCOT_MOODS, mascotSvg } from "./mascot"

describe("sign-in mascot", () => {
  it("draws one standalone, decorative SVG per mood", () => {
    for (const mood of MASCOT_MOODS) {
      const svg = mascotSvg(mood)
      expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160"')).toBe(
        true
      )
      expect(svg).toContain('aria-hidden="true"')
      expect(svg.endsWith("</svg>")).toBe(true)
    }
    expect(new Set(MASCOT_MOODS.map(mascotSvg)).size).toBe(MASCOT_MOODS.length)
  })

  it("needs nothing the pages' CSP would block: no style, script, link or id", () => {
    for (const mood of MASCOT_MOODS) {
      const svg = mascotSvg(mood)
      expect(svg).not.toMatch(/<style|<script|style=|href=|\son[a-z]+=|\sid=/)
    }
  })

  it("only loops the waiting dots; every other motion stops on its own", () => {
    for (const mood of MASCOT_MOODS) {
      const loops = mascotSvg(mood).match(/repeatCount="indefinite"/g) ?? []
      expect(loops.length).toBe(mood === "thinking" ? 3 : 0)
    }
  })

  it("tells success from failure at a glance, not by colour alone", () => {
    // A check mark on the happy badge, an exclamation mark on the worried one.
    expect(mascotSvg("happy")).toContain("l5 5 9-10")
    expect(mascotSvg("worried")).toContain('<circle cx="134" cy="143" r="2" fill="#fff"/>')
  })
})
