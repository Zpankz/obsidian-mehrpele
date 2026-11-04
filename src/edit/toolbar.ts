/**
 * Hover / select toolbar for diagram nodes, edges and subgraphs — Obsidian
 * Canvas's floating node menu (`.canvas-menu` + `clickable-icon` buttons,
 * `.canvas-submenu` colour picker with `mod-canvas-color-N` swatches, and icon
 * popovers in that style for text size, shape and edges), so it
 * looks and behaves like the native one in every theme.
 *
 * - Hover outlines an element on its real shape and floats the menu above it.
 * - A click selects (solid outline, menu stays); Shift/Cmd/Ctrl-click adds or
 *   removes; a drag on empty diagram space draws a marquee; a click on empty
 *   space, a click elsewhere or Esc clears. Touch: hidden until tapped.
 * - With several items selected, style actions apply to all of them as one
 *   edit; "+" groups the nodes into a new subgraph and "→" adds one child
 *   shared by all. A single selected node gets four "+" buttons on its sides
 *   (parent / child / siblings by the effective layout direction); Cmd/Ctrl
 *   on a "+" asks the configured model for label suggestions.
 * - Every action computes the new block source (ops.ts) and hands it to the
 *   frame's persist path: one undoable transaction in Live Preview, one
 *   checked file write with an Undo notice in Reading view. Only trusted
 *   clicks write; hovering, menus, selecting and cancelling never do.
 * - Follow-ups that must survive the re-render a write causes (open the
 *   editor on a new node, keep a selection) are handed to whichever layer
 *   shows that note once its diagram has settled.
 */
import { Notice, Platform, setIcon, setTooltip, type App } from "obsidian";
import type { Relation, Side } from "./concept-edit";
import { effectiveDirection, relationFor } from "./concept-edit";
import { isShown, pickResume, type Origin } from "./follow-pick";
import { openInlineEditor, type InlineEditorHandle } from "./inline-editor";
import { hideLabel, labelPlacement, targetElement } from "./label-place";
import { shapeClientBox, type ClientBox } from "./node-geometry";
import {
  addConnectedNode,
  addNode,
  addSharedChild,
  connectNodes,
  analyse,
  applyEditMany,
  groupIntoSubgraph,
  readText,
  supportsEditing,
  type Capabilities,
  type EditContext,
  type EditOp,
  type EditTarget,
  type ShapeOption,
} from "./ops";
import { groupShapes, HEAD_GLYPHS, shapeGlyph, shapeGrid, STROKE_GLYPHS } from "./glyphs";
import { gridMove } from "../grid-nav";
import { isCanvasLayout, pinAtDrop } from "./canvas-pos";
import { DRAG_THRESHOLD_PX } from "../drag-move";
import { layoutBox } from "../node-outline";
import { parse, render } from "pele-render/pele";
import { nodeBoxMap } from "pele-render/node-size";
import { syncModIcons } from "./mod-icons";
import { OutlineOverlay } from "./outline";
import { placeCluster, placeSubmenu, placeToolbar, visibleBounds, type Box } from "./placement";
import { openEmbedInsert } from "./embed-insert"; // embed-insert
import { GROUPS, type GroupId } from "./embed-insert/catalog"; // embed-insert
import { attachEmbedAccessory } from "./embed-insert/accessory"; // embed-insert
import { bareFolderTarget } from "../mehrpele/views/folder"; // view-nodes
import type { EditSettings } from "./settings";
import { PRESETS, normalizeHex, type ColorChoice, type TextSize } from "./style-lines";
import type { FlowStroke } from "./flow-scan";
import type { Heads } from "./flow-edit";

export interface SuggestRequest {
  source: string;
  nodeId: string;
  nodeText: string;
  relation: Relation | "shared-child";
  others?: string[];
}

export interface EditLayerHost {
  app: App;
  /** The frame root (`.pele-embed`) and its `.pele-host` wrapper. */
  root: HTMLElement;
  wrapper: HTMLElement;
  /** This diagram's own SVG (nested diagrams have their own layers). */
  svg(): SVGSVGElement | null;
  source(): string;
  /** Pele diagram type of the current render. */
  diagramType(): string | null;
  /** Layout direction the reflow plan shows ("TB", "LR", "authored", …), if any. */
  direction?(): string | null;
  sourcePath: string;
  settings(): EditSettings;
  /** Quoted labels are Markdown here; may switch to Mehrpele. */
  labelMode(): { markdownBlock: boolean; canSwitch: boolean };
  /** Edits reach the note (else they are in memory only: toolbar hidden). */
  writable(): boolean;
  /** Write `next` as one edit; `what` names it in notices. */
  persist(next: string, what: string): Promise<boolean>;
  /** Label suggestions from the configured model; null = not configured. */
  suggest?(req: SuggestRequest): Promise<string[]> | null;
  /** Open the plugin's settings (unconfigured autocomplete). */
  openSettings?(): void;
  /**
   * The zoom for a node: its own nested diagram's when it has one, else this
   * diagram's (null node: the diagram's); null when there is none (lightbox).
   */
  zoom?(nodeId: string | null): (() => void) | null;
}

const HANDLED = Symbol.for("pele-edit.handled");
const SKIP =
  "a, input, textarea, button, .image-resize-corner, .pele-node-handle, .mehrpele-node-resize, .embed-actions, .pele-error, " +
  ".internal-embed, .mehrpele-embed, .bases-view, .canvas-wrapper, .pele-source-panel, .mehrpele-label .callout-fold";

export const EDIT_HIT_CLASS = "pele-edit-hit";

function cssEscape(s: string): string {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, "\\$&");
}

interface Hit {
  target: EditTarget;
  /** The SVG element (node group, edge group or cluster group). */
  el: Element;
}

const keyOf = (t: EditTarget) => `${t.kind}:${t.id}`;

const SIZE_NAMES: Array<[TextSize | null, string]> = [
  ["s", "Small"],
  [null, "Medium (default)"],
  ["l", "Large"],
  ["xl", "Extra large"],
];

/** What the menu offers for the current target(s): the capabilities all of them share. */
interface Combined {
  targets: EditTarget[];
  label: string;
  color: boolean;
  currentColor: ColorChoice | undefined;
  textSize: boolean;
  currentSize: TextSize | null | undefined;
  shapes: ShapeOption[] | null;
  currentShape: string | null | undefined;
  lineStyle: boolean;
  currentStroke: FlowStroke | null | undefined;
  heads: boolean;
  currentHeads: Heads | null | undefined;
  editText: boolean;
  delete: boolean;
  deleteName: string;
  note?: string;
  group: boolean;
  sharedChild: boolean;
  /** Single flowchart node: the side "+" buttons. */
  plus: boolean;
  /** embed-insert: one node whose label may become (or gain) an embed. */
  insertEmbed: boolean;
}

function combine(list: Capabilities[]): Combined {
  const one = list.length === 1 ? list[0] : null;
  const all = (f: (c: Capabilities) => boolean) => list.every(f);
  // undefined = mixed values (never "already set": picking one writes it to all).
  const same = <T>(f: (c: Capabilities) => T): T | undefined => {
    const v = list.map(f);
    return v.every((x) => JSON.stringify(x) === JSON.stringify(v[0])) ? v[0] : undefined;
  };
  const nodes = all((c) => c.target.kind === "node");
  return {
    targets: list.map((c) => c.target),
    label: one ? one.label : `${list.length} items`,
    color: all((c) => c.color),
    currentColor: same((c) => c.currentColor),
    textSize: all((c) => c.textSize),
    currentSize: same((c) => c.currentSize),
    shapes: all((c) => !!c.shapes) ? (list[0].shapes ?? null) : null,
    currentShape: same((c) => c.currentShape),
    lineStyle: all((c) => c.lineStyle),
    currentStroke: same((c) => c.currentStroke),
    heads: all((c) => c.heads),
    currentHeads: same((c) => c.currentHeads),
    editText: !!one?.editText,
    delete: all((c) => c.delete),
    deleteName: one ? one.deleteName : `Delete ${list.length} items`,
    ...(one?.note ? { note: one.note } : {}),
    // view-nodes: view nodes take part in structure edits though their text is not editable.
    group: list.length >= 2 && nodes && all((c) => !!c.shapes && (c.editText || !!c.viewNode)),
    sharedChild: list.length >= 2 && nodes && all((c) => !!c.shapes && (c.editText || !!c.viewNode)),
    plus: !!one && one.target.kind === "node" && !!one.shapes && (one.editText || !!one.viewNode),
    // embed-insert: writes the label, so only where the text is editable (not view nodes).
    insertEmbed: !!one && one.target.kind === "node" && one.editText,
  };
}

// -- follow-ups across re-renders -----------------------------------------------------------

/** Every live layer (a write re-creates frames; follow-ups find the new one). */
const layers = new Set<EditToolbarLayer>();

interface FollowUp {
  sourcePath: string;
  targets: EditTarget[];
  edit?: { suggestions?: Promise<string[]>; chain: boolean; initialText?: string };
}

let followUp: FollowUp | null = null;
let followTimer = 0;

/**
 * Run `f` once the diagram has settled (≤ 4 s), on the layer at `origin`:
 * the same leaf and place, shown on screen (follow-pick.ts).
 */
function scheduleFollowUp(f: FollowUp, origin: Origin): void {
  followUp = f;
  const until = performance.now() + 4000;
  window.clearInterval(followTimer);
  followTimer = window.setInterval(() => {
    if (followUp !== f || performance.now() > until) {
      window.clearInterval(followTimer);
      if (followUp === f) followUp = null;
      return;
    }
    const cands = [...layers]
      .filter((l) => l.sourcePath === f.sourcePath)
      .map((l) => ({ ref: l, ...l.place(), visible: l.shown(), ready: l.canResume(f) }));
    const layer = pickResume(cands, origin);
    if (!layer) return;
    window.clearInterval(followTimer);
    followUp = null;
    layer.resume(f);
  }, 120);
}

