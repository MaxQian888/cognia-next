---
format: 1920x1080
message: "One task, end to end, in the real workspace — and it stops for you before anything leaves the machine."
arc: Promise → Evidence (request · context · reproduce · plan · fix · verify · notes) → The halt → Sign-off
audience: developers evaluating Cognia on its official website
mode: collaborative
---

## Frame 1 — Open: one task, end to end

- composition: product-film
- scene: The app's icon and the promise on the dark stage; the task's identity in mono beneath
- duration: 4s
- poster: 2.6s
- transition_in: cut
- status: built
- src: compositions/frames/01-open.html
- motion: titlecard-reveal (one restrained slide-up crossfade, then hold) · svg-path-draw (the cyan index rule draws under the title)
- copy_en: "One task, end to end." / "acme/checkout-service · release/2.4.0 · unit-tests failing"
- copy_zh: "一条任务，从头到尾。" / "acme/checkout-service · release/2.4.0 · unit-tests 未通过"

Value first: the viewer learns the film is a single real task, not a feature tour. The icon is
the product's own mark at mark size, left of the title — not a hero illustration.

## Frame 2 — Request

- composition: product-film
- scene: The real workbench fades up framed on the stage; the user's one-line request lands
- duration: 1.8s (footage 0 → context beat)
- transition_in: crossfade
- status: built
- src: compositions/frames/02-request.html
- motion: device-surface-showcase (floating window held as hero) · multi-phase-camera (settle from 0.94 to 1.0)
- callout: "01 · REQUEST" — en "One sentence starts the task." / zh "一句话开始任务。"

The recording plays unchanged underneath every footage frame; only the camera and the callout
plate move.

## Frame 3 — Context

- composition: product-film
- scene: Camera eases onto the agent's first line and the two Read rows (AGENTS.md, total.ts)
- duration: ~3.5s (context → reproduce beat)
- transition_in: cut
- status: built
- src: compositions/frames/03-context.html
- motion: coordinate-target-zoom (to the thread's tool group, 1.25×)
- callout: "02 · CONTEXT" — en "It reads the project before it proposes anything." / zh "先读项目，再提方案。"

## Frame 4 — Reproduce

- composition: product-film
- scene: Push into the failing test output — `✗ rounds JPY totals to whole yen`
- duration: ~5.2s
- transition_in: cut
- status: built
- src: compositions/frames/04-reproduce.html
- motion: coordinate-target-zoom (1.45× on the error block) · depth-of-field-blur (thread around it dims)
- callout: "03 · REPRODUCE" — en "The failing check, reproduced first." / zh "先把失败的检查复现出来。"

## Frame 5 — Plan

- composition: product-film
- scene: The camera follows the thread down onto the plan card as it opens
- duration: ~3.2s
- transition_in: cut
- status: built
- src: compositions/frames/05-plan.html
- motion: viewport-change (vertical pan with focus-lock on the plan card)
- callout: "04 · PLAN" — en "A plan you can read before a file changes." / zh "改动之前，先给你看计划。"

## Frame 6 — Fix

- composition: product-film
- scene: Tight on the Edit card: the red and green diff lines of `src/checkout/total.ts`
- duration: ~4.3s
- transition_in: cut
- status: built
- src: compositions/frames/06-fix.html
- motion: coordinate-target-zoom (1.6× on the diff, the film's closest shot)
- callout: "05 · FIX" — en "The change arrives as a diff, not a claim." / zh "改动以 diff 呈现，而不是一句声明。"

## Frame 7 — Verify

- composition: product-film
- scene: The same check re-runs; `Tests 3 passed (3)`
- duration: ~4.1s
- transition_in: cut
- status: built
- src: compositions/frames/07-verify.html
- motion: multi-phase-camera (pull back half a step, then a slow push onto the passing output)
- callout: "06 · VERIFY" — en "The check that failed now passes." / zh "刚才失败的检查，现在通过了。"

## Frame 8 — Notes

- composition: product-film
- scene: The workspace dock slides open on the right; the camera pans across to `launch-notes.md`
- duration: ~3.5s
- transition_in: cut
- status: built
- src: compositions/frames/08-notes.html
- motion: viewport-change (lateral pan onto the artifact panel)
- callout: "07 · NOTES" — en "The result is a file you keep." / zh "结果是一份留得住的文件。"

## Frame 9 — The halt

- composition: product-film
- scene: The real approval dialog for `git push origin release/2.4.0`; the camera settles wide and holds
- duration: ~7.1s (approval beat → footage end)
- poster: 4s
- transition_in: cut
- status: built
- src: compositions/frames/09-approval.html
- motion: multi-phase-camera (pull back to 1.05× and hold) · ambient-glow-bloom is NOT used — the amber is a 2px rule and a dot on the callout, nothing more
- callout: "08 · APPROVAL" (amber) — en "Anything that leaves the machine waits for you." / zh "任何离开这台机器的操作，都会停下来等你。"

The argument of the whole film. The longest hold, and the only amber.

## Frame 10 — Sign-off

- composition: product-film
- scene: The footage recedes; the icon and the site's promise lock up with the source route
- duration: 6s
- poster: 3.5s
- transition_in: crossfade
- status: built
- src: compositions/frames/10-close.html
- motion: logo-assemble-lockup (restrained: the lockup builds from the index rule outward) · titlecard-reveal
- copy_en: "Your open workspace for AI agents." / "Open source · Build from source" / "github.com/MaxQian888/cognia-next"
- copy_zh: "你的开放 AI Agent 工作空间。" / "开源 · 从源码构建" / "github.com/MaxQian888/cognia-next"

Reuses the website's own hero line so the film and the page it lives on say the same thing.

## Frame 11 — Hero loop: the halt (seam)

- composition: hero-loop
- scene: Opens on the approval end state, which is also the last frame — the loop seam
- duration: 0.8s (dissolve into frame 12)
- transition_in: cut
- status: built
- src: compositions/frames/11-hero-seam.html
- motion: crossfade only; the camera scale here equals the last frame's scale

## Frame 12 — Hero loop: failing check

- composition: hero-loop
- scene: The failing JPY test output, slow push-in
- duration: 2.6s
- transition_in: crossfade
- status: built
- src: compositions/frames/12-hero-reproduce.html
- motion: multi-phase-camera (continuous slow push, 1.00 → 1.06)

## Frame 13 — Hero loop: diff and pass

- composition: hero-loop
- scene: The diff lands, then the re-run passes
- duration: 3.4s
- transition_in: crossfade
- status: built
- src: compositions/frames/13-hero-fix.html
- motion: multi-phase-camera (push continues, 1.06 → 1.12)

## Frame 14 — Hero loop: the halt

- composition: hero-loop
- scene: Notes land and the approval dialog opens; hold until the loop point
- duration: 3.2s
- transition_in: crossfade
- status: built
- src: compositions/frames/14-hero-halt.html
- motion: multi-phase-camera (settle and hold at the seam scale)

No text in the hero loop: it plays beside the homepage headline, which carries the words.
