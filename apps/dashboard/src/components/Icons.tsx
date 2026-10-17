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