export class EditToolbarLayer {
  private menuEl: HTMLElement | null = null;
  private plusEls: HTMLElement[] = [];
  /** Edit, zoom and delete beside the target's bottom-right corner (its resize handle). */
  private clusterEl: HTMLElement | null = null;
  private readonly outlines: OutlineOverlay;
  private hover: Hit | null = null;
  private selection: Hit[] = [];
  private hideTimer = 0;
  private overMenu = false;
  private editor: InlineEditorHandle | null = null;
  /** The open editor's target and options (handed over if this frame is replaced). */
  private editing: { target: EditTarget; suggestions?: Promise<string[]>; chain: boolean } | null = null;
  private handingOver = false;
  private busy = false;
  private mutations: MutationObserver | null = null;
  private hitsFor: SVGSVGElement | null = null;
  private submenu: HTMLElement | null = null;
  /** Where the toolbar sits (client px) and on which side of the selection. */
  private toolbarBox: (Box & { side: "above" | "below" }) | null = null;
  /** The toolbar button that opened the popover (focus returns there when it closes). */
  private subAnchor: HTMLElement | null = null;
  /** A "+" is being dragged to connect (hover handling stands down). */
  private connecting = false;
  /** When a "+" drag ended: the click that follows it is not an "add". */
  private connectEndedAt = 0;
  /** embed-insert: undo what opening the popover changed ("+" buttons hidden). */
  private onSubmenuClose: (() => void) | null = null;
  private embedAccessory: (() => void) | null = null;
  private lastMutation = performance.now();
  /** This frame's leaf and place, as last seen attached (see place()). */
  private lastPlace: Origin = { leaf: null, order: -1 };
  private marquee: { x: number; y: number; id: number; el: HTMLElement | null; add: boolean } | null = null;
  private suppressClick = false;
  private listening = false;
  /** The document the document-level listeners are on (while listening). */
  private listenDoc: Document | null = null;

  /**
   * The diagram's document, looked up when used: a frame is built before it
   * is placed, and one placed in a popout window lives in that window's.
   */
  private get doc(): Document {
    return this.host.wrapper.ownerDocument;
  }

  constructor(private host: EditLayerHost) {
    this.outlines = new OutlineOverlay(() => this.doc);
    layers.add(this);
    host.wrapper.addEventListener("pointermove", this.onMove);
    host.wrapper.addEventListener("pointerleave", this.onLeave);
    host.root.addEventListener("pointerdown", this.onPointerDown);
    host.wrapper.addEventListener("click", this.onClick, true);
    host.wrapper.addEventListener("dblclick", this.onDblClick, true);
    host.wrapper.addEventListener("pele-node-select", this.onNodeSelect); // view-nodes: a view's title selects its node
    if (typeof MutationObserver !== "undefined") {
      this.mutations = new MutationObserver(() => this.onMutate());
      this.mutations.observe(host.wrapper, { childList: true, subtree: true });
    }
  }

  destroy(): void {
    layers.delete(this);
    this.mutations?.disconnect();
    this.mutations = null;
    this.host.wrapper.removeEventListener("pointermove", this.onMove);
    this.host.wrapper.removeEventListener("pointerleave", this.onLeave);
    this.host.root.removeEventListener("pointerdown", this.onPointerDown);
    this.host.wrapper.removeEventListener("click", this.onClick, true);
    this.host.wrapper.removeEventListener("dblclick", this.onDblClick, true);
    this.host.wrapper.removeEventListener("pele-node-select", this.onNodeSelect);
    this.endMarquee(null);
    if (this.editor && this.editing) {
      // The frame is being replaced (Reading view re-renders the section after
      // a write): carry the open editor, its text and suggestions to the new one.
      const text = this.editor.value();
      const e = this.editing;
      this.handingOver = true;
      this.editor.cancel();
      scheduleFollowUp({
        sourcePath: this.host.sourcePath,
        targets: [e.target],
        edit: { chain: e.chain, initialText: text, ...(e.suggestions ? { suggestions: e.suggestions } : {}) },
      }, this.place());
    } else this.editor?.cancel();
    this.clear();
    this.outlines.destroy();
  }

  // -- context ---------------------------------------------------------------------

  private ctx(): EditContext {
    const mode = this.host.labelMode();
    return {
      source: this.host.source(),
      type: this.host.diagramType() ?? "",
      ...mode,
      isFolderEmbed: (t) => !!bareFolderTarget(this.host.app, t, this.host.sourcePath), // view-nodes
    };
  }

  private active(): boolean {
    const s = this.host.settings();
    return (
      (s.toolbar || s.inlineEdit) &&
      supportsEditing(this.host.diagramType()) &&
      this.host.writable() &&
      !this.host.wrapper.classList.contains("is-node-resizing") &&
      !this.host.root.classList.contains("is-resizing") &&
      !this.host.wrapper.closest(".lightbox, .pele-lightbox")
    );
  }

  get sourcePath(): string {
    return this.host.sourcePath;
  }

  shown(): boolean {
    return isShown(this.host.wrapper);
  }

  /**
   * Where this frame is (its leaf's view, its index among that view's
   * visible diagrams). Kept from when it was last shown: a frame being
   * replaced or re-rendered may be out of the page or empty.
   */
  place(): Origin {
    const w = this.host.wrapper;
    if (isShown(w)) {
      // The leaf's Reading or editing view: a note in Reading view keeps its
      // (hidden) editor with its own copies of the diagrams.
      const leaf = w.closest(".markdown-reading-view, .markdown-source-view, .workspace-leaf");
      const scope = leaf ?? w.ownerDocument.body;
      const shown = [...scope.querySelectorAll(".pele-host")].filter((h) => (leaf ? true : !h.closest(".workspace-leaf")) && isShown(h));
      this.lastPlace = { leaf, order: shown.indexOf(w) };
    }
    return this.lastPlace;
  }

  /** This layer shows `f`'s note and targets, and has not re-rendered for a moment. */
  canResume(f: FollowUp): boolean {
    const svg = this.host.svg();
    return (
      this.host.sourcePath === f.sourcePath &&
      this.host.wrapper.isConnected &&
      // A leaf keeps its other mode's render hidden: only a visible layer resumes (else the editor opens at 0,0).
      this.host.wrapper.getClientRects().length > 0 &&
      !!svg &&
      performance.now() - this.lastMutation > 350 &&
      f.targets.every((t) => !!targetElement(svg, t))
    );
  }

  resume(f: FollowUp): void {
    const svg = this.host.svg();
    if (!svg) return;
    this.selection = f.targets.map((t) => ({ target: t, el: targetElement(svg, t)! }));
    if (f.edit && f.targets.length === 1) {
      const target = f.targets[0];
      this.render();
      this.editText({ target }, {
        ...(f.edit.suggestions ? { suggestions: f.edit.suggestions } : {}),
        ...(f.edit.initialText !== undefined ? { initialText: f.edit.initialText } : {}),
        chain: f.edit.chain,
        // Enter: the new node stays selected, ready for the next "+".
        after: (saved) => {
          if (saved) scheduleFollowUp({ sourcePath: this.host.sourcePath, targets: [target] }, this.place());
          else this.select([target]);
        },
      });
      return;
    }
    this.render();
  }

  private select(targets: EditTarget[]): void {
    const svg = this.host.svg();
    if (!svg) return;
    this.selection = targets.flatMap((t) => {
      const el = targetElement(svg, t);
      return el ? [{ target: t, el }] : [];
    });
    this.render();
  }

  // -- hit testing -----------------------------------------------------------------

  /** The editable element under an event, if this layer owns it. */
  hitAt(ev: MouseEvent): Hit | null {
    const svg = this.host.svg();
    const t = ev.target as Element | null;
    if (!svg || !t || !(t.instanceOf(Element))) return null;
    if (t.closest(SKIP)) return null;
    // A nested diagram inside a label owns its own elements.
    const nested = t.closest(".pele-embed");
    if (nested && nested !== this.host.root) return null;
    let el: Element | null = t.closest("svg") === svg ? t : null;
    // view-nodes: a live view's dock sits over its node like an HTML label.
    if (!el && t.closest(".mehrpele-overlay-item, .mehrpele-view-dock")) {
      // Mehrpele: the HTML label sits over the SVG; find what is under it.
      el = this.doc.elementsFromPoint(ev.clientX, ev.clientY).find((e) => e.closest("svg") === svg) ?? null;
    }
    if (!el) return null;
    const node = el.closest(".pele-node[data-id]");
    if (node) return { target: { kind: "node", id: node.getAttribute("data-id")! }, el: node };
    const edge = el.closest(".pele-edge[data-id], .pele-edge-label[data-id]");
    if (edge) {
      const id = edge.getAttribute("data-id")!;
      return { target: { kind: "edge", id }, el: svg.querySelector(`.pele-edge[data-id="${cssEscape(id)}"]`) ?? edge };
    }
    const cluster = el.closest(".pele-cluster[data-id]");
    if (cluster) return { target: { kind: "subgraph", id: cluster.getAttribute("data-id")! }, el: cluster };
    return null;
  }

  /** Empty diagram space (the SVG background, not a label, link or control). */
  private onBackground(ev: MouseEvent): boolean {
    const t = ev.target as Element | null;
    const svg = this.host.svg();
    if (!svg || !t || t.closest(SKIP) || t.closest(".mehrpele-overlay-item")) return false;
    const nested = t.closest(".pele-embed");
    if (nested && nested !== this.host.root) return false;
    // The frame is as wide as the note; the diagram may be narrower.
    if (t === this.host.root || t === this.host.wrapper || t.classList.contains("pele-mount")) return true;
    return t === svg || (t.closest("svg") === svg && !this.hitAt(ev));
  }

