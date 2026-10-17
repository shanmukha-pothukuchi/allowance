/** Tiny inline SVG icons; stroke inherits currentColor so status colour never stands alone. */
import type { SVGProps } from "react";

const base: SVGProps<SVGSVGElement> = {
  width: 22,
  height: 22,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2.2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
};

export const ArrowOut = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}><path d="M7 17 17 7M9 7h8v8" /></svg>
);
export const ArrowIn = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}><path d="M17 7 7 17M15 17H7V9" /></svg>
);
export const Shield = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3Z" /><path d="m9 9 6 6M15 9l-6 6" /></svg>
);
export const Snowflake = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}><path d="M12 2v20M2 12h20M5 5l14 14M19 5 5 19" /><path d="M12 2l-2 2 2 2 2-2zM12 22l-2-2 2-2 2 2zM2 12l2-2 2 2-2 2zM22 12l-2-2-2 2 2 2z" /></svg>
);
export const Clock = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
);
export const Check = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}><path d="m5 12 5 5 9-10" /></svg>
);
export const Cross = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}><path d="M6 6l12 12M18 6 6 18" /></svg>
);
export const Plus = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}><path d="M12 5v14M5 12h14" /></svg>
);
export const Bolt = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" /></svg>
);
export const Info = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>
);
export const Sun = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
);
export const Plug = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}><path d="M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0V7ZM12 17v5" /></svg>
);
export const Unplug = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}><path d="M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0V7ZM12 17v5M3 3l18 18" /></svg>
);
export const Search = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
);
export const Moon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" /></svg>
);
export const Warn = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}><path d="M12 3 2 20h20L12 3Z" /><path d="M12 10v4M12 17h.01" /></svg>
);
export const Close = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}><path d="M6 6l12 12M18 6 6 18" /></svg>
);
export const Chevron = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}><path d="m9 6 6 6-6 6" /></svg>
);
export const Lock = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
);
