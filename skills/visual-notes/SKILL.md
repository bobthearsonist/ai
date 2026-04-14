---
name: visual-notes
description: >-
  Generate and update living visual concept maps for session whiteboards, daily
  overviews, and rollup views using Cytoscape.js. Called by obsidian-notes at
  session boundaries. Also invoked directly for on-demand rollup visuals.
  Triggers on: "session visual", "daily overview", "update visual", "rollup
  visual", "sprint retro visual", "project overview visual", "visual summary",
  "concept map for session".
---

# Visual Notes

Generate living visual artifacts that embed in Obsidian daily notes via iframe.
Three tiers: session whiteboards, daily overviews, and on-demand rollup views.

## Quick Reference

| Visual type | Tool | When |
|---|---|---|
| Session whiteboard | Cytoscape.js (this skill) | Called by obsidian-notes at session start, during work, at session end |
| Daily overview | Cytoscape.js (this skill) | Updated at end of each session |
| Small inline diagram | Mermaid (use `diagrams` skill fast-path) | When a quick sequence/flow is needed mid-note |
| Rollup view | AntVis Infographic or Cytoscape.js | On-demand when user requests retro/overview |

## Design Principles

Load [visual-heuristic.md](references/visual-heuristic.md) for the full decision table. Summary:

1. **Every edge has a label** — the label IS the insight
2. **Hierarchy encodes importance** — general concepts top/center, specifics at edges
3. **Max ~20 nodes per session, ~50 per daily** — group into clusters if exceeding
4. **Semantic colors only** — green=done, yellow=active, blue=context, red=blocked
5. **Shapes encode type** — rectangle=system, ellipse=task, diamond=decision
6. **Cross-domain links are gold** — dashed lines connecting different topic areas

## Workflow: Session Whiteboard

Called by `obsidian-notes` step 2.5 (session start) and step 6.5 (session end).

### Session start (called by obsidian-notes step 2.5)

1. Read `~/ai/local.yaml` for vault path and daily folder
2. Determine session number: count existing `{date}-session-*.html` files in the daily folder, increment
3. Seed initial nodes from active context:
   - Read yesterday's daily note for unfinished `- [ ]` next steps → add as `context` nodes
   - Check git status for active branches → add as `context` nodes
   - If user stated a goal for the session → add as `active` node
4. Compute positions using [position-strategy.md](references/position-strategy.md)
5. Generate HTML:
   ```bash
   py <skill_path>/scripts/generate-visual.py \
     --data /tmp/session-data.json \
     --output "{vault}/{daily_folder}/{date}-session-{n}.html" \
     --title "Session {n} - {date}" \
     --subtitle "{session topic}"
   ```
6. Return iframe embed markup for obsidian-notes to insert

### Mid-session update

When the agent completes a task, starts a new investigation, or discovers a connection:

1. Read the current session HTML file to extract existing graph data (parse the JSON between `/* __GRAPH_DATA__ */` markers — or maintain the data in a temp JSON file)
2. Add new node(s) and edge(s) to the data
3. Compute position for new nodes using position strategy
4. Regenerate the HTML file (full regeneration, not DOM patching)

**Practical approach:** Maintain the graph data as a JSON sidecar file `{date}-session-{n}.json` alongside the HTML. Update the JSON, then regenerate HTML from it. This avoids parsing HTML to extract state.

### Session end (called by obsidian-notes step 6.5)

1. Mark completed outcomes as `completed` status class
2. Mark unresolved items as `active` or `blocked`
3. Final regeneration of the HTML
4. Extract key nodes/edges for daily overview merge (see below)

## Workflow: Daily Overview

Called by `obsidian-notes` step 10 (after session summary is appended).

### First session of the day

1. Check if `{date}-overview.html` exists — if not, create it
2. Seed from active context:
   - Read yesterday's overview JSON for any `active` or `blocked` nodes → carry forward as `context`
   - Check for unfinished next-steps in yesterday's daily note
3. Generate the overview HTML
4. Insert iframe at top of daily note (before any session headings)

### Subsequent sessions

1. Read `{date}-overview.json` for current state
2. Merge key nodes from the just-completed session:
   - Add nodes for major outcomes, systems touched, decisions made
   - Add edges connecting to existing overview nodes where relationships exist
   - Mark completed items green, new active items yellow
3. Compute positions: new session cluster offset 450px right of existing content
4. Regenerate overview HTML
5. The iframe in the daily note auto-refreshes on next Obsidian render

### Daily overview iframe placement

The daily overview iframe goes at the very top of the daily note, before any session content:

```markdown
## Daily Overview
<iframe src="file:///C:/Users/MartinPe/Obsidian/Test/{daily_folder}/{date}-overview.html" width="100%" height="450" style="border:none; border-radius: 8px;"></iframe>

---

## AI Session Summary - Session 1 ...
```

## Workflow: Rollup Views

Triggered by user request. Load [visual-heuristic.md](references/visual-heuristic.md) for template mappings.

1. **Parse the request** — what type of rollup? What date range? What tag filters?
2. **Query data** — use Obsidian CLI Dataview queries to pull session summaries matching the filters
3. **Extract structured data** — outcomes, tools, tags, metrics, dates from the matching summaries
4. **Select visual type** — from the rollup templates table in visual-heuristic.md
5. **Generate visual**:
   - For concept maps: use Cytoscape.js (this skill's generate-visual.py)
   - For polished infographics: invoke `infographic-syntax-creator` skill
   - For charts: use Mermaid via `diagrams` skill fast-path
6. **Place the visual** — in the retro/overview note the user is creating

## Node/Edge Data Format

All graph data uses this JSON structure:

```json
{
  "nodes": [
    {
      "data": { "id": "unique-id", "label": "Display\nLabel" },
      "classes": "type-class status-class",
      "position": { "x": 200, "y": 150 }
    }
  ],
  "edges": [
    {
      "data": { "source": "node-id-1", "target": "node-id-2", "label": "relationship verb" },
      "classes": "edge-class"
    }
  ]
}
```

**Node ID convention:** kebab-case slug of the concept: `nuget-restore`, `mcp-config`, `build-break`.

**Label convention:** Short (2-4 words), use `\n` for line breaks in the middle.

**Classes:** Combine one type class + one status class: `"system context"`, `"task completed"`, `"decision active"`.

**Edge labels:** Always a verb or verb phrase: `caused`, `resolves`, `configured in`, `authenticates`, `same auth stack`.

## Theme Reference

Load [theme.json](references/theme.json) for the full color/shape definitions. The HTML template handles theme detection and applies light/dark palettes automatically.

## File Naming

| Artifact | Pattern | Example |
|---|---|---|
| Session whiteboard HTML | `{YYYYMMDD}-session-{n}.html` | `20260414-session-1.html` |
| Session whiteboard data | `{YYYYMMDD}-session-{n}.json` | `20260414-session-1.json` |
| Daily overview HTML | `{YYYYMMDD}-overview.html` | `20260414-overview.html` |
| Daily overview data | `{YYYYMMDD}-overview.json` | `20260414-overview.json` |
| Rollup visual | `{context}-visual.html` | `2026-W16-retro-visual.html` |
