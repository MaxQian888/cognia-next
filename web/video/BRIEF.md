---
workflow: general-video
flow: automation
storyboard: yes
message: "One task, end to end, in the real workspace — and it stops for you before anything leaves the machine."
destination: website
aspect: 1920x1080
language: en, zh
length: 44s film + 10s hero loop
audience: developers evaluating Cognia on its official website
---

## Intent

Two videos for the official website (ADR-0092, product footage amendment), both cut from
real recordings of the Cognia app running the site's one demo task (`acme/checkout-service`,
release 2.4.0: reproduce the failing JPY rounding check, fix it, re-run it, draft launch notes,
halt on `git push` for approval).

- **Hero loop** — 10s, 1600×1000, silent, seamless loop behind the homepage headline. A slow
  push-in on the real workbench, no text overlays: the page's headline carries the words.
- **Product film** — about 44s, 1920×1080, English and Chinese. Camera zooms follow the
  recorded beat timestamps; one mono callout per beat; designed opening and closing title
  cards. Plays on click in its own homepage section, with captions.

The film ends held on the real approval dialog. The halt is the argument.

## Assets

- `recordings/<locale>.mp4` + `recordings/timing.js` — the product footage and its per-locale
  beat times, produced by `web/scripts/record-product.mjs` (git-ignored intermediates; re-record
  instead of editing).
- `assets/brand/cognia-icon-512.png` — the app's own icon (the silver-haired AI companion), from
  `public/icons/icon-512.png`. The film's opening and closing mark, at mark size.
- `assets/fonts/` — Geist Sans and Geist Mono from the `geist` package the website already uses.

## Customizations

- No sound. A light music bed was planned for the film, but the library it would come from
  (HeyGen's) needs a sign-in the user chose not to complete, so both films ship silent; the
  on-screen callouts and the caption track carry every beat. The website still never
  autoplays the film: it starts on the reader's click.
- A WebVTT caption track per locale, generated from the same beat callouts.

## Notes

- Design source is `web/DESIGN.md` ("The Precision Workbench"), mirrored for this project in
  `frame.md`: ink stage `#0C1115`, graphite panels `#151B20`, paper text `#F3F1EC`, cyan
  `#35CEDD` only as lines, dots and focus, amber `#D99A3D` only on the approval beat. No
  gradients, glows or aurora backgrounds (the site's No AI Gradient Rule).
- Every frame of product UI is the real application. Provenance is on screen throughout the
  footage: "Recorded in Cognia · demo data".
- Chinese type falls back to the system CJK face (PingFang SC on the rendering Mac); Geist has
  no CJK glyphs.