  /** Wide transparent stroke clones so thin edges are easy to hover. */
  private ensureHits(): void {
    const svg = this.host.svg();
    if (!svg || svg === this.hitsFor) return;
    this.hitsFor = svg;
    const NS = "http://www.w3.org/2000/svg";
    for (const g of Array.from(svg.querySelectorAll(".pele-edge[data-id]"))) {
      if (g.querySelector(`.${EDIT_HIT_CLASS}`)) continue;
      for (const p of Array.from(g.querySelectorAll("path:not(.pele-marker)"))) {
        const hit = this.doc.createElementNS(NS, "path");
        hit.setAttribute("d", p.getAttribute("d") ?? "");
        hit.setAttribute("class", EDIT_HIT_CLASS);
        g.appendChild(hit);
      }
    }
  }

  private onMutate(): void {
    this.lastMutation = performance.now();
    const svg = this.host.svg();
    if (svg !== this.hitsFor) {
      this.hitsFor = null;
      if (this.selection.length || this.hover) this.reresolve();
    }
    // Re-layouts (reflow, FLIP) move the shapes: outlines and buttons follow.
    if (this.selection.length || this.hover) {
      this.outlines.followFor();
      this.position();
    }
  }

  /** After a re-render: find the same elements again (dropping any that went). */
  private reresolve(): void {
    const svg = this.host.svg();
    if (!svg) return this.clear();
    const again = (h: Hit): Hit | null => {
      const el = targetElement(svg, h.target);
      return el ? { ...h, el } : null;
    };
    this.selection = this.selection.map(again).filter((h): h is Hit => !!h);
    this.hover = this.hover ? again(this.hover) : null;
    if (this.selection.length || this.hover) this.render();
    else this.clear();
  }

  // -- events ----------------------------------------------------------------------

  private onMove = (ev: PointerEvent): void => {
    if (ev.pointerType === "touch" || this.editor || this.marquee || this.connecting || !this.host.settings().toolbar) return;
    const marked = (ev as unknown as Record<symbol, unknown>)[HANDLED];
    if (marked || !this.active()) {
      if (!this.selection.length) this.scheduleHide();
      else this.setHover(null);
      return;
    }
    this.ensureHits();
    const hit = this.hitAt(ev);
    if (!hit) {
      if (this.selection.length) this.setHover(null);
      else this.scheduleHide();
      return;
    }
    (ev as unknown as Record<symbol, unknown>)[HANDLED] = true;
    this.cancelHide();
    if (this.hover?.el === hit.el && (this.menuEl?.isConnected || this.selection.length)) return;
    this.setHover(hit);
  };

  /** Hover: with a selection only the dashed outline follows; otherwise the menu too. */
  private setHover(hit: Hit | null): void {
    this.hover = hit;
    if (this.selection.length) {
      const sel = hit && this.selection.some((s) => s.el === hit.el);
      this.outlines.setAll("hover", hit && !sel ? [["hover", hit.el]] : []);
      return;
    }
    if (hit) this.render();
  }

  private onLeave = (): void => {
    if (this.selection.length) this.setHover(null);
    else this.scheduleHide();
  };

  /** A primary press on empty diagram space may start a marquee. */
  private onPointerDown = (ev: PointerEvent): void => {
    if (!ev.isTrusted || !ev.isPrimary || ev.button !== 0 || ev.pointerType === "touch" || this.editor) return;
    if (!this.host.settings().toolbar || !this.active() || !this.onBackground(ev)) return;
    this.marquee = { x: ev.clientX, y: ev.clientY, id: ev.pointerId, el: null, add: ev.shiftKey || ev.metaKey || ev.ctrlKey };
    this.doc.addEventListener("pointermove", this.onMarqueeMove, true);
    this.doc.addEventListener("pointerup", this.onMarqueeUp, true);
    this.doc.addEventListener("pointercancel", this.onMarqueeCancel, true);
  };

  private onMarqueeMove = (ev: PointerEvent): void => {
    const m = this.marquee;
    if (!m || ev.pointerId !== m.id) return;
    if (!(ev.buttons & 1)) return this.endMarquee(null);
    const dx = ev.clientX - m.x;
    const dy = ev.clientY - m.y;
    if (!m.el && Math.hypot(dx, dy) < 4) return;
    ev.preventDefault();
    // A marquee, not a text selection of the labels it crosses.
    this.doc.getSelection()?.removeAllRanges();
    if (!m.el) {
      m.el = this.doc.body.createDiv({ cls: "pele-edit-marquee" });
      this.hideMenu();
    }
    Object.assign(m.el.style, {
      left: `${Math.min(m.x, ev.clientX)}px`,
      top: `${Math.min(m.y, ev.clientY)}px`,
      width: `${Math.abs(dx)}px`,
      height: `${Math.abs(dy)}px`,
    });
  };

  private onMarqueeUp = (ev: PointerEvent): void => {
    if (this.marquee && ev.pointerId === this.marquee.id) this.endMarquee(ev);
  };

  private onMarqueeCancel = (): void => this.endMarquee(null);

  private endMarquee(ev: PointerEvent | null): void {
    const m = this.marquee;
    if (!m) return;
    this.marquee = null;
    this.doc.removeEventListener("pointermove", this.onMarqueeMove, true);
    this.doc.removeEventListener("pointerup", this.onMarqueeUp, true);
    this.doc.removeEventListener("pointercancel", this.onMarqueeCancel, true);
    if (!m.el) return;
    m.el.remove();
    if (!ev || !ev.isTrusted) return;
    // The click that ends a marquee must not clear what it selected; it may
    // land outside the diagram, so the flag never outlives this gesture.
    this.suppressClick = true;
    window.setTimeout(() => (this.suppressClick = false), 0);
    const box = { left: Math.min(m.x, ev.clientX), top: Math.min(m.y, ev.clientY), right: Math.max(m.x, ev.clientX), bottom: Math.max(m.y, ev.clientY) };
    const svg = this.host.svg();
    if (!svg) return;
    const hits: Hit[] = [];
    for (const n of Array.from(svg.querySelectorAll(".pele-node[data-id]"))) {
      if (n.closest("svg") !== svg) continue;
      const b = shapeClientBox(n);
      if (b && b.left < box.right && b.left + b.width > box.left && b.top < box.bottom && b.top + b.height > box.top) {
        hits.push({ target: { kind: "node", id: n.getAttribute("data-id")! }, el: n });
      }
    }
    const merged = m.add ? [...this.selection, ...hits.filter((h) => !this.selection.some((s) => keyOf(s.target) === keyOf(h.target)))] : hits;
    this.selection = merged;
    this.render();
  }

  private onClick = (ev: MouseEvent): void => {
    if (this.suppressClick) {
      this.suppressClick = false;
      ev.stopPropagation();
      ev.preventDefault();
      return;
    }
    if ((ev as unknown as Record<symbol, unknown>)[HANDLED] || !this.host.settings().toolbar || !this.active()) return;
    this.ensureHits();
    const hit = this.hitAt(ev);
    if (!hit) {
      // Empty diagram space clears the selection (links and controls keep their clicks).
      if (this.selection.length && this.onBackground(ev)) this.clear();
      return;
    }
    (ev as unknown as Record<symbol, unknown>)[HANDLED] = true;
    // Selecting must not reach the editor (cursor into the block) or open the mobile lightbox.
    ev.stopPropagation();
    ev.preventDefault();
    const toggle = ev.shiftKey || ev.metaKey || ev.ctrlKey;
    const k = keyOf(hit.target);
    if (toggle) {
      const had = this.selection.some((s) => keyOf(s.target) === k);
      this.selection = had ? this.selection.filter((s) => keyOf(s.target) !== k) : [...this.selection, hit];
    } else this.selection = [hit];
    this.hover = null;
    if (this.selection.length) this.render();
    else this.clear();
  };

  /** view-nodes: a full-bleed view has no border to click; its title bar selects the node. */
  private onNodeSelect = (ev: Event): void => {
    const d = (ev as CustomEvent<{ id?: string; add?: boolean }>).detail;
    if (!d?.id || !this.active()) return;
    const t: EditTarget = { kind: "node", id: d.id };
    const keep = d.add ? this.selection.map((s) => s.target).filter((x) => keyOf(x) !== keyOf(t)) : [];
    this.select([...keep, t]);
  };

  private onDblClick = (ev: MouseEvent): void => {
    if ((ev as unknown as Record<symbol, unknown>)[HANDLED] || !this.host.settings().inlineEdit || !this.active()) return;
    // A note card's double-click edits the note itself (mehrpele/note-card.ts).
    if ((ev.target as Element | null)?.closest?.(".mehrpele-note-card")) return;
    const hit = this.hitAt(ev);
    if (!hit) return;
    const caps = analyse(this.ctx(), hit.target);
    if (!caps?.editText) return;
    (ev as unknown as Record<symbol, unknown>)[HANDLED] = true;
    ev.stopPropagation();
    ev.preventDefault();
    this.editText(caps);
  };

  private onDocPointerDown = (ev: PointerEvent): void => {
    const t = ev.target as Element | null;
    if (!t) return;
    if (this.menuEl?.contains(t) || this.clusterEl?.contains(t) || this.submenu?.contains(t) || this.plusEls.some((p) => p.contains(t)) || t.closest(".menu, .modal-container, .pele-floating-actions")) return;
    if (this.host.wrapper.contains(t)) return; // onClick / marquee decide
    this.clear();
  };

