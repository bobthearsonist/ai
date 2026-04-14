#!/usr/bin/env python3
"""Generate a self-contained Cytoscape.js HTML visual from JSON graph data.

Usage:
    python generate-visual.py --data graph.json --output visual.html
    python generate-visual.py --data graph.json --output visual.html --title "Session Map" --subtitle "NuGet Fix"

The script reads the cytoscape-template.html, injects graph data and
the Cytoscape.js library (fetched/cached via inline-deps pattern), and
writes a self-contained HTML file suitable for Obsidian iframe embedding.

Input JSON format:
{
  "nodes": [
    { "data": { "id": "n1", "label": "NuGet\\nRestore" }, "classes": "system context", "position": { "x": 200, "y": 150 } }
  ],
  "edges": [
    { "data": { "source": "n1", "target": "n2", "label": "caused" }, "classes": "strong-edge" }
  ]
}
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import urllib.request
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
TEMPLATE_PATH = SCRIPT_DIR.parent / "references" / "cytoscape-template.html"
CYTOSCAPE_CDN = "https://unpkg.com/cytoscape@3.30.4/dist/cytoscape.min.js"
CACHE_DIR = Path.home() / ".cache" / "inline-deps"


def fetch_cytoscape() -> str:
    """Fetch Cytoscape.js, caching locally."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha256(CYTOSCAPE_CDN.encode()).hexdigest()[:16]
    cached = CACHE_DIR / f"{key}.js"
    if cached.exists():
        return cached.read_text(encoding="utf-8")
    print(f"  fetching {CYTOSCAPE_CDN}", file=sys.stderr)
    with urllib.request.urlopen(CYTOSCAPE_CDN, timeout=30) as resp:
        content = resp.read().decode("utf-8")
    cached.write_text(content, encoding="utf-8")
    return content


def generate(
    data: dict,
    output: Path,
    title: str = "Session Map",
    subtitle: str = "",
) -> Path:
    """Generate self-contained HTML from graph data."""
    template = TEMPLATE_PATH.read_text(encoding="utf-8")
    cytoscape_js = fetch_cytoscape()

    # Inject Cytoscape.js library
    html = template.replace("/* __CYTOSCAPE_JS__ */", cytoscape_js)

    # Inject graph data
    data_json = json.dumps(data, indent=None)
    html = html.replace("/* __GRAPH_DATA__ */{ nodes: [], edges: [] }", data_json)

    # Inject title/subtitle
    html = html.replace("__TITLE__", title)
    html = html.replace("__HEADER__", title)
    html = html.replace("__SUBTITLE__", subtitle)

    output.write_text(html, encoding="utf-8")
    print(f"Generated {output} ({output.stat().st_size:,} bytes)")
    return output


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, required=True, help="JSON file with nodes/edges")
    parser.add_argument("--output", "-o", type=Path, required=True, help="Output HTML path")
    parser.add_argument("--title", default="Session Map", help="Visual title")
    parser.add_argument("--subtitle", default="", help="Visual subtitle")
    args = parser.parse_args()

    if not args.data.exists():
        print(f"ERROR: {args.data} not found", file=sys.stderr)
        return 1

    data = json.loads(args.data.read_text(encoding="utf-8"))
    generate(data, args.output, args.title, args.subtitle)
    return 0


if __name__ == "__main__":
    sys.exit(main())
