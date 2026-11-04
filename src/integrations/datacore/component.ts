/**
 * Preact component factory for `datacorejsx` blocks.
 *
 * Datacore blocks cannot import Pele modules, and `dc` (DatacoreLocalApi,
 * datacore/src/api/local-api.tsx:267 useQuery, :198 preact hooks) cannot be
 * extended from outside. So `peleMermaid.component(dc)` returns a Preact
 * component that mounts Pele into a ref via the published global. Usage:
 *
 *   const Pele = window.peleMermaid.component(dc);
 *   return function View() {
 *     const rows = dc.useQuery("@page and #project");
 *     const src = "...build flowchart source from rows...";
 *     return <Pele source={src} />;
 *   }
 */

export interface PeleGlobalLike {
  version: string;
  mount: (el: HTMLElement, source: string, opts?: { maxWidth?: number }) => { destroy(): void; update?: (s: string) => void };
  render: (source: string, opts?: { maxWidth?: number }) => unknown;
  component: (dc: DcLike) => PeleComponent;
}

export type PeleComponent = (props: { source: string; maxWidth?: number }) => unknown;

export interface DcLike {
  preact?: { h?: (...args: unknown[]) => unknown };
  h?: (...args: unknown[]) => unknown;
  useRef?: (init: unknown) => { current: unknown };
  useEffect?: (fn: () => void | (() => void), deps?: unknown[]) => void;
  [key: string]: unknown;
}

export function createPeleComponent(dc: DcLike, api?: PeleGlobalLike): PeleComponent {
  const h = dc.preact?.h ?? dc.h;
  if (typeof h !== "function" || typeof dc.useRef !== "function" || typeof dc.useEffect !== "function") {
    throw new Error("peleMermaid.component(dc) needs Datacore's dc (preact h + hooks). Use window.peleMermaid.mount(el, source) instead.");
  }
  const createElement = h;
  const useRef = dc.useRef.bind(dc);
  const useEffect = dc.useEffect.bind(dc);
  return function PeleView(props: { source: string; maxWidth?: number }): unknown {
    const ref = useRef(null) as { current: HTMLElement | null };
    useEffect(() => {
      const el = ref.current;
      if (!el) return undefined;
      const pele = api ?? ((window as unknown as { peleMermaid?: PeleGlobalLike }).peleMermaid);
      if (!pele) {
        el.textContent = "Mehrpele is not loaded.";
        return undefined;
      }
      const handle = pele.mount(el, props.source, props.maxWidth !== undefined ? { maxWidth: props.maxWidth } : undefined);
      return () => handle.destroy();
    }, [props.source, props.maxWidth]);
    return createElement("div", { ref, className: "pele-datacore-mount" });
  };
}
