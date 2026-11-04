/** The settings tab's parts, reached from the core through `lazy.settingsTab()`. */
export { buildDefinitions, enableKey, type TabContext } from "./definitions";
export { FoldState, revealFolded } from "./folds";
export { installTour, removedMessage, removeTour, type TourDeps } from "./tour";
export { readControl, writeControl } from "./values";
