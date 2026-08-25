---
"cognia-next": patch
---

Developer mode in the embedded browser now shows what it actually read back — the inspected document, or the value of an expression you type — instead of a fixed "completed" message that made it look like nothing had happened. It also stops offering Console, Network and Performance permissions: nothing behind them was ever implemented, and live console and network output already have their own panel.
