// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, it, expect } from "vitest";
import { RouteSummary } from "../RouteSummary";

describe("route comparison", () => {
  it("shows one preferred route label and no expandable route details", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => { root.render(<RouteSummary returnRoute={{ telecom: "CN2 GIA", carrier_meta: { telecom: { route_path: "AS4809 → AS4134" } } }} />); });
    expect(container.textContent).toContain("CN2GIA");
    expect(container.textContent).toContain("待检测");
    expect(container.textContent).not.toContain("优质");
    expect(container.textContent).not.toContain("查看路径");
    expect(container.textContent).not.toContain("详情");
    expect(container.textContent).not.toContain("AS4809");
    await act(async () => root.unmount());
  });
  it("shows only the best carrier grade and switches address families", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => { root.render(<RouteSummary returnRoute={{ telecom: "CN2 GIA" }} forwardRoutes={{ ipv4: { telecom: "普通国际 → CN2 → AS4809", unicom: "4837 → 9929 → AS9929", mobile: "CMI → CMIN2 → AS58807" }, ipv6: { telecom: "CMI → AS58453" } }} />); });
    expect(container.textContent).toContain("CN2");
    expect(container.textContent).toContain("9929");
    expect(container.textContent).toContain("CMIN2");
    expect(container.textContent).not.toContain("普通国际");
    expect(container.textContent).not.toContain("AS4809");
    const button = [...container.querySelectorAll("button")].find(button => button.textContent === "IPV6")!;
    await act(async () => button.click());
    expect(container.textContent).toContain("CMI");
    expect(container.textContent).not.toContain("AS58453");
    expect(container.textContent).not.toContain("CN2GIA");
    expect(button.getAttribute("aria-pressed")).toBe("true");
    await act(async () => root.unmount());
  });
});
