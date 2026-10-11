"""Glance modules from a Python plugin (ADR-0225 §6).

A plugin contributes a module to the desktop tray panel and the phone's
Glance drawer as **data**; the host renders it with its own components. From
Python a module takes three steps, all through what the host's ``cognia``
module provides at run time:

1. **Declare** it in ``plugin.json`` ``glanceModules`` (with the ``glance``
   capability). ``ctx.glance.register`` is not available from Python: it
   returns a disposer, which cannot cross the plugin's stdio boundary.
2. **Hear** when it is on screen through ``@hook("onGlanceVisibilityChange")``.
   The payload is ``{"moduleId": str, "visible": bool}``; it arrives once with
   the current state when the plugin loads, then on every change, and only
   for this plugin's own modules.
3. **Publish** with ``await cognia.ctx.glance.update(module_id, data)``, where
   ``data`` is a plain dict in the camelCase shape (``None`` clears it).

This module is for **authoring and tests**, like ``cognia.pet``: the host runs
a plugin against its own small ``cognia`` module, which does not carry the
SDK's helpers. ``define_glance_module`` / ``glance_modules_manifest`` build the
manifest entries; ``validate_glance_data`` checks, in a plugin's unit tests,
that what it publishes is what the host will keep.

The checks mirror the host: the manifest validator
(``lib/plugin/core/validation.ts``) for declarations, and the sanitizer
(``lib/glance/plugin-data.ts``) for data. Author mistakes (a bad id, more items
than the host keeps, a row naming an action that is not there, an unknown
tone) are refused. Over-long strings are not: data is often built from values
the plugin does not control (a branch name, a title), and the host cuts them
with an ellipsis rather than dropping the item.
"""

from __future__ import annotations

import re

from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence

#: Sizes a module can render, smallest first.
GLANCE_SIZES = ("compact", "standard", "expanded")
#: Surfaces a module can be offered on.
GLANCE_PLATFORMS = ("desktop", "mobile")
#: Text colours a stat or a row may use.
GLANCE_TONES = ("default", "ok", "warn", "crit", "muted")
#: What the host keeps (``GLANCE_PLUGIN_LIMITS`` in ``lib/glance/plugin-data.ts``).
GLANCE_LIMITS: Mapping[str, int] = {
    "modules_per_plugin": 8,
    "stats": 4,
    "rows": 8,
    "actions": 3,
    "title": 48,
    "label": 48,
    "value": 24,
    "hint": 80,
    "summary": 80,
    "empty": 120,
    "id": 64,
}

# Module, row, action and command ids.
_LOCAL_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
# A lucide-react icon name: PascalCase, or the legacy kebab-case spelling.
_ICON_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9-]{0,47}$")


def _require_id(value: Any, label: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) > GLANCE_LIMITS["id"]
        or not _LOCAL_ID.match(value)
    ):
        raise ValueError(
            f"{label} must be 1-{GLANCE_LIMITS['id']} characters of letters, digits, "
            "'.', '_' or '-', starting with a letter or digit"
        )
    return value


def _require_text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be a non-empty string")
    return value


def _optional_text(value: Any, label: str) -> Optional[str]:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f"{label} must be a string")
    return value


def _optional_tone(value: Any, label: str) -> Optional[str]:
    if value is None:
        return None
    if value not in GLANCE_TONES:
        raise ValueError(f"{label} must be one of {list(GLANCE_TONES)}, got {value!r}")
    return value


def _optional_icon(value: Any, label: str) -> Optional[str]:
    if value is None:
        return None
    if not isinstance(value, str) or not _ICON_NAME.match(value):
        raise ValueError(f"{label} must be a lucide-react icon name (e.g. 'GitBranch')")
    return value


def _choices(value: Any, allowed: Sequence[str], label: str) -> Optional[List[str]]:
    if value is None:
        return None
    if isinstance(value, str) or not isinstance(value, Iterable):
        raise ValueError(f"{label} must be a list of {list(allowed)}")
    items = list(value)
    if not items or any(item not in allowed for item in items):
        raise ValueError(f"{label} must be a non-empty list of {list(allowed)}")
    # Keep the host's order (smallest size first) and drop repeats.
    return [option for option in allowed if option in items]


# -- the declaration --------------------------------------------------------


@dataclass(frozen=True)
class GlanceModule:
    """A module declaration (mirrors ``PluginManifestGlanceModuleDef``)."""

    id: str
    title: str
    title_key: Optional[str] = None
    icon: Optional[str] = None
    sizes: Optional[List[str]] = None
    platforms: Optional[List[str]] = None

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {"id": self.id, "title": self.title}
        if self.title_key is not None:
            out["titleKey"] = self.title_key
        if self.icon is not None:
            out["icon"] = self.icon
        if self.sizes is not None:
            out["sizes"] = list(self.sizes)
        if self.platforms is not None:
            out["platforms"] = list(self.platforms)
        return out


