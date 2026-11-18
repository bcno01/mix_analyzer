"""PWAアイコン(PNG)を生成する。icons/icon.svg と同じデザインをPillowで描く。

使い方（Pillow入りのPythonで。PATH上の python は 3.14 で Pillow が無いことがあるので 3.13 をフルパス指定）:
    python tools/gen_icons.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

BG = (14, 19, 32)
BAR = (76, 201, 240)
REF = (255, 179, 71)
BARS = [(76, 270, 110), (136, 200, 180), (196, 140, 240), (256, 170, 210), (316, 220, 160), (376, 290, 90)]


def draw(size: int, margin: float = 0.0, rounded: bool = True) -> Image.Image:
    """512基準のデザインを size に描く。margin は maskable 用の安全余白（比率）。"""
    ss = 4  # スーパーサンプリング
    s = size * ss
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if rounded:
        d.rounded_rectangle((0, 0, s - 1, s - 1), radius=int(s * 104 / 512), fill=BG)
    else:
        d.rectangle((0, 0, s, s), fill=BG)
    k = s / 512 * (1 - 2 * margin)
    off = s * margin

    def p(v):
        return off + v * k

    for x, y, h in BARS:
        d.rounded_rectangle((p(x), p(y), p(x + 40), p(y + h)), radius=10 * k, fill=BAR)
    d.rounded_rectangle((p(60), p(244), p(452), p(250)), radius=3 * k, fill=REF)
    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    out = Path(__file__).resolve().parent.parent / "icons"
    out.mkdir(exist_ok=True)
    draw(192).save(out / "icon-192.png")
    draw(512).save(out / "icon-512.png")
    # maskable: 全面に背景を敷き、図柄は中央80%の安全領域に収める
    draw(512, margin=0.1, rounded=False).save(out / "icon-maskable-512.png")
    draw(180, rounded=False).convert("RGB").save(out / "apple-touch-icon.png")
    print("icons written to", out)


if __name__ == "__main__":
    main()
