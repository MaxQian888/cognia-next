---
"cognia-next": patch
---

Template inputs are now actually substituted into the resource they create. A template that parameterised a name with `{{inputId}}` validated, collected a value, and then created a resource containing the literal token.
