# Pele integrations: Breadcrumbs, Datacore, TaskNotes, Advanced URI, Extended Graph

Read-only diagrams generated from other plugins' data. All three are **off by
default** (Settings → Mehrpele → Integrations) and need a plugin reload
after toggling, because Obsidian registers code-block processors at load.

Shared plumbing: partner data → plain spec → Pele source
(`src/integrations/graph-to-pele.ts`). Every generated node with a note path
emits a `click` line, so Pele's internal-link routing, hover previews and the
lightbox work exactly as for hand-written diagrams. Generated `classDef`
statements never hard-code colours — theme colours come from CSS classes
(`integrations.css`, `--pele-*` variables).

## Deep links (Advanced URI)

`GraphNode` carries optional `heading` / `block` next to `href`. When
[Advanced URI](https://github.com/Vinzent03/obsidian-advanced-uri) is enabled
(`obsidian-advanced-uri`), such nodes emit
`click id "obsidian://adv-uri?vault=<enc>&filepath=<enc>&heading=<enc>"`
(or `&block=<id>`). Otherwise they emit the internal-link form
`path#heading` / `path#^block`. Datacore `@section` / `@block` results fill
these automatically. Pele 1.12+ renders `click` targets verbatim (1.6.0
percent-decoded them twice and needed a `%` pre-escape). A real-render test
guards that the rendered `<a href>` is exactly the intended single-encoded
URI, and that the link guard classifies it as navigation. The
classifier treats `&`/`=` inside a decoded filename or heading as text. Nested
*dangerous* names (`commandid`, `data`, …) still block.

Diagrams in notes also get "Copy link to this diagram" /
"Copy wikilink to this diagram" in the context menu (see README → Context menu).

## Extended Graph colours

Setting: Integrations → **Use Extended Graph colours** (default off). Needs
Extended Graph (`extended-graph`, GPLv3) to be enabled. Pele reads only its
in-memory settings object at render time and copies none of its code.

| Extended Graph setting | Pele mapping |
|---|---|
| `interactiveSettings.tag.colors[]` `{type,color}` | node class `pele-eg-tag-<type>`; exact tag first, then parent tag (`area` colours `area/x`) |
| `interactiveSettings.<property>.colors[]` | node class `pele-eg-<property>-<value>` (frontmatter value match) |
| `interactiveSettings.folder.colors[]` (`recursive`) | node class by the note's folder |
| `useForNodeColor: true` on a key | that key wins the node colour |
| `interactiveSettings.link.colors[]` | `linkStyle N stroke:<color>` for edges whose kind (Breadcrumbs field, …) matches |
| `shapeQueries.<shape>.rules[]` (lowest `index` first) | nearest shape: circle, square→rect, diamond, polygons→hexagon; stars keep the default |

Colours become theme-safe classDefs: `fill:<hex>33,stroke:<hex>,stroke-width:2px`
(translucent fill, so labels stay readable in light and dark themes). Only
explicit colours are mapped; colours Extended Graph derives from a colormap
are not reproduced. If its settings object is missing or has an unexpected
shape, Pele logs once and renders default colours. Applies to
`pele-breadcrumbs`, `pele-datacore`, `pele-tasks view: dependencies`
flowcharts and the Mehrpele Bases "Diagram" view (colours only there). Gantt
and kanban views are unaffected. Colours are re-read on every render. Pele
does not subscribe to Extended Graph's change events, so re-open the note to
pick up colour edits.

## Breadcrumbs (` ```pele-breadcrumbs `)

Neighbours of a note as a typed-edge flowchart, via `window.BCAPI` /
`app.plugins.plugins["breadcrumbs"].api` (`get_neighbours`, Breadcrumbs
4.22.1). Self-loops and implied/transitive edges are filtered unless asked.

````markdown
```pele-breadcrumbs
start: Projects/Home
fields: [up, down]
depth: 2
direction: LR
implied: false
```
````

| Option | Default | Meaning |
|---|---|---|
| `start` | current note | Start note path or linktext |
| `fields` | all | Edge fields to follow (`up/down/same/next/prev` or custom) |
| `depth` | 2 | BFS depth (0–10) |
| `direction` | LR | `TD/TB/LR/RL/BT` |
| `implied` | false | Include implied edges (dimmed/dashed) |
| `mehrpele` | false | Reserved: render node labels with Mehrpele |

Re-renders (debounced) when Breadcrumbs fires its graph-update event. If
Breadcrumbs is missing or disabled, the block shows a one-line notice instead
of failing.

## Datacore

Two directions:

1. **Pele inside Datacore (recommended).** With the Datacore integration on,
   Pele publishes `window.peleMermaid = { version, mount(el, source, opts?),
   render(source, opts?), component(dc) }`. In a `datacorejsx` block,
   Datacore supplies reactive data and Pele supplies the themed SVG:

   ```jsx
   const Pele = window.peleMermaid.component(dc);
   return function View() {
     const rows = dc.useQuery("@page and #project");
     // Build Pele source from rows (flowchartFromGraph logic, inlined —
     // datacore blocks cannot import Pele modules):
     const src = "flowchart LR\n" + rows.map((r, i) => `  n${i}["${r.$name}"]`).join("\n");
     return <Pele source={src} />;
   }
   ```

   `component(dc)` returns a Preact component that mounts Pele into a ref
   and destroys it on unmount. Without JSX, call
   `window.peleMermaid.mount(el, source)` directly and keep the returned
   handle's `destroy()`.

   `window.peleMermaid` is this plugin's API (bundled `pele@1.13.0`);
   `window.pele` is Obsidian 1.15+'s core Pele, which Mehrpele leaves
   alone. Use `window.peleMermaid` for Mehrpele's themed frames.

2. **Datacore inside Pele.** A ` ```pele-datacore ` block runs
   `window.datacore.api.tryQuery` (Datacore 0.1.29) and maps results to a
   link flowchart (default) or a date Gantt. Reactive on Datacore `update`
   events (debounced, revision-checked):

   ````markdown
   ```pele-datacore
   query: "@page and #project"
   diagram: flowchart
   ```
   ````

## TaskNotes (` ```pele-tasks `)

Tasks from `app.plugins.plugins["tasknotes"].api` (API v1: `listTasks`,
`getTaskDependencies`, `getBlockingTasks`) as Gantt, dependency flowchart or
kanban. Read-only — no write-back. Clicking a bar/node opens the task
note. Re-renders on `task.*` events.

````markdown
```pele-tasks
view: gantt
tags: [work]
project: Alpha
group: project
```
````

| Option | Default | Meaning |
|---|---|---|
| `view` | gantt | `gantt` / `dependencies` / `kanban` |
| `status` / `filter` | — | Status value(s) to keep |
| `tags` | — | Tag(s) to keep |
| `project` | — | Project to keep |
| `group` | project | Gantt section field: `project` / `status` / `tag` |

Gantt mapping: `scheduled`→bar start, `due`→bar end, `blockedBy`→`after`
dependencies; status → `done`/`active`/`crit` via a configurable mapping
(done statuses are also read from TaskNotes' own status configs at runtime).
Tasks without dates are skipped in Gantt view (use `view: dependencies`).

## Limits

Node caps (default 200 per integration, block-level `maxNodes`) collapse
excess into a single "…N more" node. TaskNotes support targets TaskNotes 4.13.9.
