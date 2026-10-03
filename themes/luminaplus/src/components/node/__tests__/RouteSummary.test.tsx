// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, it, expect } from "vitest";
import { RouteSummary } from "../RouteSummary";

describe("route comparison", () => {
  it("keeps reverse routes while forward measurements are missing", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => { root.render(<RouteSummary returnRoute={{ telecom: "CN2 GIA" }} />); });
    expect(container.textContent).toContain("CN2 GIA");
    expect(container.textContent).toContain("待检测");
    expect(container.textContent).not.toContain("优质");
    await act(async () => root.unmount());
  });
  it("switches address families without reusing IPv4 measurements", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => { root.render(<RouteSummary returnRoute={{ telecom: "CN2 GIA" }} forwardRoutes={{ ipv4: { telecom: "163", region: "上海", source: "自有探针" }, ipv6: { telecom: "IPv6专用路线" } }} />); });
    expect(container.textContent).toContain("手动记录");
    expect(container.textContent).toContain("上海");
    const button = [...container.querySelectorAll("button")].find(button => button.textContent === "IPV6")!;
    await act(async () => button.click());
    expect(container.textContent).toContain("IPv6专用路线");
    expect(container.textContent).not.toContain("CN2 GIA");
    expect(button.getAttribute("aria-pressed")).toBe("true");
    await act(async () => root.unmount());
  });
});
