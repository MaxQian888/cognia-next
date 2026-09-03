---
"cognia-next": patch
---

A conversation that runs on an external agent the paired host owns can now choose which model it runs on. The model picker lists that agent's own catalog instead of standing empty, and the model and thinking level the composer shows are the ones the turn actually runs with. Until now the host lane carried no model at all, so every such turn silently ran on whatever the agent defaults to while the chip promised something else.
