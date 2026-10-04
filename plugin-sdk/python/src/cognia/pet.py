"""Typed manifest mirrors for the desktop-pet capability family (ADR-0058).

Python author-facing helpers mirroring the TypeScript ``define-*`` helpers:

* ``pet-item``        → ``PluginPetItemDef``        (manifest ``petItems``)
* ``pet-achievement`` → ``PluginPetAchievementDef`` (manifest ``petAchievements``)

Each helper builds a validated dataclass whose ``to_dict()`` emits the camelCase
shape the host reads from the manifest. ``labels`` / ``descriptions`` are locale
maps (``{ "en": "...", "zh-CN": "..." }``); an achievement ``condition`` is
carried as a plain dict.

The checks mirror the host's own validator
(``lib/plugin/registries/pet-contribution-validation.ts``), which runs at
manifest validation and again when the plugin is enabled: an entry that fails
there is dropped, so the same mistake is refused here, at authoring time.
"""

from __future__ import annotations

import math
import re

from dataclasses import dataclass, field
from typing import Any, Dict, Mapping, Optional

# Pet item categories (PluginPetItemDef.category).
_PET_ITEM_CATEGORIES = frozenset({"food", "toy", "decor"})
# Pet interaction kinds (PluginPetItemDef.interactionKind).
_PET_INTERACTION_KINDS = frozenset(
    {"fed", "played", "petted", "talked", "slept", "cleaned", "treated"}
)
# Needs a restore or a condition may name.
_PET_NEEDS = frozenset({"energy", "mood", "bond"})
# Every pet event kind the activity ledger can record (types/pet/events.ts
# PET_EVENT_KINDS; tests/test_pet.py pins the two lists equal). A `counter`
# condition on anything else never unlocks.
PET_EVENT_KINDS = frozenset(
    {
        "thinking",
        "waiting",
        "review",
        "success",
        "error",
        "idle",
        "goalProgress",
        "goalComplete",
        "teamRun",
        "inboundMessage",
        "scheduledRun",
        "scheduledRunStarting",
        "scheduledRunDue",
        "workflowRun",
        "twinBusy",
        "twinMilestone",
        "radarReport",
        "pluginReward",
        "fed",
        "played",
        "petted",
        "talked",
        "slept",
        "cleaned",
        "treated",
        "hatched",
        "levelUp",
        "evolved",
        "achievementUnlocked",
        "greeting",
        "unwell",
        "streakDay",
        "birthday",
    }
)
# Pack-local ids become ``plugin:<pluginId>:<id>`` and unlock-record keys.
_LOCAL_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
# A lucide-react icon name: PascalCase, or the legacy kebab-case spelling.
_ICON_NAME = re.compile(r"^(?:[A-Z][A-Za-z0-9]*|[a-z][a-z0-9]*(?:-[a-z0-9]+)*)$")
# Bounds the host enforces.
_MAX_NEED_EFFECT = 100
MAX_PET_ITEM_PRICE = 100_000


def _require_id(value: Any, label: str) -> None:
    if not isinstance(value, str) or not _LOCAL_ID.match(value):
        raise ValueError(
            f"{label} must be 1-64 characters of letters, digits, '.', '_' or '-', "
            "starting with a letter or digit"
        )


def _require_locale_map(value: Any, label: str, *, required: bool) -> None:
    if value is None and not required:
        return
    if not isinstance(value, Mapping) or (required and not value):
        raise ValueError(f"{label} must be a non-empty locale map")
    for locale, text in value.items():
        if not isinstance(text, str):
            raise ValueError(f"{label}[{locale!r}] must be a string")
    if required:
        english = value.get("en")
        if not isinstance(english, str) or not english.strip():
            raise ValueError(f"{label} must declare a non-empty English label at 'en'")


def _require_icon(value: Optional[str], label: str) -> None:
    if value is not None and (not isinstance(value, str) or not _ICON_NAME.match(value)):
        raise ValueError(f"{label} must be a lucide-react icon name (e.g. 'Sparkles')")


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


# -- pet-item ---------------------------------------------------------------


@dataclass(frozen=True)
class PetItem:
    """A pet shop item (mirrors ``PluginPetItemDef``)."""

    id: str
    labels: Dict[str, str]
    category: str
    price: int
    consumable: bool
    descriptions: Optional[Dict[str, str]] = None
    icon: Optional[str] = None
    interaction_kind: Optional[str] = None
    needs_effect: Optional[Dict[str, float]] = None

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "id": self.id,
            "labels": dict(self.labels),
            "category": self.category,
            "price": self.price,
            "consumable": self.consumable,
        }
        if self.descriptions is not None:
            out["descriptions"] = dict(self.descriptions)
        if self.icon is not None:
            out["icon"] = self.icon
        if self.interaction_kind is not None:
            out["interactionKind"] = self.interaction_kind
        if self.needs_effect is not None:
            out["needsEffect"] = dict(self.needs_effect)
        return out


