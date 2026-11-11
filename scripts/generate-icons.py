"""Generate StudyNext application and tray icons.

Usage: python scripts/generate-icons.py
Requires Pillow. The generated files are committed as build assets.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "build"
RESOURCES = ROOT / "resources"


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def gradient(size: int) -> Image.Image:
    top = (23, 48, 105)
    bottom = (7, 16, 34)
    image = Image.new("RGB", (size, size))
    pixels = image.load()
    for y in range(size):
        t = y / max(size - 1, 1)
        ease = t * t * (3 - 2 * t)
        color = tuple(round(top[i] + (bottom[i] - top[i]) * ease) for i in range(3))
        for x in range(size):
            # Radial highlight behind the graduation cap.
            dx = (x - size * 0.42) / size
            dy = (y - size * 0.28) / size
            glow = max(0.0, 1.0 - (dx * dx + dy * dy) * 5.2) ** 2
            pixels[x, y] = tuple(min(255, round(color[i] + glow * (28, 71, 150)[i] * 0.42)) for i in range(3))
    return image


def draw_icon(size: int) -> Image.Image:
    scale = size / 1024
    canvas = gradient(size).convert("RGBA")

    overlay = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    def p(points: list[tuple[float, float]]) -> list[tuple[int, int]]:
        return [(round(x * scale), round(y * scale)) for x, y in points]

    # Soft teal halo.
    halo = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(halo).ellipse(
        (round(size * 0.12), round(size * 0.10), round(size * 0.88), round(size * 0.86)),
        fill=(45, 212, 191, 26),
    )
    overlay = Image.alpha_composite(overlay, halo.filter(ImageFilter.GaussianBlur(round(size * 0.08))))
    draw = ImageDraw.Draw(overlay)

    # Graduation cap crown.
    cap = p([(512, 245), (790, 352), (512, 459), (234, 352)])
    draw.polygon(cap, fill=(255, 255, 255, 255))
    draw.polygon(p([(512, 245), (790, 352), (512, 459)]), fill=(226, 245, 255, 255))

    # Cap base.
    draw.rounded_rectangle(
        (round(352 * scale), round(398 * scale), round(672 * scale), round(536 * scale)),
        radius=round(30 * scale),
        fill=(241, 248, 255, 255),
    )
    draw.rounded_rectangle(
        (round(390 * scale), round(470 * scale), round(634 * scale), round(500 * scale)),
        radius=round(15 * scale),
        fill=(94, 234, 212, 255),
    )

    # Tassel.
    draw.line(p([(746, 376), (746, 520)]), fill=(250, 204, 21, 255), width=round(14 * scale))
    draw.ellipse(
        (
            round(726 * scale),
            round(512 * scale),
            round(766 * scale),
            round(558 * scale),
        ),
        fill=(250, 204, 21, 255),
    )

    # Open book beneath the cap.
    left_page = p([(246, 626), (492, 590), (492, 804), (246, 768)])
    right_page = p([(532, 590), (778, 626), (778, 768), (532, 804)])
    draw.polygon(left_page, fill=(255, 255, 255, 246))
    draw.polygon(right_page, fill=(214, 249, 244, 246))
    draw.line(p([(512, 592), (512, 802)]), fill=(23, 48, 105, 255), width=round(18 * scale))
    for offset in (0, 52, 104):
        draw.line(
            p([(294, 666 + offset), (446, 646 + offset)]),
            fill=(96, 165, 250, 180),
            width=round(10 * scale),
        )
        draw.line(
            p([(578, 646 + offset), (730, 666 + offset)]),
            fill=(45, 212, 191, 180),
            width=round(10 * scale),
        )

    canvas = Image.alpha_composite(canvas, overlay)
    canvas.putalpha(rounded_mask(size, round(size * 0.22)))
    return canvas


def main() -> None:
    BUILD.mkdir(parents=True, exist_ok=True)
    RESOURCES.mkdir(parents=True, exist_ok=True)

    icon = draw_icon(1024)
    icon.resize((512, 512), Image.Resampling.LANCZOS).save(BUILD / "icon.png")
    icon.resize((512, 512), Image.Resampling.LANCZOS).save(RESOURCES / "icon.png")
    icon.save(
        BUILD / "icon.ico",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )

    tray = draw_icon(256).resize((32, 32), Image.Resampling.LANCZOS)
    tray.save(RESOURCES / "tray.png")

    print("icons written to build/ and resources/")


if __name__ == "__main__":
    main()
