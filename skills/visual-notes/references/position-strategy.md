# Node Position Strategy

Rules for computing node positions in Cytoscape.js concept maps.

## Grid baseline

- Canvas origin: (0, 0) at top-left
- Node spacing: 200px horizontal, 150px vertical
- Session clusters offset 450px horizontally from each other

## New session cluster

When starting a new session within a daily overview:
1. Find the rightmost x-coordinate of existing nodes
2. Add 450px horizontal offset for the new cluster
3. Place the first node (session anchor) at (offset, 150)
4. Subsequent nodes in the session radiate from the anchor:
   - Related systems: anchor.x - 100, anchor.y +/- 100
   - Outcomes: anchor.x + 200, anchor.y +/- 75
   - Decisions: anchor.x + 100, anchor.y + 200

## Adding nodes to an existing session

1. Find the parent/related node this new node connects to
2. Place the new node 150-200px away from the parent
3. Direction: prefer downward (y + 150) if space is available
4. If downward is occupied (another node within 100px), shift right (x + 200)

## Cross-domain edges

Cross-domain edges connect nodes in different session clusters.
No position change needed — just add the edge. Cytoscape bezier curves handle the visual.

## Complexity ceiling

If total nodes exceed 50, stop adding individual nodes. Instead:
1. Group related nodes into a single "cluster" node with a summary label
2. Link the cluster node to its dependencies
3. Add a note in the node label: "(3 items — see session 2)"
