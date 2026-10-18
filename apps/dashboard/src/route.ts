/**
 * Tiny hash router: #/ (overview), #/portfolio, #/schedules, #/services, #/services/<id>. Pure parse + a hook.
 * Owner sheets live in the query string instead (`?sheet=new-agent`, §14.3) so the same URL works
 * embedded; `useSheetRoute` reads and writes it.
 */
import { useCallback, useEffect, useState } from "react";
import { sheetFromSearch, withSheet, type SheetRoute } from "./sheets";

export type Route = { view: "overview" } | { view: "portfolio" } | { view: "schedules" } | { view: "services"; serviceId?: string };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "services") return { view: "services", serviceId: parts[1] };
  if (parts[0] === "portfolio" || parts[0] === "schedules") return { view: parts[0] };
  return { view: "overview" };
}

export function routeHash(r: Route): string {
  if (r.view === "services") return r.serviceId ? `#/services/${encodeURIComponent(r.serviceId)}` : "#/services";
  if (r.view === "portfolio" || r.view === "schedules") return `#/${r.view}`;
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

/** The open owner sheet (`?sheet=…`), and a setter that keeps the hash and the other params. */
export function useSheetRoute(): [SheetRoute | null, (r: SheetRoute | null) => void] {
  const [sheet, setSheet] = useState(() => sheetFromSearch(location.search));
  useEffect(() => {
    const on = () => setSheet(sheetFromSearch(location.search));
    addEventListener("popstate", on);
    return () => removeEventListener("popstate", on);
  }, []);
  const set = useCallback((r: SheetRoute | null) => {
    const url = `${location.pathname}${withSheet(location.search, r)}${location.hash}`;
    if (r) history.pushState(history.state, "", url);
    else history.replaceState(history.state, "", url);
    setSheet(r);
  }, []);
  return [sheet, set];
}
