/** Mutable chart runtime state (object so other modules can assign fields). */
export const chartState = {
  historyChart: null,
  chartCallbacks: {},
  activeHistory: null,
  activeRange: "5Y",
  pointerDown: null,
  indicatorFocus: null, // { key, label, scoreKey } | null
  seriesVisibility: {
    UMSI: true,
    Stress: false,
    Fragility: false,
    SPX: false,
  },
  hideLowQuality: false,
};