  private onKey = (ev: KeyboardEvent): void => {
    // During a "+" drag Esc is the drag's (it cancels; the selection stays).
    if (ev.key !== "Escape" || this.editor || this.connecting) return;
    // embed-insert: Esc in a picker (modal) closes the picker, not the selection.
    // A note card being edited (mehrpele/note-card.ts) takes its own Esc.
    if ((ev.target as Element | null)?.closest?.(".modal-container, .mehrpele-note-card.is-editing-note")) return;
    // A menu shown only because the pointer rests on a diagram must not eat Esc
    // meant for the note (vim, suggests): only a selection or a focused menu does.
    if (!this.selection.length && !this.menuEl?.contains(this.doc.activeElement) && !this.clusterEl?.contains(this.doc.activeElement) && !this.submenu) return;
    ev.preventDefault();
    ev.stopPropagation();
    // Esc closes an open popover first; the selection stays.
    if (this.submenu) return this.closeSubmenu();
    this.clear();
    this.host.root.focus({ preventScroll: true });
  };

  private onScroll = (): void => {
    if (this.selection.length) this.position();
    else this.clear();
  };

  /** The node resize handle when it is shown at `r`'s bottom-right corner (the cluster keeps clear of it). */
  private cornerHandle(r: Box): Box | null {
    for (const h of Array.from(this.host.wrapper.querySelectorAll<HTMLElement>(".pele-node-handle"))) {
      const b = h.getBoundingClientRect();
      if (!b.width || !b.height) continue;
      if (Math.abs(b.left + b.width / 2 - (r.left + r.width)) < 24 && Math.abs(b.top + b.height / 2 - (r.top + r.height)) < 24) {
        return { left: b.left, top: b.top, width: b.width, height: b.height };
      }
    }
    return null;
  }

  private scheduleHide(): void {
    if (this.hideTimer || !this.menuEl || this.selection.length) return;
    this.hideTimer = window.setTimeout(() => {
      this.hideTimer = 0;
      if (!this.overMenu && !this.selection.length && !this.submenu) this.clear();
    }, 300);
  }

  private cancelHide(): void {
    if (this.hideTimer) window.clearTimeout(this.hideTimer);
    this.hideTimer = 0;
  }

  private listen(on: boolean): void {
    if (on === this.listening && (!on || this.listenDoc === this.doc)) return;
    if (this.listening) this.bindDoc(this.listenDoc!, "removeEventListener");
    this.listening = on;
    this.listenDoc = on ? this.doc : null;
    if (on) this.bindDoc(this.doc, "addEventListener");
  }

  private bindDoc(doc: Document, m: "addEventListener" | "removeEventListener"): void {
    doc[m]("pointerdown", this.onDocPointerDown as EventListener, true);
    doc[m]("keydown", this.onKey as EventListener, true);
    doc.defaultView?.[m]("scroll", this.onScroll, true);
  }

  // -- menu ------------------------------------------------------------------------

  /** Targets the menu acts on: the selection, else the hovered element. */
  private targets(): Hit[] {
    return this.selection.length ? this.selection : this.hover ? [this.hover] : [];
  }

