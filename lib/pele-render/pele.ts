/**
 * Pele with per-node sizing: `pele/core` plus every built-in diagram, the
 * sizable ones wrapped so `%% pele-size … %%` entries size their nodes (see
 * node-size/solve.ts). A drop-in for `import … from "pele"`: same exports,
 * same output for sources without the directive. Everything in pele-render
 * (and the Obsidian plugin) renders through this module, so sizes are
 * honoured by mount, render, check, Canvas and Excalidraw alike. Flowcharts
 * also honour `%% pele-layout canvas %%` positions (canvas/layout.ts).
 */
import { register } from "pele/core";
import type { Diagram } from "pele";
import agentflow from "pele/diagrams/agentflow";
import architecture from "pele/diagrams/architecture";
import block from "pele/diagrams/block";
import c4 from "pele/diagrams/c4";
import klass from "pele/diagrams/class";
import cynefin from "pele/diagrams/cynefin";
import er from "pele/diagrams/er";
import eventmodeling from "pele/diagrams/eventmodeling";
import flowchart from "pele/diagrams/flowchart";
import gantt from "pele/diagrams/gantt";
import gitGraph from "pele/diagrams/gitGraph";
import info from "pele/diagrams/info";
import ishikawa from "pele/diagrams/ishikawa";
import journey from "pele/diagrams/journey";
import kanban from "pele/diagrams/kanban";
import mindmap from "pele/diagrams/mindmap";
import packet from "pele/diagrams/packet";
import pie from "pele/diagrams/pie";
import quadrantChart from "pele/diagrams/quadrantChart";
import radar from "pele/diagrams/radar";
import railroad from "pele/diagrams/railroad";
import requirement from "pele/diagrams/requirement";
import sankey from "pele/diagrams/sankey";
import sequence from "pele/diagrams/sequence";
import state from "pele/diagrams/state";
import swimlane from "pele/diagrams/swimlane";
import timeline from "pele/diagrams/timeline";
import treemap from "pele/diagrams/treemap";
import treeView from "pele/diagrams/treeView";
import usecase from "pele/diagrams/usecase";
import venn from "pele/diagrams/venn";
import wardley from "pele/diagrams/wardley";
import xychart from "pele/diagrams/xychart";
import { SIZABLE_TYPES } from "./node-size/adapters.js";
import { withNodeSizing } from "./node-size/solve.js";
import { withCanvasLayout } from "./canvas/layout.js";

const sizable = new Set<string>(SIZABLE_TYPES);
const all: Diagram<unknown>[] = [
  agentflow, architecture, block, c4, klass, cynefin, er, eventmodeling, flowchart, gantt, gitGraph, info,
  ishikawa, journey, kanban, mindmap, packet, pie, quadrantChart, radar, railroad, requirement, sankey,
  sequence, state, swimlane, timeline, treemap, treeView, usecase, venn, wardley, xychart,
];
// Canvas layout (`%% pele-layout canvas %%`, flowchart only) sits inside the
// sizing wrapper, so sized boxes are placed at their pinned centres.
register(...all.map((d) => withCanvasLayout(d)).map((d) => (sizable.has(d.type) ? withNodeSizing(d) : d)));

export * from "pele/core";
export type { DiagramModel } from "pele";
