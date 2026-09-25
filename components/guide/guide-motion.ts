/**
 * The motion recipes every guide surface shares (ADR-0193).
 *
 * `/onboarding`, `/pair` and the in-app setup callouts each used to spell
 * their entrances out inline, and the copies drifted: the pairing window had
 * no entrance at all, and the scene and the step body swapped at different
 * speeds on the two screens. Naming the recipes once is what keeps "the same
 * kind of screen" moving the same way.
 *
 * **CSS, not `motion/react`** — the reason ADR-0141 gives for the scenes
 * applies to every piece of chrome here. `tw-animate-css` ships
 * `animation-fill-mode: none`, so an animation that never runs (a throttled
 * frame loop, a tab hidden at boot) leaves the element at its final styles
 * instead of stuck at an invisible first frame. The reduce-motion guards in
 * `globals.css` collapse every one of these to ~1ms, so none of them needs a
 * JS branch of its own.
 */

/** The full-window frame, once, when the flow mounts. */
export const GUIDE_SHELL_ENTER = "animate-in fade-in duration-300"

/** The step body. Keyed on the step, so only it replays on a transition. */
export const GUIDE_BODY_ENTER = "animate-in fade-in slide-in-from-bottom-2 duration-200"

/** The narrative scene. Keyed on the scene, crossfading between steps. */
export const GUIDE_SCENE_ENTER = "animate-in fade-in zoom-in-95 duration-300"

/** The panel's headline and body line. Keyed on the copy it shows. */
export const GUIDE_COPY_ENTER = "animate-in fade-in slide-in-from-bottom-1 duration-300"

/** An in-app callout (the finish-setup bar, a settings banner) arriving. */
export const GUIDE_CALLOUT_ENTER = "animate-in fade-in slide-in-from-top-1 duration-200"