  private render(): void {
    const hits = this.targets();
    if (!hits.length) return this.clear();
    this.place(); // remembered for a follow-up started after this frame is replaced
    const ctx = this.ctx();
    const caps = hits.map((h) => analyse(ctx, h.target)).filter((c): c is Capabilities => !!c);
    if (caps.length !== hits.length) {
      // Something selected can't be edited here: keep only what can.
      if (!caps.length) return this.clear();
      const ok = new Set(caps.map((c) => keyOf(c.target)));
      this.selection = this.selection.filter((s) => ok.has(keyOf(s.target)));
    }
    const c = combine(caps);
    this.closeSubmenu();
    if (!this.menuEl) {
      this.menuEl = this.doc.body.createDiv({ cls: "pele-edit-menu" });
      this.menuEl.addEventListener("pointerenter", () => {
        this.overMenu = true;
        this.cancelHide();
      });
      this.menuEl.addEventListener("pointerleave", () => {
        this.overMenu = false;
        if (!this.selection.length) this.scheduleHide();
      });
    }
    this.listen(true);
    this.menuEl.empty();
    const menu = this.menuEl.createDiv({ cls: "canvas-menu" });
    menu.setAttribute("role", "toolbar");
    menu.setAttribute("aria-label", `Edit ${c.label}`);
    const btn = (icon: string, label: string, run: (b: HTMLElement, e: MouseEvent) => void): HTMLElement => {
      const b = menu.createEl("button", { cls: "clickable-icon" });
      setIcon(b, icon);
      b.setAttribute("aria-label", label);
      b.dataset.peleTip = label;
      b.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        run(b, e);
      });
      return b;
    };
    const s = this.host.settings();
    if (s.toolbar) {
      if (c.color) btn("palette", "Set colour", (b) => this.colorMenu(b, c));
      if (c.textSize) btn("type", "Text size", (b) => this.sizeMenu(b, c));
      if (c.shapes) btn("shapes", "Shape", (b) => this.shapeMenu(b, c));
      if (c.lineStyle || c.heads) btn("spline", "Line and arrowheads", (b) => this.edgeMenu(b, c));
      if (c.group) btn("plus", "Group into a subgraph", (_b, e) => void this.group(c, e));
      if (c.sharedChild) btn("arrow-right", "Add a child of all selected (Cmd/Ctrl-click: suggest)", (_b, e) => void this.sharedChild(c, e)).dataset.peleMod = "shared-child";
    }
    // embed-insert: one button per group (views, content, media & links), each its own small flyout.
    if (c.insertEmbed && s.toolbar) for (const g of GROUPS) btn(g.icon, g.button, (b, e) => this.insertEmbed(c, b, e, g.id)).dataset.peleInsert = g.id;
    this.renderCluster(c);
    if (c.note) menu.setAttribute("title", c.note);
    if (!menu.childElementCount && !this.clusterEl) return this.clear();
    // Only the cluster has something to offer: keep the menu (it tracks hover) but out of sight.
    this.menuEl.toggleClass("is-empty", !menu.childElementCount);
    this.menuEl.toggleClass("is-selected", this.selection.length > 0);
    this.renderPlus(c);
    this.position();
    syncModIcons(this.doc.body, this.doc);
    // Tooltips open away from the selection (above a toolbar above it, below one below it).
    const placement = this.toolbarBox?.side === "below" ? "bottom" : "top";
    for (const b of Array.from(menu.querySelectorAll<HTMLElement>("button[data-pele-tip]"))) setTooltip(b, b.dataset.peleTip!, { placement });
  }

  /** Edit, zoom and delete: small icons beside the target's corner, coloured on hover. */
  private renderCluster(c: Combined): void {
    this.clusterEl?.remove();
    this.clusterEl = null;
    const s = this.host.settings();
    const one = c.targets.length === 1 ? c.targets[0] : null;
    const edit = c.editText && s.inlineEdit && one;
    const zoom = one && s.toolbar ? this.host.zoom?.(one.kind === "node" ? one.id : null) ?? null : null;
    const del = c.delete && s.toolbar;
    if (!edit && !zoom && !del) return;
    const el = this.doc.body.createDiv({ cls: "pele-edit-cluster" });
    el.setAttribute("role", "toolbar");
    el.setAttribute("aria-label", `${c.label} actions`);
    el.addEventListener("pointerenter", () => {
      this.overMenu = true;
      this.cancelHide();
    });
    el.addEventListener("pointerleave", () => {
      this.overMenu = false;
      if (!this.selection.length) this.scheduleHide();
    });
    const btn = (icon: string, cls: string, label: string, run: (e: MouseEvent) => void): void => {
      const b = el.createEl("button", { cls: `clickable-icon ${cls}` });
      setIcon(b, icon);
      b.setAttribute("aria-label", label);
      setTooltip(b, label, { placement: "bottom" });
      b.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        run(e);
      });
    };
    if (edit) btn("pencil", "is-edit", one.kind === "edge" ? "Edit label" : one.kind === "subgraph" ? "Edit title" : "Edit text", () => this.editText({ target: one }));
    if (zoom) btn("zoom-in", "is-zoom", "Zoom in", (e) => e.isTrusted && zoom());
    if (del) btn("trash-2", "is-delete", c.deleteName, (e) => void this.run(c, { op: "delete" }, "deletion", e));
    this.clusterEl = el;
  }

  /** Four "+" buttons on a single selected node's sides. */
  private renderPlus(c: Combined): void {
    for (const p of this.plusEls) p.remove();
    this.plusEls = [];
    if (!c.plus || this.selection.length !== 1 || !this.host.settings().toolbar) return;
    const id = c.targets[0].id;
    const dir = effectiveDirection(this.host.source(), this.host.direction?.() ?? null);
    const mod = Platform.isMacOS ? "Cmd" : "Ctrl";
    for (const side of ["top", "right", "bottom", "left"] as Side[]) {
      const rel = relationFor(dir, side);
      const name = rel === "child" ? "child" : rel === "parent" ? "parent" : "sibling";
      const b = this.doc.body.createEl("button", { cls: `clickable-icon pele-edit-plus is-${side}` });
      setIcon(b, "plus");
      const label = `Add ${name} (${mod}-click: suggest labels)`;
      b.setAttribute("aria-label", label);
      setTooltip(b, label, { placement: side === "bottom" ? "bottom" : side === "left" ? "left" : side === "right" ? "right" : "top" });
      b.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (performance.now() - this.connectEndedAt < 400) return; // the end of a drag, not a click
        void this.addRelative(id, rel, side, e);
      });
      b.addEventListener("pointerdown", (e) => this.startConnect(e, b, id, side));
      this.plusEls.push(b);
    }
    this.dimPlus();
  }

  /** While a submenu or menu is open the "+" buttons step out of the way. */
  private dimPlus(): void {
    const open = !!this.submenu;
    for (const p of this.plusEls) p.toggleClass("is-dimmed", open);
  }

  /** The area overlays may use: the diagram's scroll container ∩ the viewport. */
  private bounds(): Box {
    const sc = this.host.wrapper.closest<HTMLElement>(".markdown-preview-view, .cm-scroller, .canvas-node-content, .lightbox");
    const r = sc?.getBoundingClientRect();
    const de = this.doc.documentElement;
    return visibleBounds(r ? { left: r.left, top: r.top, width: r.width, height: r.height } : null, { width: de.clientWidth, height: de.clientHeight });
  }

  /** What overlays must not cover: the selection and the "+" buttons' band around it. */
  private avoidBoxes(): Box[] {
    const r = this.targetBox();
    if (!r) return [];
    const band = this.plusEls.length ? 28 : 2;
    return [{ left: r.left - band, top: r.top - band, width: r.width + 2 * band, height: r.height + 2 * band }];
  }

  /**
   * What an overlay must keep clear for one target: a node's or subgraph's
   * shape; for an edge (whose box can span the whole diagram) its label, or
   * the middle of its line.
   */
  private anchorBox(h: Hit): ClientBox | null {
    if (h.target.kind !== "edge") return shapeClientBox(h.el);
    const svg = this.host.svg();
    const label = svg?.querySelector(`.pele-edge-label[data-id="${cssEscape(h.target.id)}"]`);
    if (label) {
      const r = label.getBoundingClientRect();
      if (r.width > 0) return { left: r.left, top: r.top, width: r.width, height: r.height };
    }
    const path = h.el.querySelector<SVGPathElement>("path:not(.pele-marker):not(.pele-edit-hit)");
    const m = path?.getScreenCTM();
    if (!path || !m) return shapeClientBox(h.el);
    const p = path.getPointAtLength(path.getTotalLength() / 2);
    const x = m.a * p.x + m.c * p.y + m.e;
    const y = m.b * p.x + m.d * p.y + m.f;
    return { left: x - 6, top: y - 6, width: 12, height: 12 };
  }

  /** Union of the anchors of everything the menu acts on. */
  private targetBox(): ClientBox | null {
    const boxes = this.targets()
      .filter((h) => h.el.isConnected)
      .map((h) => this.anchorBox(h))
      .filter((b): b is ClientBox => !!b && (b.width > 0 || b.height > 0));
    if (!boxes.length) return null;
    const left = Math.min(...boxes.map((b) => b.left));
    const top = Math.min(...boxes.map((b) => b.top));
    return {
      left,
      top,
      width: Math.max(...boxes.map((b) => b.left + b.width)) - left,
      height: Math.max(...boxes.map((b) => b.top + b.height)) - top,
    };
  }

  private position(): void {
    if (!this.menuEl) return;
    // The shapes, not the group: Mehrpele's hidden fallback text can be wider and offset.
    const r = this.targetBox();
    // A hidden frame (a background tab) has no layout: never draw at the window corner.
    if (!r || !isShown(this.host.wrapper)) return this.clear();
    const bounds = this.bounds();
    // Beyond the "+" buttons (22 px, centred 14 px out): the top "+" never touches the toolbar.
    const band = this.plusEls.length ? 32 : 8;
    const t = placeToolbar(r, { width: this.menuEl.offsetWidth || 200, height: this.menuEl.offsetHeight || 36 }, bounds, band);
    this.toolbarBox = t;
    Object.assign(this.menuEl.style, { left: `${t.left}px`, top: `${t.top}px` });
    this.menuEl.dataset.side = t.side;
    if (this.submenu) this.placeSub(this.submenu);
    if (this.clusterEl) {
      const k = placeCluster(r, { width: this.clusterEl.offsetWidth || 70, height: this.clusterEl.offsetHeight || 22 }, bounds, this.cornerHandle(r));
      Object.assign(this.clusterEl.style, { left: `${k.left}px`, top: `${k.top}px` });
    }
    for (const p of this.plusEls) {
      const side = (["top", "right", "bottom", "left"] as Side[]).find((s) => p.hasClass(`is-${s}`))!;
      const x = side === "left" ? r.left - 14 : side === "right" ? r.left + r.width + 14 : r.left + r.width / 2;
      const y = side === "top" ? r.top - 14 : side === "bottom" ? r.top + r.height + 14 : r.top + r.height / 2;
      Object.assign(p.style, { left: `${x}px`, top: `${y}px` });
    }
    this.outlines.setAll(
      "selected",
      this.selection.map((h) => [keyOf(h.target), h.el] as [string, Element]),
    );
    this.outlines.setAll("hover", !this.selection.length && this.hover ? [["hover", this.hover.el]] : []);
  }

  /** Hide the menu and buttons, keep the selection (marquee in progress). */
  private hideMenu(): void {
    this.closeSubmenu();
    this.menuEl?.remove();
    this.menuEl = null;
    this.clusterEl?.remove();
    this.clusterEl = null;
    for (const p of this.plusEls) p.remove();
    this.plusEls = [];
  }

  /** Clear selection, hover, menu and outlines. */
  clear(): void {
    this.cancelHide();
    this.hideMenu();
    this.outlines.clear();
    this.overMenu = false;
    this.selection = [];
    this.hover = null;
    this.listen(false);
  }

  /** Back-compat for callers that hid the menu. */
  hide(_force = false): void {
    this.clear();
  }

  private closeSubmenu(): void {
    const hadFocus = !!this.submenu?.contains(this.doc.activeElement);
    const after = this.onSubmenuClose; // embed-insert: the popover closes itself first (focus back to its button)
    this.onSubmenuClose = null;
    after?.();
    this.submenu?.remove();
    this.submenu = null;
    if (hadFocus && this.subAnchor?.isConnected) this.subAnchor.focus({ preventScroll: true });
    this.subAnchor = null;
    this.dimPlus();
  }

  /** Put a popover on the side away from the selection. */
  private placeSub(el: HTMLElement): "above" | "below" | "left" | "right" {
    const t = this.toolbarBox;
    if (!t) return "above";
    el.style.removeProperty("max-height");
    const p = placeSubmenu(t, { width: el.offsetWidth, height: el.offsetHeight }, this.bounds(), this.avoidBoxes());
    Object.assign(el.style, { left: `${p.left}px`, top: `${p.top}px`, maxHeight: p.maxHeight ? `${p.maxHeight}px` : "", overflowY: p.maxHeight ? "auto" : "" });
    return p.side;
  }

  /**
   * A popover on the body in Canvas's submenu style (its own layer above
   * tooltips), placed away from the selection; the same button closes it.
   * Null when that button's popover was open (now closed).
   */
  private openSub(kind: string, name: string, cls = ""): HTMLElement | null {
    const again = this.submenu?.dataset.kind === kind;
    this.closeSubmenu();
    if (again) return null;
    const sub = this.doc.body.createDiv({ cls: `canvas-submenu pele-edit-submenu ${cls}`.trim() });
    sub.dataset.kind = kind;
    sub.setAttribute("role", "menu");
    sub.setAttribute("aria-label", name);
    sub.addEventListener("pointerenter", () => {
      this.overMenu = true;
      this.cancelHide();
    });
    this.submenu = sub;
    this.subAnchor = this.doc.activeElement instanceof HTMLElement && this.menuEl?.contains(this.doc.activeElement) ? this.doc.activeElement : null;
    this.dimPlus();
    return sub;
  }

  /** Place an open popover, point its tooltips outward and make its items arrow-key navigable. */
  private finishSub(sub: HTMLElement, rows: HTMLElement[][]): void {
    const side = this.placeSub(sub);
    // Tooltips clear the whole popover (every row) and the selection: past the
    // popover's outer edge (the gap reaches it), up or down away from the
    // selection; when that edge is too near the top or bottom of the view
    // (Obsidian would push the tooltip back over the popover), beside it.
    const box = sub.getBoundingClientRect();
    const b = this.bounds();
    const vertical = side === "below" ? "bottom" : "top";
    const roomV = vertical === "top" ? box.top - b.top : b.top + b.height - box.bottom;
    const roomR = b.left + b.width - box.right;
    const sideways = side === "left" || (side !== "right" && box.left - b.left > roomR) ? "left" : "right";
    // Obsidian keeps a tooltip a tooltip's height inside the view: two of them (~80 px).
    const placement = roomV >= 80 ? vertical : sideways;
    for (const it of rows.flat()) {
      const r = it.getBoundingClientRect();
      const reach = { top: r.top - box.top, bottom: box.bottom - r.bottom, left: r.left - box.left, right: box.right - r.right }[placement];
      setTooltip(it, it.getAttribute("aria-label")!, { placement, gap: reach + 8 });
    }
    const lengths = rows.map((r) => r.length);
    const start = rows.flat().find((it) => it.hasClass("is-active")) ?? rows[0]?.[0];
    for (const it of rows.flat()) it.tabIndex = it === start ? 0 : -1;
    sub.addEventListener("keydown", (e) => {
      const i = rows.findIndex((r) => r.includes(e.target as HTMLElement));
      if (i < 0) return;
      const next = gridMove(lengths, { row: i, col: rows[i].indexOf(e.target as HTMLElement) }, e.key);
      if (!next) return;
      e.preventDefault();
      const it = rows[next.row][next.col];
      for (const x of rows.flat()) x.tabIndex = x === it ? 0 : -1;
      it.focus();
    });
    start?.focus({ preventScroll: true });
  }

  /** One popover item: an icon button with a name (tooltip, aria-label); Enter / Space pick it. */
  private subItem(row: HTMLElement, cls: string, label: string, active: boolean, pick: (e: Event) => void, disabled = false): HTMLElement {
    const it = row.createDiv({ cls: `clickable-icon pele-pop-item ${cls}`.trim() });
    it.setAttribute("role", "menuitemradio");
    it.setAttribute("aria-label", label);
    it.setAttribute("aria-checked", String(active));
    if (active) it.addClass("is-active");
    if (disabled) {
      it.setAttribute("aria-disabled", "true");
      it.addClass("is-disabled");
      return it;
    }
    it.addEventListener("click", pick);
    it.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      pick(e);
    });
    return it;
  }

  /** Canvas's colour picker: six theme swatches, custom, reset. */
  private colorMenu(_anchor: HTMLElement, c: Combined): void {
    const sub = this.openSub("color", "Colour");
    if (!sub) return;
    const cur = c.currentColor;
    const items: HTMLElement[] = [];
    const reset = this.subItem(sub, "canvas-color-picker-item pele-edit-reset", "Reset colour", !cur, (e) => void this.run(c, { op: "color", value: null }, "colour", e));
    reset.removeClass("clickable-icon");
    setIcon(reset, "rotate-ccw");
    items.push(reset);
    for (const p of PRESETS) {
      const active = !!cur && "preset" in cur && cur.preset === p.n;
      const it = this.subItem(sub, `canvas-color-picker-item mod-canvas-color-${p.n}`, p.name, active, (e) => void this.run(c, { op: "color", value: { preset: p.n } }, "colour", e));
      it.removeClass("clickable-icon");
      items.push(it);
    }
    const custom = sub.createDiv({ cls: "canvas-color-picker-item canvas-color-picker-custom" });
    custom.setAttribute("aria-label", "Custom colour");
    const input = custom.createEl("input", { type: "color" });
    if (cur && "custom" in cur) {
      custom.addClass("is-active");
      custom.style.setProperty("--canvas-color", cur.custom);
      input.value = cur.custom;
    }
    // `change` fires once when the picker closes: one write, not one per drag step.
    input.addEventListener("change", (e) => {
      const hex = normalizeHex(input.value);
      if (hex) void this.run(c, { op: "color", value: { custom: hex } }, "colour", e);
    });
    items.push(custom);
    this.finishSub(sub, [items]);
  }

  /** Text size: "A" at each size, Medium being the default; reset removes a size. */
  private sizeMenu(_anchor: HTMLElement, c: Combined): void {
    const sub = this.openSub("size", "Text size", "pele-edit-iconpop");
    if (!sub) return;
    const row = sub.createDiv({ cls: "pele-pop-row" });
    const reset = this.subItem(row, "", "Reset text size", false, (e) => void this.run(c, { op: "size", value: null }, "text size", e), c.currentSize === null);
    setIcon(reset, "rotate-ccw");
    const items = [reset];
    for (const [size, name] of SIZE_NAMES) {
      const it = this.subItem(row, `pele-pop-size pele-pop-size-${size ?? "m"}`, name, c.currentSize === size, (e) => void this.run(c, { op: "size", value: size }, "text size", e));
      it.createSpan({ text: "A" });
      items.push(it);
    }
    this.finishSub(sub, [items]);
  }

  /** Shapes as Pele draws them on one aligned grid, grouped: boxes, round, angular, special. */
  private shapeMenu(_anchor: HTMLElement, c: Combined): void {
    const sub = this.openSub("shape", "Shape", "pele-edit-iconpop pele-shape-grid");
    if (!sub) return;
    const mind = this.host.diagramType() === "mindmap";
    // The diagram's corner radius, so rectangles round as they will.
    const radius = this.host.svg() ? getComputedStyle(this.host.svg()!).getPropertyValue("--_r") : "";
    if (radius) sub.style.setProperty("--_r", radius);
    const grid = shapeGrid(groupShapes(c.shapes ?? []));
    sub.style.setProperty("--pele-cols", String(grid.cols));
    const rows: HTMLElement[][] = [];
    for (const [i, group] of grid.rows.entries()) {
      const row = sub.createDiv({ cls: grid.groupStart[i] && i > 0 ? "pele-pop-row is-group-start" : "pele-pop-row" });
      rows.push(
        group.map((s) => {
          const it = this.subItem(row, "", s.name, c.currentShape === s.key, (e) => void this.run(c, { op: "shape", key: s.key }, "shape", e));
          const markup = shapeGlyph(s.key, mind);
          if (markup) it.appendChild(glyphSvg(this.doc, markup, "pele-shape-glyph"));
          else setIcon(it, s.icon);
          return it;
        }),
      );
    }
    // Fit each outline to its icon now that it can be measured.
    for (const svg of Array.from(sub.querySelectorAll<SVGSVGElement>("svg.pele-shape-glyph"))) fitGlyph(svg);
    this.finishSub(sub, rows);
  }

  /** Edge style: the line (solid, dotted, thick) and its ends (none, arrow, both, circle, cross). */
  private edgeMenu(_anchor: HTMLElement, c: Combined): void {
    const sub = this.openSub("edge", "Line and arrowheads", "pele-edit-iconpop");
    if (!sub) return;
    const rows: HTMLElement[][] = [];
    const glyphRow = <K extends string>(opts: Array<[K, string]>, glyphs: Record<K, string>, active: K | null, pick: (v: K, e: Event) => void) => {
      const row = sub.createDiv({ cls: "pele-pop-row" });
      rows.push(
        opts.map(([v, name]) => {
          const it = this.subItem(row, "", name, active === v, (e) => pick(v, e));
          it.appendChild(glyphSvg(this.doc, glyphs[v], "pele-edge-glyph", "0 0 24 16"));
          return it;
        }),
      );
    };
    type Line = keyof typeof STROKE_GLYPHS;
    if (c.lineStyle)
      glyphRow<Line>(
        [["normal", "Solid"], ["dotted", "Dotted"], ["thick", "Thick"]],
        STROKE_GLYPHS,
        (c.currentStroke ?? null) as Line | null,
        (v, e) => void this.run(c, { op: "stroke", value: v }, "line style", e),
      );
    if (c.heads)
      glyphRow<Heads>(
        [["none", "No arrowheads"], ["one", "Arrow at end"], ["both", "Arrows at both ends"], ["circle", "Circle end"], ["cross", "Cross end"]],
        HEAD_GLYPHS,
        c.currentHeads ?? null,
        (v, e) => void this.run(c, { op: "heads", value: v }, "arrowheads", e),
      );
    if (c.note) sub.createDiv({ cls: "pele-pop-note", text: c.note });
    this.finishSub(sub, rows);
  }

  // -- actions ---------------------------------------------------------------------

  /** One genuine user action → one edit (never from hover or menu display). */
  private async run(c: Combined, op: EditOp, what: string, ev: Event | null | undefined): Promise<void> {
    // Only a real user action writes: synthetic events (other plugins, embedded views) never do.
    if (this.busy || !ev?.isTrusted) return;
    if (isCurrent(c, op)) return this.closeSubmenu();
    const res = applyEditMany(this.ctx(), c.targets, op);
    if (!res.ok) {
      if (res.error !== "unchanged") new Notice(res.error);
      this.closeSubmenu();
      return;
    }
    const keep = op.op === "delete" ? [] : this.selection.map((s) => s.target);
    await this.write(res.source, res.switched ? `${what} (block switched to Mehrpele)` : what, `${what} ${c.targets.map(keyOf).join(",")} ${ev.type} trusted=${ev.isTrusted}`, keep.length ? { sourcePath: this.host.sourcePath, targets: keep } : null);
  }

  /** Persist, then hand the follow-up (selection / editor) to whichever layer shows the result. */
  private async write(source: string, what: string, log: string, follow: FollowUp | null): Promise<boolean> {
    this.busy = true;
    this.closeSubmenu();
    try {
      console.debug("[pele-mermaid] edit:", log);
      // Before the write: Reading view replaces this frame while it saves.
      const origin = this.place();
      const ok = await this.host.persist(source, what);
      if (!ok) return false;
      this.clear();
      if (follow) scheduleFollowUp(follow, origin);
      return true;
    } finally {
      this.busy = false;
    }
  }

  /** embed-insert: one group's embeds for one node; a pick replaces or extends its label (one edit). Again: close. */
  private insertEmbed(c: Combined, anchor: HTMLElement, ev: MouseEvent, group: GroupId): void {
    if (!ev.isTrusted || !this.menuEl) return;
    const kind = `insert-${group}`;
    const again = this.submenu?.dataset.kind === kind;
    this.closeSubmenu();
    if (again) return;
    const target = c.targets[0];
    // A submenu like the others: on the body, placed away from the selection, "+" dimmed.
    const pop = openEmbedInsert({
      app: this.host.app,
      doc: this.doc,
      anchor,
      parent: this.doc.body,
      avoid: () => this.targetBox(),
      place: (el) => void this.placeSub(el),
      sourcePath: this.host.sourcePath,
      current: () => readText(this.ctx(), target) ?? "",
      nodeId: target.id,
      graphDepth: 1,
      group,
      onClose: () => {
        if (this.submenu === pop.el) {
          this.submenu = null;
          this.onSubmenuClose = null;
          this.dimPlus();
        }
      },
      onInsert: (r) => void this.insertText(target, r.text, r.edit, r.evt),
    });
    pop.el.addEventListener("pointerenter", () => {
      this.overMenu = true;
      this.cancelHide();
    });
    pop.el.dataset.kind = kind;
    this.submenu = pop.el;
    this.onSubmenuClose = () => pop.close();
    this.dimPlus();
  }

  private async insertText(target: EditTarget, text: string, edit: boolean, ev: Event): Promise<void> {
    if (this.busy || !ev.isTrusted) return;
    const res = applyEditMany(this.ctx(), [target], { op: "text", text });
    if (!res.ok) return void new Notice(res.error === "unchanged" ? "Pele: nothing to insert." : res.error);
    await this.write(res.source, res.switched ? "embed (block switched to Mehrpele)" : "embed", `insert embed ${keyOf(target)} ${ev.type} trusted=${ev.isTrusted}`, {
      sourcePath: this.host.sourcePath,
      targets: [target],
      ...(edit ? { edit: { chain: false } } : {}),
    });
  }

  /** Model suggestions for a new node, or a notice pointing at the settings. */
  private suggestions(req: Omit<SuggestRequest, "source">): Promise<string[]> | undefined {
    const p = this.host.suggest?.({ ...req, source: this.host.source() }) ?? null;
    if (p) return p;
    // Obsidian's global `createFragment`/`createEl` (adopted into the Notice's
    // document on append, as the old owner-document nodes were).
    const frag = createFragment();
    frag.append("Pele: node autocomplete is not set up. ");
    const b = frag.createEl("button", { text: "Open settings" });
    b.addEventListener("click", () => this.host.openSettings?.());
    new Notice(frag, 8000);
    return undefined;
  }

  private async addRelative(id: string, relation: Relation, side: Side, ev: MouseEvent): Promise<void> {
    if (this.busy || !ev.isTrusted) return;
    const res = addNode(this.ctx(), id, relation, "New", side);
    if (!res.ok) return void new Notice(res.error);
    const nodeText = readText(this.ctx(), { kind: "node", id }) ?? id;
    const suggestions = ev.metaKey || ev.ctrlKey ? this.suggestions({ nodeId: id, nodeText, relation }) : undefined;
    await this.write(res.source, "new node", `add ${relation} of ${id} → ${res.id} trusted=${ev.isTrusted}`, {
      sourcePath: this.host.sourcePath,
      targets: [{ kind: "node", id: res.id }],
      edit: { chain: true, ...(suggestions ? { suggestions } : {}) },
    });
  }

  /**
   * Drag a "+" (Canvas's handle drag): past the 4 px intent threshold a live
   * edge in the diagram's edge style follows the pointer; a node or subgraph
   * title under it is outlined. Release on one adds `from --> it` (an edge
   * that already exists flashes instead) and selects the new edge; release
   * on empty diagram space adds a connected node there (pinned at the drop
   * point in canvas layout) and opens its editor. Esc, a release on the node
   * itself or outside the diagram cancels. A press without a drag stays a
   * click (add / Cmd-click suggest).
   */
  private startConnect(press: PointerEvent, btn: HTMLElement, from: string, side: Side): void {
    if (!press.isTrusted || !press.isPrimary || press.button !== 0 || this.busy) return;
    const win = this.doc.defaultView;
    const svg = this.host.svg();
    const source = svg?.querySelector<SVGGraphicsElement>(`.pele-node[data-id="${cssEscape(from)}"]`);
    if (!win || !svg || !source) return;
    let dragging = false;
    let px = press.clientX;
    let py = press.clientY;
    let raf = 0;
    let target: { id: string; el: Element } | null = null;
    let preview: SVGSVGElement | null = null;
    const scroller = this.host.wrapper.closest<HTMLElement>(".markdown-preview-view, .cm-scroller");
    // The diagram's edge style (colour, width at this zoom, arrowhead).
    const edgePath = svg.querySelector<SVGPathElement>(".pele-edge > path:not(.pele-marker)");
    const edgeStyle = edgePath ? getComputedStyle(edgePath) : null;
    const zoom = svg.getScreenCTM()?.a ?? 1;
    const stroke = edgeStyle?.stroke && edgeStyle.stroke !== "none" ? edgeStyle.stroke : "var(--text-muted)";
    const width = Math.max(1, (parseFloat(edgeStyle?.strokeWidth ?? "1.5") || 1.5) * zoom);

    const targetAt = (x: number, y: number): { id: string; el: Element } | null => {
      const el = this.doc.elementFromPoint(x, y);
      if (!el || !this.host.wrapper.contains(el)) return null;
      const node = el.closest(".pele-node[data-id]");
      if (node && node.closest("svg") === svg) return { id: node.getAttribute("data-id")!, el: node };
      const item = el.closest<HTMLElement>(".mehrpele-overlay-item[data-anchor]");
      if (item && item.closest(".pele-host") === this.host.wrapper) {
        const n = svg.querySelector(`.pele-node[data-id="${cssEscape(item.dataset.anchor ?? "")}"]`);
        if (n) return { id: item.dataset.anchor!, el: n };
      }
      // A subgraph by its title (its body is empty space for a new node).
      const cluster = el.closest(".pele-cluster[data-id]");
      if (cluster && cluster.closest("svg") === svg && (el.closest(".pele-cluster-title") || el.tagName.toLowerCase() === "text")) return { id: cluster.getAttribute("data-id")!, el: cluster };
      return null;
    };
    const anchorPoint = (): { x: number; y: number } => {
      const r = source.getBoundingClientRect();
      const x = side === "left" ? r.left : side === "right" ? r.right : r.left + r.width / 2;
      const y = side === "top" ? r.top : side === "bottom" ? r.bottom : r.top + r.height / 2;
      return { x, y };
    };
    const draw = (): void => {
      raf = 0;
      if (!preview) return;
      // Near the scroller's edges the note scrolls, and the drag follows.
      if (scroller) {
        const r = scroller.getBoundingClientRect();
        const dy = py < r.top + 32 ? -12 : py > r.bottom - 32 ? 12 : 0;
        const dx = px < r.left + 32 ? -12 : px > r.right - 32 ? 12 : 0;
        if (dx || dy) {
          scroller.scrollBy(dx, dy);
          raf = win.requestAnimationFrame(draw);
        }
      }
      target = targetAt(px, py);
      if (target?.id === from) target = null;
      this.outlines.set("connect", target?.el ?? null, "hover");
      const a = anchorPoint();
      const ang = Math.atan2(py - a.y, px - a.x);
      const head = 4 + 3 * width;
      const tip = { x: px, y: py };
      const back = (d: number, t: number) => `${tip.x - head * Math.cos(ang + t) * d},${tip.y - head * Math.sin(ang + t) * d}`;
      preview.replaceChildren();
      const line = preview.createSvg("path", { attr: { d: `M${a.x},${a.y}L${tip.x - head * 0.8 * Math.cos(ang)},${tip.y - head * 0.8 * Math.sin(ang)}` } });
      line.style.stroke = stroke;
      line.style.strokeWidth = String(width);
      const arrow = preview.createSvg("polygon", { attr: { points: `${tip.x},${tip.y} ${back(1, 0.42)} ${back(1, -0.42)}` } });
      arrow.style.fill = stroke;
    };
    const frame = (): void => {
      if (!raf) raf = win.requestAnimationFrame(draw);
    };
    const begin = (): void => {
      dragging = true;
      this.connecting = true;
      this.closeSubmenu();
      this.host.wrapper.addClass("is-pele-connecting");
      // The menu and the other "+" step aside: nodes under them stay reachable.
      this.menuEl?.addClass("is-connect-hidden");
      this.clusterEl?.addClass("is-connect-hidden");
      for (const p of this.plusEls) if (p !== btn) p.addClass("is-dimmed");
      preview = this.doc.body.createSvg("svg", { cls: "pele-connect-preview" });
      preview.setAttribute("aria-hidden", "true");
    };
    const end = (how: "drop" | "cancel", ev?: PointerEvent): void => {
      win.removeEventListener("pointermove", onMove, true);
      win.removeEventListener("pointerup", onUp, true);
      win.removeEventListener("pointercancel", onCancel, true);
      this.doc.removeEventListener("keydown", onKey, true);
      if (raf) win.cancelAnimationFrame(raf);
      if (!dragging) return; // a click: the click handler adds as before
      // What the drop is on, decided while the menu is still out of the way.
      const at = how === "drop" && ev ? this.doc.elementFromPoint(ev.clientX, ev.clientY) : null;
      const onUi = !!at && (this.menuEl?.contains(at) || this.clusterEl?.contains(at) || this.submenu?.contains(at) || this.plusEls.some((p) => p.contains(at)));
      const hit = ev && at && !onUi ? targetAt(ev.clientX, ev.clientY) : null;
      this.connectEndedAt = performance.now();
      this.connecting = false;
      preview?.remove();
      this.outlines.set("connect", null, "hover");
      this.host.wrapper.removeClass("is-pele-connecting");
      this.menuEl?.removeClass("is-connect-hidden");
      this.clusterEl?.removeClass("is-connect-hidden");
      this.dimPlus();
      // Back on a "+" (the menu is hidden while dragging): not a drop.
      if (how !== "drop" || !ev || !at || onUi) return;
      if (hit) {
        if (hit.id !== from) void this.connect(from, hit.id, side, ev);
        return;
      }
      // Empty space in or near this diagram (a canvas grows where you drop):
      // a new node there. Over another diagram, or far away: nothing.
      const wr = this.host.wrapper.getBoundingClientRect();
      const near = 240;
      if (ev.clientX < wr.left - near || ev.clientX > wr.right + near || ev.clientY < wr.top - near || ev.clientY > wr.bottom + near) return;
      const host = at.closest(".pele-host");
      if (host && host !== this.host.wrapper) return;
      void this.dropNode(from, side, ev);
    };
    const onMove = (ev: PointerEvent): void => {
      if (ev.pointerId !== press.pointerId) return;
      px = ev.clientX;
      py = ev.clientY;
      if (!dragging) {
        if (Math.hypot(px - press.clientX, py - press.clientY) < DRAG_THRESHOLD_PX) return;
        begin();
      }
      ev.preventDefault();
      frame();
    };
    const onUp = (ev: PointerEvent): void => {
      if (ev.pointerId === press.pointerId) end(ev.isTrusted ? "drop" : "cancel", ev);
    };
    const onCancel = (ev: PointerEvent): void => {
      if (ev.pointerId === press.pointerId) end("cancel");
    };
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key !== "Escape" || !dragging) return;
      ev.preventDefault();
      ev.stopPropagation();
      end("cancel");
    };
    win.addEventListener("pointermove", onMove, true);
    win.addEventListener("pointerup", onUp, true);
    win.addEventListener("pointercancel", onCancel, true);
    this.doc.addEventListener("keydown", onKey, true);
  }

  /** A "+" dropped on another node or subgraph: one edge, then that edge selected. */
  private async connect(from: string, to: string, side: Side, ev: PointerEvent): Promise<void> {
    if (this.busy || !ev.isTrusted) return;
    const res = connectNodes(this.ctx(), from, to, side);
    if (!res.ok) {
      if (res.duplicate) this.flashEdge(res.duplicate);
      else if (!res.noop) new Notice(res.error);
      return;
    }
    await this.write(res.source, "new edge", `connect ${from} → ${to} trusted=${ev.isTrusted}`, {
      sourcePath: this.host.sourcePath,
      targets: [{ kind: "edge", id: res.edgeId }],
    });
  }

  /** A "+" dropped on empty diagram space: a connected node there, its editor open. */
  private async dropNode(from: string, side: Side, ev: PointerEvent): Promise<void> {
    if (this.busy || !ev.isTrusted) return;
    const svg = this.host.svg();
    const src = this.host.source();
    let at: { x: number; y: number } | null = null;
    const m = svg?.getScreenCTM();
    const sourceEl = svg?.querySelector<SVGGraphicsElement>(`.pele-node[data-id="${cssEscape(from)}"]`);
    const drawn = sourceEl ? layoutBox(sourceEl) : null;
    if (m && drawn && isCanvasLayout(src)) {
      const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(m.inverse());
      // Centred on the drop: the new node's own size, from one render of the edit.
      const probe = addConnectedNode(this.ctx(), from, side, null);
      at = pinAtDrop(src, from, drawn, p, probe.ok ? renderedBox(probe.source, probe.id) : null);
    }
    const res = addConnectedNode(this.ctx(), from, side, at);
    if (!res.ok) return void new Notice(res.error);
    await this.write(res.source, "new node", `drop from ${from} → ${res.id} trusted=${ev.isTrusted}`, {
      sourcePath: this.host.sourcePath,
      targets: [{ kind: "node", id: res.id }],
      edit: { chain: true },
    });
  }

  /** Point at an edge that is already there. */
  private flashEdge(id: string): void {
    const el = this.host.svg()?.querySelector<SVGElement>(`.pele-edge[data-id="${cssEscape(id)}"]`);
    if (!el) return;
    el.removeClass("pele-edit-flash");
    void el.getBoundingClientRect();
    el.addClass("pele-edit-flash");
    window.setTimeout(() => el.removeClass("pele-edit-flash"), 1200);
  }

  private async sharedChild(c: Combined, ev: MouseEvent): Promise<void> {
    if (this.busy || !ev.isTrusted) return;
    const ids = c.targets.map((t) => t.id);
    // Canvas layout: a shared child is pinned on the "child" side of the group.
    const dir = effectiveDirection(this.host.source(), this.host.direction?.() ?? null);
    const childSide: Side = dir === "LR" ? "right" : dir === "RL" ? "left" : dir === "BT" ? "top" : "bottom";
    const res = addSharedChild(this.ctx(), ids, "New", childSide);
    if (!res.ok) return void new Notice(res.error);
    const others = ids.map((i) => readText(this.ctx(), { kind: "node", id: i }) ?? i);
    const suggestions = ev.metaKey || ev.ctrlKey ? this.suggestions({ nodeId: ids[0], nodeText: others[0], relation: "shared-child", others }) : undefined;
    await this.write(res.source, "new node", `shared child of ${ids.join(",")} → ${res.id} trusted=${ev.isTrusted}`, {
      sourcePath: this.host.sourcePath,
      targets: [{ kind: "node", id: res.id }],
      edit: { chain: true, ...(suggestions ? { suggestions } : {}) },
    });
  }

  private async group(c: Combined, ev: MouseEvent): Promise<void> {
    if (this.busy || !ev.isTrusted) return;
    const res = groupIntoSubgraph(this.ctx(), c.targets.map((t) => t.id));
    if (!res.ok) return void new Notice(res.error, 8000);
    await this.write(res.source, "new subgraph", `group ${c.targets.map((t) => t.id).join(",")} → ${res.id} trusted=${ev.isTrusted}`, {
      sourcePath: this.host.sourcePath,
      targets: [{ kind: "subgraph", id: res.id }],
      edit: { chain: false },
    });
  }

  /**
   * Open the rendered inline editor on `target`'s label, seamlessly over it.
   * `after` runs once the edit is saved (true) or left unchanged (false).
   */
  editText(
    caps: Pick<Capabilities, "target">,
    opts: { suggestions?: Promise<string[]>; after?: (saved: boolean) => void; initialText?: string; chain?: boolean } = {},
  ): void {
    if (this.editor) return;
    const ctx = this.ctx();
    const target = caps.target;
    const text = readText(ctx, target);
    const svg = this.host.svg();
    if (text === null || !svg) {
      new Notice("Pele: this text cannot be edited here.");
      return;
    }
    this.hideMenu();
    this.outlines.clear();
    this.editor = openInlineEditor({
      app: this.host.app,
      doc: this.doc,
      placement: () => {
        const s = this.host.svg();
        return s ? labelPlacement(this.host.wrapper, s, target) : null;
      },
      hideLabel: () => hideLabel(this.host.wrapper, svg, target),
      text: opts.initialText ?? text,
      sourcePath: this.host.sourcePath,
      ...(opts.suggestions ? { suggestions: opts.suggestions } : {}),
      onCommit: (next) => {
        this.embedAccessory?.(); // embed-insert
        this.embedAccessory = null;
        this.editor = null;
        this.editing = null;
        if (next === text) {
          opts.after?.(false);
          return; // unchanged: no write
        }
        const res = applyEditMany(this.ctx(), [target], { op: "text", text: next });
        if (!res.ok) {
          if (res.error !== "unchanged") new Notice(res.error);
          opts.after?.(false);
          return;
        }
        console.debug("[pele-mermaid] edit: label", target, "inline editor");
        this.busy = true;
        void this.host
          .persist(res.source, res.switched ? "label (block switched to Mehrpele)" : "label")
          .then((ok) => opts.after?.(ok))
          .finally(() => (this.busy = false));
      },
      onCancel: () => {
        this.embedAccessory?.(); // embed-insert
        this.embedAccessory = null;
        this.editor = null;
        this.editing = null;
        if (!this.handingOver) opts.after?.(false);
      },
    });
    if (!this.editor) {
      new Notice("Pele: that label is not on screen; scroll to it and try again.");
      return;
    }
    this.editing = { target, chain: !!opts.chain, ...(opts.suggestions ? { suggestions: opts.suggestions } : {}) };
    // embed-insert: a node being labelled can become an embed from beside the editor.
    if (target.kind === "node" && this.host.settings().toolbar) {
      this.embedAccessory = attachEmbedAccessory({ app: this.host.app, doc: this.doc, handle: this.editor, sourcePath: this.host.sourcePath, nodeId: target.id });
    }
  }
}

