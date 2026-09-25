import {
  GUIDE_BODY_ENTER,
  GUIDE_CALLOUT_ENTER,
  GUIDE_COPY_ENTER,
  GUIDE_SCENE_ENTER,
  GUIDE_SHELL_ENTER,
} from "./guide-motion"

const RECIPES = {
  GUIDE_SHELL_ENTER,
  GUIDE_BODY_ENTER,
  GUIDE_SCENE_ENTER,
  GUIDE_COPY_ENTER,
  GUIDE_CALLOUT_ENTER,
}

describe("guide motion recipes", () => {
  it.each(Object.entries(RECIPES))("%s is a CSS entrance, not a JS-driven one", (_, recipe) => {
    // `tw-animate-css` entrances degrade to the element's final styles when
    // they never run; a JS `initial={{ opacity: 0 }}` would degrade to blank.
    expect(recipe).toMatch(/\banimate-in\b/)
    expect(recipe).toMatch(/\bfade-in\b/)
    expect(recipe).toMatch(/\bduration-\d+\b/)
  })

  it("never holds a start frame on its own, so a reduce-motion run cannot sit blank", () => {
    // A delay is not covered by the 1ms duration clamp in globals.css; the
    // chrome recipes must not carry one (the staggered scene parts gate theirs
    // behind the reduce-motion verdict instead).
    for (const recipe of Object.values(RECIPES)) {
      expect(recipe).not.toMatch(/\bdelay-/)
      expect(recipe).not.toMatch(/fill-mode-(backwards|both)/)
    }
  })

  it("keeps the step body quicker than the scene, so content never waits on the picture", () => {
    const ms = (recipe: string) => Number(/duration-(\d+)/.exec(recipe)?.[1])
    expect(ms(GUIDE_BODY_ENTER)).toBeLessThan(ms(GUIDE_SCENE_ENTER))
  })
})
