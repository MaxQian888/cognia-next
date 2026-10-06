# Cognia mobile spot icons

This folder contains 81 project-matched chibi anime feature illustrations: the
original 16 icons and 65 additions generated on 2026-09-27. The original assets
are preserved. Use these for feature cards, onboarding, and empty states at
48 px or larger; keep Lucide for compact 16–24 px controls.

`icon-manifest.json` maps all 59 mobile Me entries, 27 desktop navigation
entries, and 62 desktop settings sections to an appropriate illustration.
Related settings can share the same feature artwork. The 12 mobile home
shortcuts are also mapped in `lib/shell/mobile-home-nav.ts`, with dedicated
Inbox, Templates, Fleet, Servers, and Devices artwork.

All mobile Me entries and home shortcuts use the existing `MobileSpotIcon`
component. Desktop mappings document available shared artwork; they do not
replace the desktop rail's compact Lucide glyphs. Dynamic third-party plugin
icons, provider logos, and the separate agent-role avatar set retain their own
identity and are outside this feature-illustration inventory.

- `style-spec.json` freezes the palette and construction system for later custom batches.
- `icon-manifest.json` records assets and coverage mappings. `grid` and
  `position` describe only the original 4×4 sheet. Each icon's `source` is
  relative to `sourceRoot`, which is resolved from this manifest's directory.
- `generation-prompt.md` stores the original sheet prompt.
- `expansion-prompts.json` stores the shared prompt, individual subjects,
  reference, and built-in generation settings for the additions.
- `../../../assets/icons/cognia-mobile-spots/raw/cognia-chibi-companion.png` is the
  generated 4×4 source sheet.
- `../../../assets/icons/cognia-mobile-spots/raw/expansion/*.png` preserves the
  individual built-in image generation outputs.
- `png/*.png` are transparent runtime assets; new icons are 512×512.
- `webp/*.webp` contains lossless alternatives for the additions.
- `../../../assets/icons/cognia-mobile-spots/qa/contact-sheet-magenta.png` is the
  contrasting-background QA sheet. The same directory's `expanded-light.png`,
  `expanded-magenta.png`, and `expanded-dark-48.png` show all 81 icons.
- [Authoring preview](../../../assets/icons/cognia-mobile-spots/qa/index.html)
  previews the complete inventory on light, dark, and magenta
  backgrounds, with search and adjustable sizes.

Authoring files live outside `public/` so Next.js exports and PWA precaching
only receive runtime assets. Open the preview locally from the checkout; its
relative image paths point back to the PNG sources here. Preserve these source
PNGs because the sign-in icon generator also consumes them.

For additions, use `png/chat.png` as the shared identity/style reference and
generate one transparent image per feature. Preserve the palette, face,
hair, ear device, halo, pendant, and uniform. Resize without removing alpha;
never overwrite an existing approved asset just to extend the set.

The co-located `mobile-spot-icon.test.tsx` checks asset existence, manifest/name
parity, and complete coverage against the live navigation registries. Extend
those mappings whenever a new built-in entry is added.
