"""Typed manifest mirrors for the appearance capability family (ADR-0026/0030).

Python author-facing helpers mirroring the TypeScript ``define-*`` helpers for
declarative appearance contributions:

* ``theme``             → ``PluginThemeContribution``     (manifest ``themes``)
* ``theme-pack``        → ``PluginThemePackContribution`` (manifest ``themePacks``)
* ``font-contribution`` → ``PluginFontContribution``      (manifest ``fonts``)
* ``wallpaper``         → ``PluginWallpaperContribution`` (manifest ``wallpapers``)

Each helper builds a validated dataclass whose ``to_dict()`` emits the camelCase
shape the host reads from the manifest. Structured sub-objects (a theme pack's
``applies`` block, a font's ``files``, a wallpaper ``source`` union) are carried
as plain dicts/lists.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional

# font-display strategies (PluginFontContribution.display).
_FONT_DISPLAY = frozenset({"swap", "block", "fallback", "optional", "auto"})
# wallpaper source kinds (PluginWallpaperContribution.source.kind).
_WALLPAPER_SOURCE_KINDS = frozenset({"image", "gradient", "color"})


def _require(value: str, label: str) -> None:
    if not value or not value.strip():
        raise ValueError(f"{label} must be a non-empty string")


# -- theme ------------------------------------------------------------------


@dataclass(frozen=True)
class Theme:
    """A theme contribution (mirrors the ``PluginThemeContribution`` union).

    Exactly one payload is carried: ``colors`` (a full manifest color map),
    ``vscode_json_path`` (import a VSCode theme JSON), or ``css_variables``
    (scoped CSS custom-property overrides).
    """

    id: str
    name: str
    is_dark: Optional[bool] = None
    colors: Optional[Dict[str, Any]] = None
    vscode_json_path: Optional[str] = None
    css_variables: Optional[Dict[str, str]] = None

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {"id": self.id, "name": self.name}
        if self.vscode_json_path is not None:
            # The vscode variant has no isDark field.
            out["vscodeJsonPath"] = self.vscode_json_path
            return out
        if self.is_dark is not None:
            out["isDark"] = self.is_dark
        if self.colors is not None:
            out["colors"] = dict(self.colors)
        elif self.css_variables is not None:
            out["cssVariables"] = dict(self.css_variables)
        return out


def define_theme(
    id: str,
    name: str,
    *,
    is_dark: Optional[bool] = None,
    colors: Optional[Mapping[str, Any]] = None,
    vscode_json_path: Optional[str] = None,
    css_variables: Optional[Mapping[str, str]] = None,
) -> Theme:
    """Construct a validated ``Theme``. Provide exactly one of ``colors`` /
    ``vscode_json_path`` / ``css_variables``."""
    _require(id, "theme id")
    _require(name, "theme name")
    payloads = [
        p is not None for p in (colors, vscode_json_path, css_variables)
    ]
    if sum(payloads) != 1:
        raise ValueError(
            "theme must provide exactly one of colors / vscode_json_path / "
            "css_variables"
        )
    return Theme(
        id=id,
        name=name,
        is_dark=is_dark,
        colors=dict(colors) if colors is not None else None,
        vscode_json_path=vscode_json_path,
        css_variables=dict(css_variables) if css_variables is not None else None,
    )


# -- theme-pack -------------------------------------------------------------


@dataclass(frozen=True)
class ThemePack:
    """A theme-pack contribution (mirrors ``PluginThemePackContribution``)."""

    id: str
    name: str
    applies: Dict[str, Any]
    description: Optional[str] = None
    preview: Optional[Dict[str, Any]] = None

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "id": self.id,
            "name": self.name,
            "applies": dict(self.applies),
        }
        if self.description is not None:
            out["description"] = self.description
        if self.preview is not None:
            out["preview"] = dict(self.preview)
        return out


def define_theme_pack(
    id: str,
    name: str,
    applies: Mapping[str, Any],
    *,
    description: Optional[str] = None,
    preview: Optional[Mapping[str, Any]] = None,
) -> ThemePack:
    """Construct a validated ``ThemePack``. ``applies`` references sibling
    contributions (themeId / fontFamily / wallpaperId / density / …)."""
    _require(id, "theme pack id")
    _require(name, "theme pack name")
    if applies is None:
        raise ValueError("theme pack must provide an 'applies' block")
    return ThemePack(
        id=id,
        name=name,
        applies=dict(applies),
        description=description,
        preview=dict(preview) if preview is not None else None,
    )


# -- font-contribution ------------------------------------------------------


@dataclass(frozen=True)
class FontContribution:
    """A font contribution (mirrors ``PluginFontContribution``). Keyed by
    ``family``."""

    family: str
    files: List[Dict[str, Any]]
    display: Optional[str] = None
    unicode_range: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "family": self.family,
            "files": [dict(f) for f in self.files],
        }
        if self.display is not None:
            out["display"] = self.display
        if self.unicode_range is not None:
            out["unicodeRange"] = self.unicode_range
        return out


def define_font_contribution(
    family: str,
    files: List[Mapping[str, Any]],
    *,
    display: Optional[str] = None,
    unicode_range: Optional[str] = None,
) -> FontContribution:
    """Construct a validated ``FontContribution``. ``display`` (if set) must be
    one of ``swap`` / ``block`` / ``fallback`` / ``optional`` / ``auto``."""
    _require(family, "font family")
    if not files:
        raise ValueError("font contribution must declare at least one file")
    if display is not None and display not in _FONT_DISPLAY:
        raise ValueError(
            f"unknown font display {display!r}; expected one of "
            f"{sorted(_FONT_DISPLAY)}"
        )
    return FontContribution(
        family=family,
        files=[dict(f) for f in files],
        display=display,
        unicode_range=unicode_range,
    )


# -- wallpaper --------------------------------------------------------------


@dataclass(frozen=True)
class Wallpaper:
    """A wallpaper contribution (mirrors ``PluginWallpaperContribution``)."""

    id: str
    name: str
    source: Dict[str, Any]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "source": dict(self.source),
        }


def define_wallpaper(
    id: str,
    name: str,
    source: Mapping[str, Any],
) -> Wallpaper:
    """Construct a validated ``Wallpaper``. ``source.kind`` must be one of
    ``image`` / ``gradient`` / ``color``."""
    _require(id, "wallpaper id")
    _require(name, "wallpaper name")
    if not source or "kind" not in source:
        raise ValueError("wallpaper source must be a mapping with a 'kind' field")
    kind = source["kind"]
    if kind not in _WALLPAPER_SOURCE_KINDS:
        raise ValueError(
            f"unknown wallpaper source kind {kind!r}; expected one of "
            f"{sorted(_WALLPAPER_SOURCE_KINDS)}"
        )
    return Wallpaper(id=id, name=name, source=dict(source))
