#!/usr/bin/env python3
"""
Generate every BASHT | باشت brand asset the web app ships, from ONE official source:

    docs/brand/source/basht-logo-primary-official.png   (owner-supplied, mark + wordmark on a flat white canvas)

Nothing is redrawn. The only operations are:
  1. background removal (the canvas is perfectly flat: every pixel within 1 of #FEFEFE; artwork white is tinted ≥4),
     with thin bridges into the near-white turban severed so the dasmal is never eaten,
  2. cropping (mark = rows above the wordmark; wordmark = rows below it; the detached ب dot is kept inside the wordmark crop),
  3. resizing (Lanczos),
  4. a monochrome-white derivative of the wordmark (alpha kept, colour set to white) for dark surfaces,
     which is the same treatment as the pack's bsht-mono-white,
  5. placing the untouched mark on a plain tile / canvas for app icons, splash screens and the social card.

Usage:  python3 apps/web/scripts/generate-brand-assets.py      (needs Pillow, numpy, scipy)
Deterministic: no time- or random-dependent input.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy import ndimage

ROOT = Path(__file__).resolve().parents[3]
SRC = ROOT / "docs/brand/source/basht-logo-primary-official.png"
PUB = ROOT / "apps/web/public"
BRAND, ICONS, SPLASH = PUB / "brand", PUB / "icons", PUB / "icons/splash"
APP = ROOT / "apps/web/app"

# brand palette (Design System v1, §2)
PRIMARY, SECONDARY, CYAN, SURFACE = (76, 29, 149), (124, 58, 237), (6, 182, 212), (238, 242, 255)
INK, INK_2 = (16, 11, 30), (28, 21, 48)

# iPhone portrait launch screens: device px → (css w, css h, dpr). Mirrors SPLASH in apps/web/lib/brand.ts.
SPLASH_SIZES = [(1206, 2622), (1320, 2868), (1179, 2556), (1290, 2796), (1170, 2532), (1284, 2778), (1125, 2436), (828, 1792), (750, 1334)]


def cutout(path: Path) -> Image.Image:
    im = np.asarray(Image.open(path).convert("RGB")).astype(np.float32)
    dev = np.abs(im - 254).max(axis=2)
    st = ndimage.generate_binary_structure(2, 1)

    def border_connected(mask: np.ndarray) -> np.ndarray:
        lab, _ = ndimage.label(mask)
        ids = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))) - {0}
        return np.isin(lab, list(ids))

    bg = border_connected(dev <= 2)
    core = border_connected(ndimage.binary_opening(bg, structure=st, iterations=3))
    bg = bg & ndimage.binary_dilation(core, structure=st, iterations=4)
    fg = ndimage.binary_fill_holes(~bg)
    alpha = fg.astype(np.float32)
    band = fg & (ndimage.distance_transform_edt(fg) <= 1.5)
    alpha[band] = np.clip((254 - im).max(axis=2) / 254.0 * 1.6, 0, 1)[band]
    a = np.maximum(alpha, 1e-3)[..., None]
    rgb = im.copy()
    rgb[band] = np.clip((im - 254 * (1 - alpha[..., None])) / a, 0, 255)[band]
    return Image.fromarray(np.dstack([rgb, alpha * 255]).astype(np.uint8), "RGBA")


def split_rows(img: Image.Image) -> tuple[int, int]:
    """First fully transparent row gap below the mark → (mark_bottom, wordmark_top)."""
    rows = (np.asarray(img)[..., 3] > 127).sum(axis=1)
    y, h = int(np.argmax(rows > 0)), len(rows)
    while y < h and rows[y] > 0:
        y += 1
    top = y
    while top < h and rows[top] == 0:
        top += 1
    return y, top


def trim(img: Image.Image, pad: int = 0) -> Image.Image:
    box = img.getchannel("A").point(lambda v: 255 if v > 8 else 0).getbbox()
    assert box
    l, t, r, b = box
    return img.crop((max(0, l - pad), max(0, t - pad), min(img.width, r + pad), min(img.height, b + pad)))


def fit(img: Image.Image, w: int | None = None, h: int | None = None) -> Image.Image:
    if w and not h:
        h = round(img.height * w / img.width)
    if h and not w:
        w = round(img.width * h / img.height)
    return img.resize((w, h), Image.LANCZOS)


def ink_alpha(img: Image.Image) -> np.ndarray:
    """Alpha of the coloured ink only (0..1). The glossy light rims around letters and dots are left out: in the
    artwork they are what separates the detached ب dot from its letter, so whitening them would merge the dot."""
    px = np.asarray(img.convert("RGBA")).astype(np.float32) / 255
    lum = 0.2126 * px[..., 0] + 0.7152 * px[..., 1] + 0.0722 * px[..., 2]
    ink = np.clip((0.6 - lum) / 0.25, 0, 1) * px[..., 3]
    solid = ink > 0.5
    lab, n = ndimage.label(solid)
    sizes = ndimage.sum(np.ones_like(ink), lab, range(1, n + 1))
    keep = np.isin(lab, [i + 1 for i, sz in enumerate(sizes) if sz >= solid.size * 0.002])  # drop thin rim fragments
    keep = ndimage.binary_fill_holes(keep)  # the glossy highlight inside a dot is part of the shape
    near = ndimage.binary_dilation(keep, iterations=2)
    out = np.where(near, ink, 0)
    out[ndimage.binary_erosion(keep, iterations=2)] = 1
    return out


def mono_white(img: Image.Image) -> Image.Image:
    """Same treatment as the pack's bsht-mono-white: the drawing's shapes in white, nothing redrawn."""
    out = Image.new("RGBA", img.size, (255, 255, 255, 0))
    out.putalpha(Image.fromarray((ink_alpha(img) * 255).astype(np.uint8), "L"))
    return out


def shapes(alpha: np.ndarray, min_frac: float = 0.002) -> list[tuple[int, int, int, int, int]]:
    """Connected shapes (size, top, bottom, left, right) above a minimum size, largest first."""
    lab, n = ndimage.label(alpha > 0.5)
    objs = ndimage.find_objects(lab)
    sizes = ndimage.sum(np.ones_like(alpha), lab, range(1, n + 1))
    out = [(int(sz), o[0].start, o[0].stop, o[1].start, o[1].stop) for sz, o in zip(sizes, objs) if sz >= alpha.size * min_frac]
    return sorted(out, reverse=True)


# «باشت» drawing = «با» + «شت» + the detached ب dot + 2 ت dots + 3 ش dots
WORDMARK_SHAPES = 8


def check_wordmark(name: str, img: Image.Image, mono: bool) -> None:
    """Fail the build if the separated dots (above all the ب dot) have merged, e.g. after resizing."""
    a = np.asarray(img.getchannel("A")).astype(np.float32) / 255 if mono else ink_alpha(img)
    found = shapes(a)
    if len(found) != WORDMARK_SHAPES:
        raise SystemExit(f"{name}: expected {WORDMARK_SHAPES} separate shapes in the wordmark, found {len(found)} — a dot merged or split")
    h = a.shape[0]
    low = [s for s in found if s[1] > h * 0.6]  # the ب dot is the only shape that starts in the bottom 40 %
    if len(low) != 1:
        raise SystemExit(f"{name}: the detached ب dot is not a separate shape")


def check_untouched(src: Path, cut: Image.Image) -> None:
    """Every fully opaque pixel of the cut-out must equal the official file exactly (nothing recoloured or redrawn)."""
    a = np.asarray(cut)
    o = np.asarray(Image.open(src).convert("RGB"))
    if a.shape[:2] != o.shape[:2]:
        raise SystemExit("cut-out size differs from the source")
    opaque = a[..., 3] == 255
    if not np.array_equal(a[..., :3][opaque], o[opaque]):
        raise SystemExit("opaque pixels differ from the official source")


def radial(size: tuple[int, int], inner: tuple[int, int, int], outer: tuple[int, int, int], center=(0.5, 0.42), reach=0.85) -> Image.Image:
    w, h = size
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    d = np.sqrt(((xx / w - center[0]) * w / max(w, h)) ** 2 + ((yy / h - center[1]) * h / max(w, h)) ** 2) / (reach * 0.75)
    t = np.clip(d, 0, 1)[..., None] ** 1.3
    px = np.array(inner, np.float32) * (1 - t) + np.array(outer, np.float32) * t
    return Image.fromarray(px.astype(np.uint8), "RGB").convert("RGBA")


def glow(size: tuple[int, int], xy: tuple[float, float], r: float, color: tuple[int, int, int], strength: int) -> Image.Image:
    layer = Image.new("RGBA", size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    x, y = xy
    d.ellipse((x - r, y - r, x + r, y + r), fill=(*color, strength))
    return layer.filter(ImageFilter.GaussianBlur(r * 0.55))


def tile(size: int, mark: Image.Image, scale: float, dark: bool = False) -> Image.Image:
    bg = radial((size, size), INK_2 if dark else (255, 255, 255), INK if dark else (226, 220, 255), center=(0.5, 0.45), reach=1.0)
    if dark:
        bg.alpha_composite(glow((size, size), (size / 2, size * 0.48), size * 0.36, SECONDARY, 120))
    m = fit(mark, w=round(size * scale)) if mark.width >= mark.height else fit(mark, h=round(size * scale))
    bg.alpha_composite(m, ((size - m.width) // 2, (size - m.height) // 2 + round(size * 0.01)))
    return bg.convert("RGB")


def save_png(img: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, "PNG", optimize=True)


def save_quantized(img: Image.Image, path: Path) -> None:
    """Large flat-gradient canvases: 256-colour palette with dithering keeps them small without visible banding."""
    path.parent.mkdir(parents=True, exist_ok=True)
    img.convert("RGB").quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.FLOYDSTEINBERG).save(path, "PNG", optimize=True)


def save_webp(img: Image.Image, path: Path, lossless: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if lossless:
        img.save(path, "WEBP", lossless=True, quality=100, method=6)
    else:
        img.save(path, "WEBP", quality=92, alpha_quality=100, method=6)


def small_icon(mark: Image.Image, s: int) -> Image.Image:
    """Tiny sizes: Lanczos then a gentle unsharp mask on colour only (alpha untouched) so the face and dasmal stay legible."""
    m = fit(mark, h=s) if mark.height >= mark.width else fit(mark, w=s)
    rgb = m.convert("RGB").filter(ImageFilter.UnsharpMask(radius=0.6, percent=90, threshold=0))
    rgb.putalpha(m.getchannel("A"))
    canvas = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    canvas.alpha_composite(rgb, ((s - m.width) // 2, (s - m.height) // 2))
    return canvas


def main() -> None:
    raw = cutout(SRC)
    check_untouched(SRC, raw)
    full = trim(raw)
    cut, word_top = split_rows(full)
    mark = trim(full.crop((0, 0, full.width, cut)))
    word = trim(full.crop((0, word_top, full.width, full.height)))
    white_word = mono_white(word)
    check_wordmark("wordmark (source size)", word, mono=False)
    check_wordmark("mono-white wordmark (source size)", white_word, mono=True)

    # UI assets (transparent)
    save_webp(fit(full, w=640), BRAND / "basht-logo.webp")
    save_webp(fit(mark, h=480), BRAND / "basht-mark.webp")
    save_webp(fit(mark, h=144), BRAND / "basht-mark-sm.webp", lossless=True)
    word_ui, white_ui = fit(word, h=144), fit(white_word, h=144)
    check_wordmark("basht-wordmark.webp", word_ui, mono=False)
    check_wordmark("basht-wordmark-white.webp", white_ui, mono=True)
    save_webp(word_ui, BRAND / "basht-wordmark.webp", lossless=True)
    save_webp(white_ui, BRAND / "basht-wordmark-white.webp", lossless=True)

    # favicons (transparent mark)
    for s in (16, 32, 48):
        save_png(small_icon(mark, s), ICONS / f"favicon-{s}.png")

    # app icons: the mark on a light lavender tile (iOS needs opaque squares; the OS applies its own mask)
    save_png(tile(180, mark, 0.74), ICONS / "apple-touch-icon.png")
    save_png(tile(192, mark, 0.74), ICONS / "icon-192.png")
    save_png(tile(512, mark, 0.74), ICONS / "icon-512.png")
    save_png(tile(512, mark, 0.60), ICONS / "icon-maskable-512.png")  # inside the 80% maskable safe zone

    # iOS launch screens: light + dark, mark + official wordmark
    for w, h in SPLASH_SIZES:
        for dark in (False, True):
            bg = radial((w, h), INK_2 if dark else (255, 255, 255), INK if dark else SURFACE, center=(0.5, 0.44), reach=1.1)
            if dark:
                bg.alpha_composite(glow((w, h), (w / 2, h * 0.44), w * 0.42, SECONDARY, 95))
                bg.alpha_composite(glow((w, h), (w / 2, h * 0.47), w * 0.16, CYAN, 40))
            m = fit(mark, w=round(w * 0.44))
            wm = fit(white_word if dark else word, w=round(w * 0.30))
            gap = round(w * 0.05)
            top = (h - (m.height + gap + wm.height)) // 2 - round(h * 0.03)
            bg.alpha_composite(m, ((w - m.width) // 2, top))
            bg.alpha_composite(wm, ((w - wm.width) // 2, top + m.height + gap))
            save_quantized(bg, SPLASH / f"apple-splash-{w}x{h}{'-dark' if dark else ''}.png")

    # social card (Open Graph / Twitter)
    ow, oh = 1200, 630
    og = radial((ow, oh), INK_2, INK, center=(0.5, 0.45), reach=1.2)
    og.alpha_composite(glow((ow, oh), (ow / 2, oh * 0.45), 330, SECONDARY, 120))
    og.alpha_composite(glow((ow, oh), (ow * 0.5, oh * 0.5), 120, CYAN, 45))
    m = fit(mark, h=360)
    wm = fit(white_word, h=110)
    check_wordmark("opengraph wordmark", wm, mono=True)
    total = m.width + 56 + wm.width
    x0 = (ow - total) // 2
    og.alpha_composite(wm, (x0, (oh - wm.height) // 2 + 20))
    og.alpha_composite(m, (x0 + wm.width + 56, (oh - m.height) // 2))
    save_quantized(og, APP / "opengraph-image.png")
    print("brand assets written")


if __name__ == "__main__":
    main()