def define_glance_module(
    id: str,
    title: str,
    *,
    title_key: Optional[str] = None,
    icon: Optional[str] = None,
    sizes: Optional[Sequence[str]] = None,
    platforms: Optional[Sequence[str]] = None,
) -> GlanceModule:
    """Construct a validated ``GlanceModule`` for ``plugin.json`` ``glanceModules``.

    ``title`` is the fallback for ``title_key`` (a key in the plugin's own
    ``i18n.locales``, which every declared locale must contain). ``sizes``
    defaults to compact + standard and ``platforms`` to both on the host."""
    _require_id(id, "glance module id")
    _require_text(title, "glance module title")
    if title_key is not None and (not isinstance(title_key, str) or not title_key):
        raise ValueError("glance module title_key must be a non-empty string")
    return GlanceModule(
        id=id,
        title=title,
        title_key=title_key,
        icon=_optional_icon(icon, "glance module icon"),
        sizes=_choices(sizes, GLANCE_SIZES, "glance module sizes"),
        platforms=_choices(platforms, GLANCE_PLATFORMS, "glance module platforms"),
    )


def glance_modules_manifest(modules: Sequence[GlanceModule]) -> List[Dict[str, Any]]:
    """The ``glanceModules`` list for ``plugin.json``: unique ids, at most 8."""
    if len(modules) > GLANCE_LIMITS["modules_per_plugin"]:
        raise ValueError(
            f"a plugin declares at most {GLANCE_LIMITS['modules_per_plugin']} glance modules"
        )
    seen = set()
    for module in modules:
        if module.id in seen:
            raise ValueError(f"glance module id {module.id!r} is declared more than once")
        seen.add(module.id)
    return [module.to_dict() for module in modules]


# -- the data ---------------------------------------------------------------


def _check_items(
    data: Mapping[str, Any], key: str, limit: str, required: Sequence[str]
) -> List[Mapping[str, Any]]:
    items = data.get(key)
    if items is None:
        return []
    if isinstance(items, (str, bytes)) or not isinstance(items, Sequence):
        raise ValueError(f"glance {key} must be a list")
    if len(items) > GLANCE_LIMITS[limit]:
        raise ValueError(f"a glance module shows at most {GLANCE_LIMITS[limit]} {key}")
    out = []
    for index, item in enumerate(items):
        label = f"glance {key}[{index}]"
        if not isinstance(item, Mapping):
            raise ValueError(f"{label} must be a mapping")
        for name in required:
            _require_text(item.get(name), f"{label}.{name}")
        out.append(item)
    return out


def validate_glance_data(data: Optional[Mapping[str, Any]]) -> Optional[Dict[str, Any]]:
    """Check what a plugin is about to publish, and return it as a plain dict.

    ``data`` is the camelCase shape ``ctx.glance.update`` takes::

        {
            "summary": "2 failing",
            "stats": [{"label": "Failing", "value": "2", "tone": "crit"}],
            "rows": [{"id": "main", "label": "main", "value": "red", "action": "rerun"}],
            "actions": [{"id": "rerun", "label": "Run build", "command": "runBuild"}],
            "empty": "No builds yet",
        }

    Refused, because the host would drop them: more than 4 stats, 8 rows or 3
    actions; a stat without a label and a value; a row or an action without an
    id and a label; an action without a command; repeated row or action ids; a
    row whose ``action`` is not published; an unknown tone or key. ``None``
    (clear the module) passes through. Over-long strings pass: the host cuts
    them."""
    if data is None:
        return None
    if not isinstance(data, Mapping):
        raise ValueError("glance data must be a mapping or None")
    unknown = set(data) - {"stats", "rows", "actions", "summary", "empty"}
    if unknown:
        raise ValueError(f"glance data has unknown keys {sorted(unknown)}")
    stats = _check_items(data, "stats", "stats", ("label", "value"))
    rows = _check_items(data, "rows", "rows", ("label",))
    actions = _check_items(data, "actions", "actions", ("label",))
    for index, stat in enumerate(stats):
        _optional_tone(stat.get("tone"), f"glance stats[{index}].tone")
    action_ids = set()
    for index, action in enumerate(actions):
        action_id = _require_id(action.get("id"), f"glance actions[{index}].id")
        if action_id in action_ids:
            raise ValueError(f"glance action id {action_id!r} appears more than once")
        action_ids.add(action_id)
        _require_id(action.get("command"), f"glance actions[{index}].command")
        _optional_icon(action.get("icon"), f"glance actions[{index}].icon")
    row_ids = set()
    for index, row in enumerate(rows):
        row_id = _require_id(row.get("id"), f"glance rows[{index}].id")
        if row_id in row_ids:
            raise ValueError(f"glance row id {row_id!r} appears more than once")
        row_ids.add(row_id)
        for key in ("value", "hint"):
            _optional_text(row.get(key), f"glance rows[{index}].{key}")
        _optional_tone(row.get("tone"), f"glance rows[{index}].tone")
        action = row.get("action")
        if action is not None and action not in action_ids:
            raise ValueError(
                f"glance row {row_id!r} names action {action!r}, which is not published"
            )
    _optional_text(data.get("summary"), "glance summary")
    _optional_text(data.get("empty"), "glance empty text")
    return {key: value for key, value in data.items()}


__all__ = [
    "GLANCE_LIMITS",
    "GLANCE_PLATFORMS",
    "GLANCE_SIZES",
    "GLANCE_TONES",
    "GlanceModule",
    "define_glance_module",
    "glance_modules_manifest",
    "validate_glance_data",
]
