# Brand marks not in the LobeHub set

`components/icons/brand-icon.tsx` draws vendor marks from `../lobe/` (the
LobeHub static SVG set). Marks that set does not carry live here, using the
vendor's original format.

| File                | Source                                                                                                                                                                                         | License         | Changes                                                              |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | -------------------------------------------------------------------- |
| `feishu-color.svg`  | [IconPark](https://github.com/bytedance/IconPark) `new-lark` (ByteDance)                                                                                                                       | Apache-2.0      | Strokes and fill recoloured with Feishu's brand teal, blue and navy. |
| `aider-color.png`   | [Aider website favicon](https://aider.chat/assets/icons/favicon-32x32.png), also in [Aider-AI/aider](https://github.com/Aider-AI/aider/blob/main/aider/website/assets/icons/favicon-32x32.png) | Apache-2.0      | None.                                                                |
| `factory-color.svg` | [Factory website favicon](https://factory.com/favicon.svg)                                                                                                                                     | Vendor branding | None.                                                                |

Keep the `-color` suffix on multicolour marks and vendor tiles with their own
background: `brandIconAsset()` treats any other name as monochrome and inverts
it on dark surfaces.
