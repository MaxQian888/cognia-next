---
"cognia-next": minor
---

The browser side panel now stays in the same theme as Cognia. Changing your theme in the app repaints an already-open panel within a poll, instead of only when it is closed and reopened, and the same signal refreshes the workspaces and delivery targets it offers. A Host set to follow the system theme is handled honestly for the first time: it cannot see the browser's system theme, so it says so and the panel answers with what it resolved — previously that setting was read as dark for everyone, including people whose system is light.

The panel also gains its own appearance choice — match Cognia, always light, or always dark — remembered per browser. The Host re-resolves its palette in the chosen mode rather than the panel flipping a class over it, because the custom properties underneath are a palette only the Host can build; flipping locally would paint a light layout in dark colours.

The submission list now carries a short digest of everything the capability call would answer, which is what makes the live refresh cost one string per poll instead of a palette. It replaces a pagination cursor that was in the contract but that nothing ever produced.
