# Mehrpele — Markdown inside Pele diagrams

Mehrpele renders full Obsidian Markdown — wikilinks, embeds, math, callouts,
tags, images, `.base` views (including base-graph) and `.canvas` embeds —
inside diagram nodes. The idea comes from the
[Mehrmaid](https://github.com/huterguier/obsidian-mehrmaid) plugin; Mehrpele is a
separate implementation on top of Pele.

## Usage

Use the `mehrpele` language. **Any double-quoted label is Markdown; any
unquoted label is plain text.**

````markdown
```mehrpele
flowchart LR
  A["**Start** — see [[Welcome]]"] -->|"costs $x^2$"| B
  B{"[[Decision#Criteria|Which path?]]"} --> C["> [!note] Plain shapes still work"]
  C --> D["![[Projects.base#Table]]"]
```
````

- Applies to node labels, edge labels and subgraph titles.
- `\"` inside a quoted label is a literal quote; multi-line labels use real
  newlines (tables work). `\n` is literal text, not an escape.
- Plain `mermaid`/`pele` blocks opt in with a `%% mehrpele %%` directive
  anywhere in the block, or for the whole vault via the *Markdown labels in
  mermaid/pele blocks* setting (`off` / `directive only` / `always`).

## Embeds in nodes

A label that is exactly one embed gets a fixed-size node (default 320×240,
`|400x300` in the embed overrides, hard caps in settings) whose contents
scroll instead of reflowing the diagram:

```mehrpele
flowchart TD
  P["![[Projects.base#Table]]"] --> Q["![[Projects.base#Graph]]"]
  Q --> R["![[Board.canvas]]"]
```

`.base#Graph` renders the base-graph view when that plugin is installed.
Embeds render lazily (near the viewport) unless disabled in settings.

## Diagram from a Base (Bases view)

The `mehrpele-diagram` Bases view type ("Diagram") generates a flowchart or
mindmap from the query result: one node per entry, edges from a chosen link
property, groups as subgraphs. View options (link/label property, direction,
kind, max nodes) live in the `.base` file like other Bases views. *Copy Pele
source* on the view gives you the generated source.

## How it works (and its limits)

Pele labels are SVG text, so Mehrpele measures each label's rendered HTML
off-screen, reserves that content size in the Pele layout (placeholder labels +
a wrapped text measurer, Pele adds its normal node padding around it), renders
with Pele, then overlays the real HTML over each node.

Sizing rules:

- **Units.** Overlay HTML is laid out 1:1 (CSS px = SVG units) and CSS-scaled
  with the diagram, so a shrunk-to-fit or resized diagram scales its labels
  like SVG text. Measurements use the layout box, which a transform doesn't
  change, so reservations don't depend on the current zoom.
- **Re-measure.** MathJax, images and callouts settle late. After placement,
  each label's in-place content box is compared with its reservation. If any
  differs by more than 2 units, Pele re-renders with the corrected sizes (at
  most 2 extra passes per cycle; the overlay is repositioned on the next
  animation frame, never inside a ResizeObserver callback).
- **No hidden wrapping.** The placeholder line is inert text (no TeX
  backslashes, entities or quotes) and can't trigger Pele's word wrap, so the
  reservation alone decides each node's height.
- **Images.** Image embeds (`![[x.png|100]]`) size to the rendered image
  rather than the fixed embed box. Other embeds (notes, `.base`, `.canvas`)
  keep the fixed `|WxH` / default box. Verified exact for flowchart rectangles; state/sequence
boxes land within a few px; diamonds, class headers and mindmap nodes get a
centred overlay over the reserved label area. If an overlay cannot be
placed, the plain SVG text stays — diagrams never break.

Copy/export/lightbox-without-overlay ship the plain-text fallback labels
(links collapse to their display text). In-place Pele zoom is off for
Mehrpele frames in v1; the lightbox provides zoom.
