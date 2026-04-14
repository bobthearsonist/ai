# Visual Heuristic — When and What to Visualize

## Decision table (Dan Roam 6x6)

When the agent has session content, map it to a visual type:

| Content shape | Question it answers | Visual format | Tool |
|---|---|---|---|
| Components/systems touched, relationships between them | Who/What? | Concept map | Cytoscape.js |
| Metrics: tokens, time, cost, outcomes count | How much? | Chart | Mermaid xychart-beta or pie |
| System architecture, deployment topology | Where? | Architecture diagram | Mermaid/PlantUML (via diagrams skill) |
| Session chronology, milestones, phases | When? | Timeline | Mermaid timeline |
| Debugging flow, decision trees, process steps | How? | Flowchart | Mermaid flowchart or Cytoscape.js |
| Root cause analysis, tradeoff evaluation | Why? | Weighted mindmap | Mermaid mindmap |

**Default for session whiteboards:** Concept map (Cytoscape.js). Most sessions involve multiple topics with relationships — the concept map is the most general-purpose format.

**Default for daily overview:** Concept map (Cytoscape.js). Accumulated sessions form a network of connected topics.

**Default for rollups:** Depends on the rollup type — see Rollup Templates below.

## Principles checklist

Before generating any visual, verify these (from research):

1. **Every edge has a label** — The relationship IS the insight. `A -->|caused| B`, never bare arrows.
2. **Hierarchy encodes importance** — General/important concepts at top or center, details at edges.
3. **Small over sprawling** — Max ~20 nodes per session whiteboard, ~50 per daily overview. If exceeding, group into clusters.
4. **Semantic colors only** — Green=completed, yellow=active, blue=context, red=blocked. No decorative color.
5. **Shapes encode type** — Rectangle=system, ellipse=task, diamond=decision. Consistent across all visuals.
6. **Cross-domain links are gold** — When two topics from different sessions or areas connect, that edge is high-value. Use `weak-edge` class (dashed) to visually distinguish cross-links from within-cluster edges.

## Rollup templates

| Rollup type | Visual format | Tool | Data source |
|---|---|---|---|
| Sprint retro | Timeline + outcome badges | AntVis `sequence-timeline-simple` | Dataview: outcomes by date in range |
| Weekly digest | Swimlane by area/day | AntVis `list-grid-badge-card` | Dataview: outcomes grouped by tag |
| Project overview | Concept map filtered by tag | Cytoscape.js | Dataview: outcomes + next-steps matching tag |
| Velocity dashboard | Bar chart: outcomes/day | AntVis or Mermaid xychart | Dataview: outcome count per day |

## When to update (cadence)

| Trigger | Action |
|---|---|
| Session starts | Create session whiteboard with context-seeded skeleton |
| Task completed | Add completed node, update edges, mark green |
| New investigation started | Add active node with relationship to trigger |
| Connection discovered | Add cross-domain edge (weak-edge class) |
| Topic pivot | Add new cluster area in the session whiteboard |
| Session ends | Finalize whiteboard, merge key nodes into daily overview |
| User requests rollup | Query Dataview, generate rollup visual |
