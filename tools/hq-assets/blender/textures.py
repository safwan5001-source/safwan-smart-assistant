"""
BASHT HQ — procedural, tileable surface textures (numpy, deterministic). Each returns an (N, N, 3) float array in sRGB [0, 1].
Tileable because every noise layer is built from integer-frequency sines on a torus, so the left/right and top/bottom edges
meet seamlessly when the texture repeats every 2 m on the floor (see the UV0 projection in build_building.py).
"""
import numpy as np


def _grid(n):
    t = np.linspace(0, 2 * np.pi, n, endpoint=False)
    return np.meshgrid(t, t)


def _tile_noise(n, seed, octaves=5, base=2):
    """Smooth periodic noise: a sum of random integer-frequency sinusoids (period = texture size)."""
    rng = np.random.default_rng(seed)
    x, y = _grid(n)
    out = np.zeros((n, n))
    amp = 1.0
    for o in range(octaves):
        f = base * 2 ** o
        for _ in range(6):
            kx, ky = rng.integers(-f, f + 1, size=2)
            ph = rng.uniform(0, 2 * np.pi)
            out += amp * np.sin(kx * x + ky * y + ph)
        amp *= 0.5
    out -= out.min()
    return out / max(out.max(), 1e-9)


def marble(n=1024, seed=7):
    """Warm white marble with soft grey veins and a faint gold thread (matches the reference lobby floor)."""
    x, y = _grid(n)
    warp = _tile_noise(n, seed, octaves=5, base=1)
    veins = np.abs(np.sin(2 * x + 1 * y + 6.0 * warp))
    veins = 1 - np.clip(veins * 6, 0, 1)  # thin bright lines → vein mask
    fine = _tile_noise(n, seed + 1, octaves=4, base=4)
    base = np.array([0.93, 0.915, 0.93])
    col = base[None, None, :] * (0.97 + 0.03 * fine[..., None])
    col = col * (1 - 0.18 * veins[..., None]) + np.array([0.55, 0.53, 0.6])[None, None, :] * 0.18 * veins[..., None]
    gold = 1 - np.clip(np.abs(np.sin(1 * x - 2 * y + 4.0 * warp)) * 22, 0, 1)
    col = col * (1 - 0.25 * gold[..., None]) + np.array([0.83, 0.68, 0.36])[None, None, :] * 0.25 * gold[..., None]
    return np.clip(col, 0, 1)


def oak(n=1024, seed=11, planks=6):
    """Light oak planks: per-plank tone, grain along the plank, thin dark seams; `planks` boards per 2 m tile."""
    rng = np.random.default_rng(seed)
    u = np.linspace(0, 1, n, endpoint=False)
    U, V = np.meshgrid(u, u)
    idx = np.floor(V * planks).astype(int)
    tone = rng.uniform(0.86, 1.05, size=planks)[idx]
    grain = _tile_noise(n, seed + 3, octaves=4, base=2)
    lines = 0.5 + 0.5 * np.sin(2 * np.pi * (V * planks * 9) + 9 * grain)
    base = np.array([0.80, 0.62, 0.43])
    col = base[None, None, :] * tone[..., None] * (0.9 + 0.1 * lines[..., None])
    seam = (np.abs((V * planks) % 1 - 0.0) < 0.012) | (np.abs((V * planks) % 1 - 1) < 0.012)
    # staggered end joints
    off = rng.uniform(0, 1, size=planks)[idx]
    seam |= (np.abs(((U + off) * 2) % 1) < 0.004)
    col[seam] *= 0.55
    return np.clip(col, 0, 1)


def carpet(n=512, seed=5, rgb=(0.20, 0.12, 0.36)):
    """Deep-purple executive carpet with a subtle woven texture."""
    fine = _tile_noise(n, seed, octaves=3, base=16)
    x, y = _grid(n)
    weave = 0.5 + 0.5 * np.sin(64 * x) * np.sin(64 * y)
    col = np.array(rgb)[None, None, :] * (0.9 + 0.1 * fine[..., None] + 0.05 * weave[..., None])
    return np.clip(col, 0, 1)


def to_blender_image(bpy, name, arr):
    """Create a packed Blender image from an sRGB float array (rows top→bottom)."""
    n = arr.shape[0]
    img = bpy.data.images.new(name, n, n, alpha=False)
    rgba = np.concatenate([arr[::-1], np.ones((n, n, 1))], axis=2).astype(np.float32)  # Blender rows are bottom→top
    img.pixels.foreach_set(rgba.ravel())
    img.pack()
    return img