/** The op re-picks what the element(s) already have: no write (and no reformatting). */
function isCurrent(c: Combined, op: EditOp): boolean {
  switch (op.op) {
    case "stroke":
      return c.currentStroke === op.value;
    case "heads":
      return c.currentHeads === op.value;
    case "shape":
      return c.currentShape === op.key;
    case "size":
      return c.currentSize === op.value;
    case "color":
      return JSON.stringify(c.currentColor) === JSON.stringify(op.value);
    default:
      return false;
  }
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** An inline SVG icon from trusted markup (Pele's own drawing or the fixed glyphs). */
function glyphSvg(doc: Document, markup: string, cls: string, viewBox?: string): SVGSVGElement {
  const parsed = new DOMParser().parseFromString(`<svg xmlns="${SVG_NS}"><g>${markup}</g></svg>`, "image/svg+xml").documentElement;
  const svg = doc.importNode(parsed, true) as unknown as SVGSVGElement;
  svg.setAttribute("class", cls);
  svg.setAttribute("aria-hidden", "true");
  if (viewBox) svg.setAttribute("viewBox", viewBox);
  return svg;
}

/** Frame an outline (measured in place) with a little room for its stroke. */
function fitGlyph(svg: SVGSVGElement): void {
  const g = svg.querySelector("g");
  const b = g?.getBBox();
  if (!b?.width || !b.height) return;
  const pad = Math.max(b.width, b.height) * 0.06;
  svg.setAttribute("viewBox", `${b.x - pad} ${b.y - pad} ${b.width + 2 * pad} ${b.height + 2 * pad}`);
}

/** The box Pele draws for node `id` of `source` (SVG units), or null. */
function renderedBox(source: string, id: string): { w: number; h: number } | null {
  try {
    const r = render(parse(source)) as unknown;
    const svg = String(typeof r === "string" ? r : (r as { svg?: string }).svg ?? "");
    const b = nodeBoxMap(svg).get(id);
    return b && b.w > 0 && b.h > 0 ? { w: b.w, h: b.h } : null;
  } catch {
    return null;
  }
}
