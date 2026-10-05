# Brand marks not in the LobeHub set

`components/icons/brand-icon.tsx` draws vendor marks from `../lobe/` (the
LobeHub static SVG set). Marks that set does not carry live here.

| File               | Source                                                                   | License    | Changes                                                              |
| ------------------ | ------------------------------------------------------------------------ | ---------- | -------------------------------------------------------------------- |
| `feishu-color.svg` | [IconPark](https://github.com/bytedance/IconPark) `new-lark` (ByteDance) | Apache-2.0 | Strokes and fill recoloured with Feishu's brand teal, blue and navy. |

Keep the `-color` suffix on multicolour marks: `brandIconAsset()` treats any
other name as monochrome and inverts it on dark surfaces.
