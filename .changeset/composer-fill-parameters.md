---
"cognia-next": minor
---

`{{parameter}}` chips in the composer can now be filled in. Click one and a small editor opens over the composer; type a value and the chip fills in. Tab walks from one parameter to the next, and Escape or Enter closes the editor. The values are saved with the draft, so a reload brings back a half-filled message exactly as you left it — the tokens are read back out of the text and their values off the draft, so nothing depends on remembering where in the sentence they were.

The editor never steals the caret when it opens, and it only opens on a deliberate click or Tab — arrowing past a parameter leaves you alone. Tab keeps its normal job of moving focus out of the composer whenever the message has no parameters in it. Breaking a token by editing it demotes the chip back to ordinary text and drops the value with it, so retyping the parameter later starts clean.
