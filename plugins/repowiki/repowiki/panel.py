"""The reader panel, as A2UI component data.

A Python plugin cannot hand the host a React component, so the panel is data:
a component tree pushed with ``ctx.a2ui.updateComponents``, rendered by the
host, with clicks coming back through the ``onA2UIAction`` hook. This module
builds that tree and nothing else — no host calls, no IO — so the layout is
unit-testable without a running app.

Two components carry it, both added to the A2UI catalog for this:

* ``Tree`` — the page outline at arbitrary depth. The catalog's only
  hierarchical navigator before was ``Sidebar``, fixed at two levels.
* ``Markdown`` — the page body, rendered by the same pipeline as a chat
  message, so Mermaid diagrams, syntax highlighting and the sanitize policy
  are shared rather than forked.
"""

from __future__ import annotations

from typing import Any

#: Actions the panel emits. Namespaced because `onA2UIAction` is a broadcast:
#: every plugin's hook sees every surface's actions.
ACTION_OPEN_PAGE = "repowiki:open-page"
ACTION_OPEN_CITATION = "repowiki:open-citation"
ACTION_SELECT_PROJECT = "repowiki:select-project"
ACTION_RESCAN = "repowiki:rescan"


def surface_id_for(plugin_prefix: str, resource_key: str) -> str:
    """The surface a panel declaration resolves to for one resource."""
    return f"{plugin_prefix}:{resource_key}"


def _page_nodes(pages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Fold the wiki's flat page list into the tree its parent ids describe.

    The builder emits pages with `parentId`, not a nested structure, because
    the sidebar and the page list are two views of the same thing upstream.
    Rebuilding the nesting here keeps that single source and means a page whose
    parent is missing still shows up — at the top level — rather than vanishing.
    """
    by_id = {page["id"]: page for page in pages}
    children: dict[str, list[dict[str, Any]]] = {}
    roots: list[dict[str, Any]] = []

    for page in pages:
        parent = page.get("parentId") or ""
        if parent and parent in by_id:
            children.setdefault(parent, []).append(page)
        else:
            roots.append(page)

    def node(page: dict[str, Any]) -> dict[str, Any]:
        built: dict[str, Any] = {
            "id": page["id"],
            "label": page.get("title") or page["id"],
            "icon": "file-text" if page.get("parentId") else "book-open",
        }
        kids = [node(child) for child in children.get(page["id"], [])]
        if kids:
            built["children"] = kids
            built["icon"] = "folder"
        return built

    return [node(page) for page in roots]


def build_panel(
    *,
    project_name: str,
    pages: list[dict[str, Any]],
    active_page: dict[str, Any] | None,
    project_root: str = "",
    staleness: dict[str, Any] | None = None,
    warnings: list[str] | None = None,
    projects: list[dict[str, Any]] | None = None,
    empty_label: str = "No wiki yet — run a scan to build one.",
) -> list[dict[str, Any]]:
    """Return the component list for the reader surface.

    The root id must be ``"root"``: the host fixes it when the surface is
    created and no message changes it, so a tree without one renders the
    surface's "no content" state.
    """
    warnings = warnings or []
    projects = projects or []
    # Three states, not two. `known and not stale` is the only one that earns
    # silence; an unknown answer has to say so, because an absent badge is read
    # as "current" and that is precisely the claim we cannot make.
    known = bool((staleness or {}).get("known"))
    stale = known and bool((staleness or {}).get("stale"))
    unknown = staleness is not None and not known
    show_rescan = stale or unknown
    # Why the check could not be answered goes in the banner, not on the badge.
    # A hover has no touch equivalent and A2UI has no tooltip field, so a
    # reason attached to the Badge would be a string nothing ever renders —
    # which is how a diagnostic becomes decoration.
    reason = str((staleness or {}).get("reason") or "").strip()
    if unknown and reason:
        warnings = [*warnings, f"Freshness unknown: {reason}"]

    root_children = ["header"]
    if warnings:
        root_children.append("warnings")
    root_children.append("body")

    components: list[dict[str, Any]] = [
        {
            "id": "root",
            "component": "Column",
            "children": root_children,
            "gap": 8,
        },
        {
            "id": "header",
            "component": "Row",
            "children": _header_children(projects, show_rescan),
            "gap": 8,
            "align": "center",
        },
        {
            "id": "title",
            "component": "Text",
            "text": project_name or "RepoWiki",
            "variant": "heading4",
        },
        {
            "id": "body",
            "component": "Row",
            "children": ["outline", "page"],
            "gap": 12,
        },
        {
            "id": "outline",
            "component": "Tree",
            "nodes": _page_nodes(pages),
            "action": ACTION_OPEN_PAGE,
            "selectedId": (active_page or {}).get("id", ""),
            "defaultExpandedDepth": 1,
            "emptyLabel": empty_label,
            "weight": 1,
        },
        {
            "id": "page",
            "component": "Markdown",
            "content": (active_page or {}).get("content") or f"_{empty_label}_",
            # A citation is a workspace path: routing it to the plugin lets it
            # open the project editor at the line, rather than the host's
            # default guess about what a relative path in prose means.
            "openFileAction": ACTION_OPEN_CITATION,
            "projectRoot": project_root,
            "weight": 3,
        },
    ]

    if projects:
        components.append(
            {
                "id": "project-picker",
                "component": "Select",
                "value": (projects[0] if projects else {}).get("projectId", ""),
                "options": [
                    {
                        "value": entry.get("projectId", ""),
                        "label": entry.get("projectName") or entry.get("projectId", ""),
                    }
                    for entry in projects
                ],
                "action": ACTION_SELECT_PROJECT,
            }
        )
    if show_rescan:
        changed_count = int((staleness or {}).get("changedCount") or 0)
        components.append(
            {
                "id": "stale",
                "component": "Badge",
                "text": (
                    f"Out of date · {changed_count} changed"
                    if stale and changed_count
                    else "Out of date"
                    if stale
                    else "Freshness unknown"
                ),
                "variant": "destructive" if stale else "secondary",
            }
        )
        components.append(
            {
                "id": "rescan",
                "component": "Button",
                "text": "Rescan",
                "variant": "outline",
                "action": ACTION_RESCAN,
            }
        )
    if warnings:
        components.append(
            {
                "id": "warnings",
                "component": "Alert",
                "variant": "warning",
                "title": "Partial scan",
                # One alert, not one per warning: a stack of banners above the
                # page pushes the thing the user came to read off screen.
                "message": " · ".join(warnings),
            }
        )

    return components


def _header_children(projects: list[dict[str, Any]], show_rescan: bool) -> list[str]:
    """Title, then the repository picker, then the staleness pair.

    Warnings are deliberately not here: an Alert wedged into a header Row next
    to a title is unreadable, so it sits between the header and the body where
    a banner belongs.
    """
    children = ["title"]
    if projects:
        children.append("project-picker")
    if show_rescan:
        children.extend(["stale", "rescan"])
    return children
