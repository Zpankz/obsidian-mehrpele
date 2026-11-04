# Materialise diagram as notes

Command: **Pele: Materialise diagram as notes** (palette; Live Preview, Source and
Reading view). CLI: `pele:materialise path=<note> index=N [dry-run] [root=<folder>]
[on-existing=link|skip|suffix] [no-rewrite]`.

It turns a flowchart or state diagram into real notes, then rewrites the block so
every node embeds its note. The diagram source stays in the note, and every node is
then a resizable Mehrpele note embed (`|WxH`).

## DESIGN

### Mapping

| Diagram | Vault |
|---|---|
| subgraph / composite state | folder (nested → nested folders) under the root |
| node | note `<folder>/<title>.md`; the title is the label made filename-safe |
| edge with label `L` | property `L` (slugified, or verbatim) on the source note, holding `"[[target]]"` |
| edge without label | property `canvas-link` (setting) on the source note |
| several targets for one key | a list; one target stays a single link |
| node label `![[Note]]` (existing note) | that note is used as is (no new note) |
| node label `![[img.png]]`, `.base`, `.canvas` | media: left alone; it can be a link target, never a property holder |
| `[*]`, choice, fork and join pseudo-states | skipped |
| edge to or from a subgraph | skipped, with a warning (folders cannot hold properties) |

Root folder: setting `{{folder}}/{{note}}`, i.e. a folder named after the note, next
to it. `root=` on the CLI overrides it.

### Pipeline (pure, then Obsidian)

1. `src/materialise/graph.ts` (pure): diagram → `DiagramGraph`, built on
   pele-render's `mermaidToCanvas`. That gives nodes, labels, file and embed
   nodes, groups and edge labels for flowchart and state diagrams. Group
   membership comes from Pele's parse model (flowchart `subgraphs[].nodes`, state
   `parentId`), not from geometry. Mehrpele blocks are parsed through their render
   source (labels as fallback text); node label Markdown comes from Mehrpele's
   label scanner. Every other type is refused: class diagrams have no Canvas
   conversion yet, and sequence, mindmap and the rest have no node/edge model that
   maps to notes.
2. `src/materialise/plan.ts` (pure): `DiagramGraph` + `VaultView` (lookups only) +
   options → `MaterialisePlan`: folders to create, notes (create, reuse, link,
   skip or media, with full file content for creates), property writes on existing
   notes (before → after), the rewritten block and warnings. Deterministic.
3. `src/materialise/rewrite.ts` (pure): a minimal in-place rewrite of the block
   source. Only label spans change: `A[Old]` → `A["![[Root/Folder/A]]"]`, keeping
   the shape. A node that never had a label gets one at its first bare mention.
   State descriptions become `Id : "![[…]]"`. `%% mehrpele %%` is added to
   `mermaid`/`pele` blocks that are not Mehrpele yet. Comments, `classDef`/`style`/
   `click` lines, subgraph headers, edge labels and quoted text are never touched.
   Every `%%` line is kept verbatim, including the `%% pele-size … %%` node
   sizes, `%% pele-reflow … %%` directives and `%%{init}%%`. Node ids don't
   change, so existing sizes still apply.
4. `src/materialise/apply.ts`: executes a plan through a `VaultOps` port, with
   Obsidian's implementation in `src/materialise/obsidian.ts`
   (`vault.createFolder`, `vault.create`, `fileManager.processFrontMatter`,
   `fileManager.trashFile`). It returns an undo record. There is no raw fs.
5. Block rewrite: Live Preview/Source makes one CodeMirror transaction (body
   replace plus the `^block-id` insert), so it is one Cmd/Ctrl+Z. Reading view
   makes one `vault.process` call that runs `replaceBlockBody` with the expected
   source, so a block that changed meanwhile aborts the write.

### Preview first

A modal lists the folders, notes (with action and reason), property writes,
warnings and the before/after block. The existing-note policy, block rewrite toggle
and root folder can be changed there, which re-plans. **Materialise** applies, and
**Cancel** changes nothing. If the plan has nothing to do, it says so and offers
only Close.

