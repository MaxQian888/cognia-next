"""Cognia Python plugin template.

The desktop host injects the ``cognia`` module before importing this file.
For local type checking and tests, use the Python SDK under
``plugin-sdk/python`` from the cognia-next repository.
"""

from __future__ import annotations

from typing import Any

from cognia import tool, log


@tool(
    name="template_echo",
    description="Echo the supplied message back to the agent.",
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
    """Return a small JSON-serializable echo payload."""

    text = message if isinstance(message, str) else str(message)
    log("template_echo called")
    return {"ok": True, "echoed": text}
