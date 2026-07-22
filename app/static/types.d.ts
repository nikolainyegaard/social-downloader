// Type-checking support for the no-build vanilla JS frontend. Not loaded by
// the browser; consumed by tsc --checkJs via jsconfig.json (run with
// npx tsc -p jsconfig.json, or deno run -A npm:typescript/tsc -p jsconfig.json).
//
// The code fetches elements generically (getElementById, querySelector) and
// touches input/media/anchor properties on the results. Augmenting the base
// DOM interfaces here keeps the check focused on real errors (typos, wrong
// config keys, bad arity) instead of demanding a cast at every DOM access.

interface HTMLElement {
  value: string;
  checked: boolean;
  disabled: boolean;
  src: string;
  href: string;
  download: string;
  type: string;
  placeholder: string;
  play(): Promise<void>;
  pause(): void;
  paused: boolean;
  ended: boolean;
  muted: boolean;
  controls: boolean;
  currentTime: number;
  duration: number;
}

interface Element {
  dataset: DOMStringMap;
  style: CSSStyleDeclaration;
  isContentEditable: boolean;
  disabled: boolean;
  selectionEnd: number | null;
  focus(): void;
  setSelectionRange(start: number | null, end: number | null): void;
  readonly offsetWidth: number;
  // Expando: an open dropdown remembers its body-portaled menu element
  _menu?: Element | null;
}

interface EventTarget {
  classList?: DOMTokenList;
  tagName?: string;
  click(): void;
  closest?(selector: string): Element | null;
}

// Vendored cal-heatmap (vendor/cal-heatmap.min.js) global for the Stories
// calendar; typed loosely since only paint/on/destroy are used.
declare var CalHeatmap: any;

interface Window {
  // Legacy clipboard fallback used in the paste handler
  clipboardData?: { getData(format: string): string };
}

// Cross-file references to functions that initChannelApp (channels.js)
// registers dynamically on window as {prefix}{Name}, so tsc cannot see the
// definitions. Declare only the ones actually called from other files.
declare function ttLoadStatus(): void;
declare function ttOpenVidModal(videoId: string): void;
declare function ttOpenCarousel(videoId: string): void;
declare function ytGetCreators(): any[];