def define_pet_item(
    id: str,
    labels: Mapping[str, str],
    category: str,
    price: int,
    consumable: bool,
    *,
    descriptions: Optional[Mapping[str, str]] = None,
    icon: Optional[str] = None,
    interaction_kind: Optional[str] = None,
    needs_effect: Optional[Mapping[str, float]] = None,
) -> PetItem:
    """Construct a validated ``PetItem``.

    ``category`` must be ``food`` / ``toy`` / ``decor``; ``price`` a whole
    number of coins from 1 to ``MAX_PET_ITEM_PRICE``; a consumable needs the
    ``interaction_kind`` it is used for (one of the seven care kinds); and
    ``needs_effect`` (energy / mood / bond, each within ±100) only applies to a
    consumable, when it is used."""
    _require_id(id, "pet item id")
    _require_locale_map(labels, "pet item labels", required=True)
    _require_locale_map(descriptions, "pet item descriptions", required=False)
    _require_icon(icon, "pet item icon")
    if category not in _PET_ITEM_CATEGORIES:
        raise ValueError(
            f"unknown pet item category {category!r}; expected one of "
            f"{sorted(_PET_ITEM_CATEGORIES)}"
        )
    if (
        not isinstance(price, int)
        or isinstance(price, bool)
        or price <= 0
        or price > MAX_PET_ITEM_PRICE
    ):
        raise ValueError(f"pet item price must be a whole number from 1 to {MAX_PET_ITEM_PRICE}")
    if not isinstance(consumable, bool):
        raise ValueError("pet item consumable must be True or False")
    if interaction_kind is not None and interaction_kind not in _PET_INTERACTION_KINDS:
        raise ValueError(
            f"unknown interaction_kind {interaction_kind!r}; expected one of "
            f"{sorted(_PET_INTERACTION_KINDS)}"
        )
    if consumable and interaction_kind is None:
        raise ValueError("a consumable pet item needs the interaction_kind it is used for")
    if needs_effect is not None:
        if not consumable:
            raise ValueError("needs_effect only applies to a consumable pet item")
        for need, amount in needs_effect.items():
            if need not in _PET_NEEDS:
                raise ValueError(
                    f"needs_effect key {need!r} is not a need; use {sorted(_PET_NEEDS)}"
                )
            if not _is_number(amount) or abs(amount) > _MAX_NEED_EFFECT:
                raise ValueError(
                    f"needs_effect[{need!r}] must be a number from "
                    f"-{_MAX_NEED_EFFECT} to {_MAX_NEED_EFFECT}"
                )
    return PetItem(
        id=id,
        labels=dict(labels),
        category=category,
        price=price,
        consumable=consumable,
        descriptions=dict(descriptions) if descriptions is not None else None,
        icon=icon,
        interaction_kind=interaction_kind,
        needs_effect=dict(needs_effect) if needs_effect is not None else None,
    )


# -- pet-achievement --------------------------------------------------------


@dataclass(frozen=True)
class PetAchievement:
    """A pet achievement (mirrors ``PluginPetAchievementDef``)."""

    id: str
    labels: Dict[str, str]
    condition: Dict[str, Any]
    descriptions: Optional[Dict[str, str]] = None
    icon: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "id": self.id,
            "labels": dict(self.labels),
            "condition": dict(self.condition),
        }
        if self.descriptions is not None:
            out["descriptions"] = dict(self.descriptions)
        if self.icon is not None:
            out["icon"] = self.icon
        return out


def define_pet_achievement(
    id: str,
    labels: Mapping[str, str],
    condition: Mapping[str, Any],
    *,
    descriptions: Optional[Mapping[str, str]] = None,
    icon: Optional[str] = None,
) -> PetAchievement:
    """Construct a validated ``PetAchievement``.

    ``condition`` is one of the shapes the host compiles:

    * ``{"type": "counter", "kind": <pet event kind>, "gte": n}``
    * ``{"type": "level", "gte": n}``
    * ``{"type": "need", "need": "energy" | "mood" | "bond", "gte": n}``

    ``gte`` is a finite non-negative number (at most 100 for a need), and a
    counter's ``kind`` must be one of ``PET_EVENT_KINDS``."""
    _require_id(id, "pet achievement id")
    _require_locale_map(labels, "pet achievement labels", required=True)
    _require_locale_map(descriptions, "pet achievement descriptions", required=False)
    _require_icon(icon, "pet achievement icon")
    if not isinstance(condition, Mapping) or not condition:
        raise ValueError("pet achievement condition must be a non-empty mapping")
    gte = condition.get("gte")
    if not _is_number(gte) or gte < 0:
        raise ValueError("pet achievement condition 'gte' must be a finite non-negative number")
    kind = condition.get("type")
    if kind == "counter":
        if condition.get("kind") not in PET_EVENT_KINDS:
            raise ValueError(
                f"counter condition kind {condition.get('kind')!r} is not a pet event kind "
                "the activity ledger records (e.g. 'fed', 'goalComplete', 'pluginReward')"
            )
    elif kind == "need":
        if condition.get("need") not in _PET_NEEDS:
            raise ValueError(f"need condition 'need' must be one of {sorted(_PET_NEEDS)}")
        if gte > 100:
            raise ValueError("need condition 'gte' cannot exceed 100")
    elif kind != "level":
        raise ValueError(
            f"unknown condition type {kind!r}; expected 'counter', 'level' or 'need'"
        )
    return PetAchievement(
        id=id,
        labels=dict(labels),
        condition=dict(condition),
        descriptions=dict(descriptions) if descriptions is not None else None,
        icon=icon,
    )