Existing notes are never overwritten:
- **link** (default): use the existing note: embed it and add properties to it.
- **skip**: leave that node alone (its label and its outgoing edges).
- **suffix**: create `Title 2.md` (then ` 3`, …).

### Provenance and idempotency

Every created note gets `pele-materialised: "[[<source note>#^<block id>]]"` and
`pele-node: "<id>"` in its frontmatter. The block id is the existing `^id` after the
fence, or a new `^pele-<hash>` (the same scheme as "Copy link to diagram"), inserted
in the same edit as the rewrite.

Re-running:
- A node whose label already embeds a note, or whose planned path holds a note
  with this block's provenance and node id, is **reuse**: nothing is created.
- Property merges add only the links that are missing; links are compared by
  resolved path.
- A block identical to the rewrite is not written.
- So a second run is a no-op. After a diagram edit, only new nodes, folders and
  links are added. Removed edges are never deleted from properties.

### Undo

The final Notice lists the created files and has **Undo materialise**. The command
**Undo last materialise** does the same until Obsidian or the plugin restarts. Undo:
- trashes only files this run created that still carry its provenance; a file that
  existed before is never in the record, so it is never trashed;
- trashes created folders only when they are empty afterwards, deepest first;
- restores each property it wrote, but only if the value is still what was
  written; otherwise it is reported and left alone;
- reverts the block to its previous source if it is unchanged since; in Live
  Preview, Cmd/Ctrl+Z also undoes the rewrite on its own.

### Labels and filenames

The Markdown label is reduced to plain text (Mehrpele fallback rules), then made
filename-safe:
- `\ / :` become `-`;
- `* " < > | ? # ^ [ ]` become spaces;
- whitespace is collapsed and trimmed;
- leading dots, and trailing dots and spaces, are removed;
- Windows device names (`CON`, `NUL`, …) get `_`;
- the result is capped at 120 characters, and an empty result falls back to the
  node id.

Title clashes in one folder are compared case-insensitively (macOS and Windows
filesystems) and get ` 2`, ` 3`, ….

Obsidian titles every note embed with the file name, whatever the inline-title
setting is. So in the rewritten diagram the title is the node's visible label, and
the note body never repeats it:
- **Body:** empty when the label's plain text is the title. It is the original
  label Markdown only when the filename rules changed the visible text
  (`What? Why/How` → `What Why-How`, or a truncated label), because the title
  can't show that.
- **Aliases:** the original label, verbatim, whenever it differs from the title.
  This covers formatting (`**Bold** idea`), a suffix (`Step` → `Step 2`) and
  dropped characters, so nothing from the label is lost.

Property keys: slugified (`depends on` → `depends-on`, the default) or verbatim.
Keys that would clash with Obsidian's own properties (`tags`, `aliases`,
`cssclasses`, …) or with the provenance keys get a `-link` suffix.

### Settings (Settings › Materialise)

`root folder` (`{{folder}}/{{note}}`), `default edge key` (`canvas-link`),
`property names` (slug | verbatim), `rewrite block` (on), `existing notes` (link |
skip | suffix).

### Limits

- Mehrpele must be enabled for the rewritten block to render embeds. The preview
  warns when it is off, or when the node count exceeds Mehrpele's label cap.
- Note embeds default to Mehrpele's embed size (320×240), so a materialised diagram
  is larger until nodes are resized. Each embed node has both handles: the box
  handle writes `%% pele-size %%`, and the content handle writes the embed's
  `|WxH`.
- Property writes are append-only: removing an edge never removes its link.
- `[*]`, choice, fork and join pseudo-states and their edges are skipped. So are
  edges to subgraphs, and edges from media nodes.
- There is no pele-render (standalone CLI) `materialise`. The planner reads
  frontmatter through Obsidian's metadata cache and writes through Obsidian
  APIs.
- With several diagrams in one note, set a root per diagram (CLI `root=`, or the
  modal), or their notes share a folder.
