/** Tiny hash router: #/ (overview), #/services, #/services/<id>. Pure parse + a hook. */
import { useEffect, useState } from "react";

export type Route = { view: "overview" } | { view: "services"; serviceId?: string };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "services") return { view: "services", serviceId: parts[1] };
  return { view: "overview" };
}

export function routeHash(r: Route): string {
  if (r.view === "services") return r.serviceId ? `#/services/${encodeURIComponent(r.serviceId)}` : "#/services";
  return "#/";
}

export function navigate(r: Route) {
  const h = routeHash(r);
  if (location.hash !== h) location.hash = h;
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const on = () => setRoute(parseRoute(location.hash));
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return route;
}
