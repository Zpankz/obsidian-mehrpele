/** A frame's bar can be moved out of its clipping ancestors. */
export const floatedActionBars = new WeakMap<HTMLElement, HTMLElement>();
export const actionBarOwners = new WeakMap<HTMLElement, HTMLElement>();

export function actionRootOf(bar: HTMLElement): HTMLElement | null {
  return actionBarOwners.get(bar) ?? bar.parentElement;
}

export function actionBarOf(root: HTMLElement): HTMLElement | null {
  return floatedActionBars.get(root) ?? root.querySelector<HTMLElement>(":scope > .embed-actions");
}
