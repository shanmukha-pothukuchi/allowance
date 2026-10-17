import { describe, expect, it } from "vitest";
import { embedApprovalId, mockRequested } from "./api/adapter";
import { announceableStatus, sizeMessage, statusMessage } from "./embed";
import { parseRoute, routeHash } from "./route";
import { themeFromSearch } from "./theme";

describe("approval embed (§13.5)", () => {
  it("is selected by ?approval=<id>&embed=1 only", () => {
    expect(embedApprovalId("?approval=apr_1&embed=1")).toBe("apr_1");
    expect(embedApprovalId("?embed=1&approval=apr_1&mock=1")).toBe("apr_1");
    expect(embedApprovalId("?approval=apr_1")).toBeNull(); // the chat's "Open dashboard" link: full app
    expect(embedApprovalId("?embed=1")).toBeNull();
    expect(mockRequested("?approval=apr_1&embed=1", {})).toBe(false); // never a silent mock
    expect(mockRequested("?approval=apr_1&embed=1&mock=1", {})).toBe(true);
  });
  it("posts the contract's message shapes", () => {
    expect(sizeMessage("apr_1", 240.2)).toEqual({ type: "allowance:approval-size", id: "apr_1", height: 241 });
    expect(statusMessage("apr_1", "approved")).toEqual({ type: "allowance:approval", id: "apr_1", status: "approved" });
  });
  it("announces only final statuses, and nothing for an unknown id", () => {
    expect(announceableStatus("pending")).toBeNull();
    expect(announceableStatus(undefined)).toBeNull();
    expect(announceableStatus("not_found")).toBeNull();
    expect(announceableStatus("approved")).toBe("approved");
    expect(announceableStatus("denied")).toBe("denied");
    expect(announceableStatus("expired")).toBe("expired");
  });
  it("takes a theme from the embedding page", () => {
    expect(themeFromSearch("?approval=a&embed=1&theme=light")).toBe("light");
    expect(themeFromSearch("?theme=dark")).toBe("dark");
    expect(themeFromSearch("?theme=neon")).toBeUndefined();
  });
});

describe("hash routes", () => {
  it("parses and builds overview / services / a service sheet", () => {
    expect(parseRoute("")).toEqual({ view: "overview" });
    expect(parseRoute("#/")).toEqual({ view: "overview" });
    expect(parseRoute("#/services")).toEqual({ view: "services", serviceId: undefined });
    expect(parseRoute("#/services/acme-pizza")).toEqual({ view: "services", serviceId: "acme-pizza" });
    expect(routeHash({ view: "services", serviceId: "custom-a b" })).toBe("#/services/custom-a%20b");
    expect(parseRoute(routeHash({ view: "services", serviceId: "custom-a b" }))).toEqual({ view: "services", serviceId: "custom-a b" });
  });
});
