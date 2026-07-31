"""Cognia hybrid plugin Python backend template.

The desktop host imports this file from the manifest's ``pythonMain`` field.
The frontend entry in ``frontend/index.js`` is activated separately and the
hybrid loader coordinates both runtimes.
"""

from __future__ import annotations

from typing import Any

from cognia import tool, log


@tool(
    name="template_echo",
    description="Echo the supplied message back to the agent from Python.",
    parameters={
        "type": "object",
        "properties": {
            "message": {
                "type": "string",
                "description": "The message to echo.",
            }
        },
        "required": ["message"],
        "additionalProperties": False,
    },
)
def template_echo(message: str) -> dict[str, Any]:
    """Return a JSON-serializable echo payload from the Python side."""

    text = message if isinstance(message, str) else str(message)
    log("hybrid template_echo called")
    return {"ok": True, "runtime": "python", "echoed": text}
