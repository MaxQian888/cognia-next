---
"cognia-next": patch
---

Form controls stop clipping their own text. The global rule that keeps iOS from zooming in on a focused field -- `font-size: max(16px, 1rem)` on every native input, textarea and select -- is unlayered, so it outranked every Tailwind `text-*` class and repainted the whole app at 16px, the desktop shell included, defeating shadcn's own `text-base md:text-sm` split. It is now gated behind a coarse pointer, which is the only shell that zooms. Where it does apply the enforced size needs somewhere to live: a `select` clips its selected option at the content box whatever `overflow` says, so an `h-8` control with `py-2` left 14px of box for a ~21px line box and every label lost its descenders. The same block pins the line box and adds a height floor, which a call site can still opt out of through `--touch-control-min-h`.

`Input` and `NativeSelect` drop the vertical padding that bought nothing on a single-line control and only narrowed the room the text had -- at `h-7` the old `py-1` left an 18px content box for a 20px line box. `InputGroup`'s stacked alignments were the one layout that read that padding for its inner edge, so they now name both edges themselves rather than inheriting one from a base they never mentioned.
