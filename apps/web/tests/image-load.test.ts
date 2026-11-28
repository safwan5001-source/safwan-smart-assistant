import { describe, expect, it } from "vitest";
import { bustUrl, canRetryImage, imageLoadReducer, initImageLoad, MAX_IMAGE_RETRIES, reduceImageLoad } from "@/lib/image-load";

const URL1 = "/api/basht/media?key=agent%3Amain%3Aapp%3Aowner&msg=m1&ref=abc";
describe("image load state machine (loading / ready / error with bounded retries)", () => {
  it("loading → ready on load; a late error after ready is ignored", () => {
    let s = initImageLoad(URL1);
    expect(s).toMatchObject({ status: "loading", attempt: 0, src: URL1 });
    s = imageLoadReducer(s, { type: "load" });
    expect(s.status).toBe("ready");
    expect(imageLoadReducer(s, { type: "error" }).status).toBe("ready");
  });
  it("error → retry reloads the SAME address with a cache-busting parameter and goes back to loading", () => {
    let s = imageLoadReducer(initImageLoad(URL1), { type: "error" });
    expect(s.status).toBe("error"); expect(canRetryImage(s)).toBe(true);
    s = imageLoadReducer(s, { type: "retry" });
    expect(s).toMatchObject({ status: "loading", attempt: 1, url: URL1, src: URL1 + "&_r=1" });
  });
  it("retries are bounded: after the limit the tile stays on «غير متاحة» with no retry (no endless loop)", () => {
    let s = initImageLoad(URL1);
    let reloads = 0;
    for (let i = 0; i < 20; i++) {
      s = imageLoadReducer(s, { type: "error" });
      if (!canRetryImage(s)) break;
      s = imageLoadReducer(s, { type: "retry" }); reloads++;
    }
    expect(reloads).toBe(MAX_IMAGE_RETRIES);
    expect(s.status).toBe("error");
    expect(canRetryImage(s)).toBe(false);
    expect(imageLoadReducer(s, { type: "retry" })).toBe(s); // a further tap does nothing
    expect(reduceImageLoad(initImageLoad("/x"), { type: "error" }, 0)).toMatchObject({ status: "error" });
    expect(canRetryImage(reduceImageLoad(initImageLoad("/x"), { type: "error" }, 0), 0)).toBe(false);
  });
  it("a retry that succeeds ends in ready; retry only works from the error state", () => {
    let s = initImageLoad(URL1);
    expect(imageLoadReducer(s, { type: "retry" })).toBe(s); // loading: nothing to retry
    s = imageLoadReducer(imageLoadReducer(imageLoadReducer(s, { type: "error" }), { type: "retry" }), { type: "load" });
    expect(s).toMatchObject({ status: "ready", attempt: 1 });
  });
  it("a new address resets; the same address keeps its state", () => {
    const s = imageLoadReducer(initImageLoad(URL1), { type: "load" });
    expect(imageLoadReducer(s, { type: "reset", url: URL1 })).toBe(s);
    expect(imageLoadReducer(s, { type: "reset", url: "/other" })).toMatchObject({ status: "loading", attempt: 0, src: "/other" });
  });
  it("bustUrl: appends with ? or &, keeps the fragment, never touches blob:/data: URLs", () => {
    expect(bustUrl("/a", 0)).toBe("/a");
    expect(bustUrl("/a", 2)).toBe("/a?_r=2");
    expect(bustUrl("/a?x=1#f", 3)).toBe("/a?x=1&_r=3#f");
    expect(bustUrl("blob:https://x/1", 2)).toBe("blob:https://x/1");
    expect(bustUrl("data:image/png;base64,AA", 2)).toBe("data:image/png;base64,AA");
  });
});
