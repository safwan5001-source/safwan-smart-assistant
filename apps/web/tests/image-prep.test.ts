import { describe, expect, it } from "vitest";
import { addImages, bytesToBase64, fitSize, IMAGE_LIMITS, ImagePrepError, looksLikeImage, modelReadsImages, prepareImage, type Codec } from "@/lib/image-prep";
import { toolLabel } from "@/lib/tool-labels";

/** A fake codec: "encodes" to a blob whose size follows pixels x quality, records every attempt. */
const fakeCodec = (w: number, h: number, bytesPerPixel = 0.5, fail = false) => {
  const calls: { width: number; height: number; quality: number }[] = [];
  let closed = 0;
  const codec: Codec = {
    decode: async () => { if (fail) throw new Error("bad"); return { width: w, height: h, source: {}, close: () => { closed++; } }; },
    // a size-only blob: only the chosen result is ever read (keeps the test from allocating hundreds of MB)
    encode: async (_img, width, height, quality) => { calls.push({ width, height, quality }); const size = Math.round(width * height * bytesPerPixel * quality);
      return { size, type: "image/jpeg", arrayBuffer: async () => new ArrayBuffer(size) } as unknown as Blob; },
    previewUrl: () => "blob:preview",
  };
  return { codec, calls, closed: () => closed };
};
const file = (size = 1000, name = "IMG_0001.HEIC", type = "image/heic") => Object.assign(new Blob([new Uint8Array(size)], { type }), { name });

describe("image prep (B2)", () => {
  it("fitSize caps the longest edge, keeps the aspect ratio and never upscales", () => {
    expect(fitSize(4032, 3024, 2048)).toEqual({ width: 2048, height: 1536 });
    expect(fitSize(3024, 4032, 2048)).toEqual({ width: 1536, height: 2048 });
    expect(fitSize(800, 600, 2048)).toEqual({ width: 800, height: 600 });
    expect(fitSize(0, 0, 2048)).toEqual({ width: 1, height: 1 });
  });
  it("bytesToBase64 encodes in chunks (large buffers do not overflow the stack) and matches Buffer", () => {
    const big = new Uint8Array(300_000).map((_, i) => i % 251);
    expect(bytesToBase64(big)).toBe(Buffer.from(big).toString("base64"));
    expect(bytesToBase64(new Uint8Array([]))).toBe("");
  });
  it("re-encodes to a small JPEG: tries lower quality, then a smaller edge, until it fits the target", async () => {
    const { codec, calls, closed } = fakeCodec(4032, 3024);
    const p = await prepareImage(file(), codec);
    expect(p.mime).toBe("image/jpeg"); expect(p.name).toBe("IMG_0001.jpg");
    expect(p.bytes).toBeLessThanOrEqual(IMAGE_LIMITS.targetBytes);
    expect(calls[0]).toMatchObject({ width: 2048, height: 1536 });
    expect(calls.map((c) => c.quality)).toContain(0.82);
    expect(Math.max(...calls.map((c) => Math.max(c.width, c.height)))).toBeLessThanOrEqual(IMAGE_LIMITS.maxEdge);
    expect(p.data).toBe(Buffer.from(new Uint8Array(p.bytes)).toString("base64"));
    expect(closed()).toBe(1);
  });
  it("small photos are sent at their own size with the first quality", async () => {
    const { codec, calls } = fakeCodec(640, 480);
    const p = await prepareImage(file(), codec);
    expect(calls).toHaveLength(1); expect(p.width).toBe(640);
  });
  it("refuses unreadable, oversized source and too-large-after-compression photos", async () => {
    await expect(prepareImage(file(), fakeCodec(10, 10, 1, true).codec)).rejects.toMatchObject({ code: "unreadable" });
    await expect(prepareImage(file(IMAGE_LIMITS.maxSourceBytes + 1), fakeCodec(10, 10).codec)).rejects.toMatchObject({ code: "too_large" });
    await expect(prepareImage(file(), fakeCodec(4000, 4000, 100).codec)).rejects.toMatchObject({ code: "too_large" });
  });
  it("addImages enforces the count and the per-message total", async () => {
    const { codec } = fakeCodec(640, 480);
    const one = await addImages([], [file()], codec);
    expect(one).toHaveLength(1);
    await expect(addImages(one, Array.from({ length: IMAGE_LIMITS.maxImages }, () => file()), codec)).rejects.toBeInstanceOf(ImagePrepError);
    const heavy = fakeCodec(2048, 2048, 0.9).codec; // ~1.3 MB after the ladder; 8 of them stay under 14 MB
    expect((await addImages([], Array.from({ length: 8 }, () => file()), heavy)).length).toBe(8);
    const huge = fakeCodec(4000, 4000, 4).codec; // ~2.1 MB each even at the smallest size: over the 14 MB total by the 7th
    await expect(addImages([], Array.from({ length: 8 }, () => file()), huge)).rejects.toMatchObject({ code: "total_too_large" });
  });
  it("looksLikeImage and modelReadsImages", () => {
    expect(looksLikeImage({ type: "image/png" })).toBe(true);
    expect(looksLikeImage({ type: "", name: "x.HEIC" })).toBe(true);
    expect(looksLikeImage({ type: "application/pdf", name: "a.pdf" })).toBe(false);
    const models = [{ id: "mock/echo", input: ["text", "image"] }, { id: "mock/echo2", input: ["text"] }, { id: "x/y", input: [] }];
    expect(modelReadsImages("mock/echo", models)).toBe(true);
    expect(modelReadsImages("mock/echo2", models)).toBe(false);
    expect(modelReadsImages("x/y", models)).toBeNull();
    expect(modelReadsImages(null, models)).toBeNull();
    expect(modelReadsImages("mock/echo", [])).toBeNull();
  });
  it("tool labels: Arabic for known tools, the id otherwise", () => {
    expect(toolLabel("web_search")).toBe("بحث في الويب");
    expect(toolLabel("mcp__daftra__list_invoices")).toBe("list_invoices");
    expect(toolLabel("custom_tool")).toBe("custom_tool");
  });
});
