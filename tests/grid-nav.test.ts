import { expect, test } from "bun:test";
import { gridMove } from "../src/grid-nav";

const ROWS = [4, 2, 6, 2]; // the flowchart shape popover

test("left / right run through the items in reading order, wrapping", () => {
  expect(gridMove(ROWS, { row: 0, col: 3 }, "ArrowRight")).toEqual({ row: 1, col: 0 });
  expect(gridMove(ROWS, { row: 1, col: 0 }, "ArrowLeft")).toEqual({ row: 0, col: 3 });
  expect(gridMove(ROWS, { row: 3, col: 1 }, "ArrowRight")).toEqual({ row: 0, col: 0 });
  expect(gridMove(ROWS, { row: 0, col: 0 }, "ArrowLeft")).toEqual({ row: 3, col: 1 });
});
test("up / down keep the column, clamped to shorter rows, and wrap", () => {
  expect(gridMove(ROWS, { row: 0, col: 3 }, "ArrowDown")).toEqual({ row: 1, col: 1 });
  expect(gridMove(ROWS, { row: 2, col: 5 }, "ArrowUp")).toEqual({ row: 1, col: 1 });
  expect(gridMove(ROWS, { row: 3, col: 0 }, "ArrowDown")).toEqual({ row: 0, col: 0 });
  expect(gridMove(ROWS, { row: 0, col: 2 }, "ArrowUp")).toEqual({ row: 3, col: 1 });
});
test("home / end; other keys are not moves", () => {
  expect(gridMove(ROWS, { row: 2, col: 2 }, "Home")).toEqual({ row: 0, col: 0 });
  expect(gridMove(ROWS, { row: 0, col: 0 }, "End")).toEqual({ row: 3, col: 1 });
  expect(gridMove(ROWS, { row: 0, col: 0 }, "Enter")).toBeNull();
  expect(gridMove([], { row: 0, col: 0 }, "ArrowRight")).toBeNull();
});
