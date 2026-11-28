import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Source-contract test (WEAKER than the Playwright check in the batch-3 e2e: it reads CSS, it does not lay anything out). It pins the
// invariant that broke in review: the log must be the one flexible child of .chat-main, however many optional strips sit above it.
const css = readFileSync(join(resolve(__dirname, ".."), "app/globals.css"), "utf8");
const rule = (sel: string) => [...css.matchAll(new RegExp("(?:^|\\n)" + sel.replace(/[.>*]/g, "\\$&") + "\\s*\\{([^}]*)\\}", "g"))].map((m) => m[1]).join(" ");

describe("chat layout: the log is THE flexible row (review P1)", () => {
  it(".chat-main is a flex column, not a fixed three-row grid that an optional child would shift", () => {
    const main = rule(".chat-main");
    expect(main).toMatch(/display:\s*flex/);
    expect(main).toMatch(/flex-direction:\s*column/);
    expect(main).not.toMatch(/grid-template-rows/);
    expect(main).toMatch(/min-height:\s*0/);
  });
  it("every other direct child keeps its own height; only .chat-log grows and may shrink to scroll", () => {
    expect(rule(".chat-main > *")).toMatch(/flex:\s*none/);
    const log = rule(".chat-main > .chat-log");
    expect(log).toMatch(/flex:\s*1 1 0/);
    expect(log).toMatch(/min-height:\s*0/);
  });
  it("the executed-model strip is a plain block (no grid placement of its own)", () => {
    expect(rule(".model-exec")).not.toMatch(/grid-/);
  });
});
