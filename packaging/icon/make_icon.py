#!/usr/bin/env python3
"""Draws the Prompt2Print icon and writes every icon asset the app and installer need.

Design: a slate "print bed" tile with three magenta layers stacked like a print growing
upwards (widest at the bottom). They also read as lines of typed text, and a white text cursor
sits at the end of the top layer, where the nozzle is: a prompt turning into a print.

Outputs (paths relative to the project root):
  packaging/icon/prompt2print.ico   multi-size icon for the .exe, shortcuts and the installer
  packaging/icon/png/icon-<n>.png   every size, for review
  public/img/favicon.ico            16/32/48 favicon
  public/img/icon-192.png           web app icon
  public/img/logo.svg               vector logo (icon only)
"""
import io
import os
import struct
import sys

from PIL import Image, ImageDraw

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT_DIR = os.path.join(ROOT, 'packaging', 'icon')

SLATE = (0x20, 0x26, 0x2E, 255)
MAGENTA = (0xD6, 0x24, 0x6E, 255)
WHITE = (0xFF, 0xFF, 0xFF, 255)

# Geometry on a 256 grid (x0, y0, x1, y1).
TILE = (8, 8, 248, 248)
TILE_R = 52
BARS = [  # bottom -> top, left-aligned like lines of text
    (56, 160, 200, 188),
    (56, 120, 160, 148),
    (56, 80, 116, 108),
]
BAR_R = 5
CURSOR = (128, 68, 144, 116)
CURSOR_R = 3


def draw_vector(size, supersample=4):
    """Anti-aliased render of the full design for sizes 48 px and up."""
    big = size * supersample
    s = big / 256.0
    img = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    sc = lambda box: tuple(round(v * s) for v in box)
    d.rounded_rectangle(sc(TILE), radius=round(TILE_R * s), fill=SLATE)
    for b in BARS:
        d.rounded_rectangle(sc(b), radius=round(BAR_R * s), fill=MAGENTA)
    d.rounded_rectangle(sc(CURSOR), radius=round(CURSOR_R * s), fill=WHITE)
    return img.resize((size, size), Image.BOX)


# Hand-placed pixel layouts for the small sizes, so every edge lands on a whole pixel.
# Rects are (x0, y0, x1, y1) with x1/y1 exclusive.
PIXEL_LAYOUTS = {
    16: dict(tile=(0, 0, 16, 16), r=3,
             bars=[(3, 11, 13, 13), (3, 8, 10, 10), (3, 5, 6, 7)],
             cursor=(7, 3, 8, 7)),
    24: dict(tile=(0, 0, 24, 24), r=5,
             bars=[(5, 16, 19, 19), (5, 11, 15, 14), (5, 6, 10, 9)],
             cursor=(12, 4, 14, 10)),
    32: dict(tile=(1, 1, 31, 31), r=6,
             bars=[(7, 21, 25, 25), (7, 15, 20, 19), (7, 9, 14, 13)],
             cursor=(16, 7, 18, 14)),
    48: dict(tile=(1, 1, 47, 47), r=10,
             bars=[(10, 30, 38, 35), (10, 23, 30, 28), (10, 16, 22, 21)],
             cursor=(24, 13, 27, 21)),
}


def draw_pixel(size):
    lay = PIXEL_LAYOUTS[size]
    ss = 8
    img = Image.new('RGBA', (size * ss, size * ss), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    x0, y0, x1, y1 = lay['tile']
    d.rounded_rectangle((x0 * ss, y0 * ss, x1 * ss - 1, y1 * ss - 1), radius=lay['r'] * ss, fill=SLATE)
    tile = img.resize((size, size), Image.LANCZOS)  # anti-aliased tile corners only
    px = tile.load()
    def fill(rect, color):
        a, b, c, e = rect
        for y in range(b, e):
            for x in range(a, c):
                px[x, y] = color
    for bar in lay['bars']:
        fill(bar, MAGENTA)
    fill(lay['cursor'], WHITE)
    return tile


def render(size):
    return draw_pixel(size) if size in PIXEL_LAYOUTS else draw_vector(size)


def bmp_entry(img):
    """32-bit BGRA DIB with AND mask, as stored inside .ico files."""
    w, h = img.size
    header = struct.pack('<IiiHHIIiiII', 40, w, h * 2, 1, 32, 0, 0, 0, 0, 0, 0)
    px = img.load()
    rows = bytearray()
    for y in range(h - 1, -1, -1):
        for x in range(w):
            r, g, b, a = px[x, y]
            rows += bytes((b, g, r, a))
    mask_row_bytes = ((w + 31) // 32) * 4
    mask = bytearray()
    for y in range(h - 1, -1, -1):
        row = bytearray(mask_row_bytes)
        for x in range(w):
            if px[x, y][3] == 0:
                row[x // 8] |= 0x80 >> (x % 8)
        mask += row
    return header + bytes(rows) + bytes(mask)


def png_bytes(img):
    buf = io.BytesIO()
    img.save(buf, format='PNG', optimize=True)
    return buf.getvalue()


def write_ico(path, images):
    """images: list of PIL images; the 256 px entry is PNG-compressed, smaller ones are BMP."""
    entries = []
    for img in images:
        data = png_bytes(img) if img.size[0] >= 256 else bmp_entry(img)
        entries.append((img.size[0], data))
    out = bytearray(struct.pack('<HHH', 0, 1, len(entries)))
    offset = 6 + 16 * len(entries)
    for size, data in entries:
        dim = 0 if size >= 256 else size
        out += struct.pack('<BBBBHHII', dim, dim, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    for _, data in entries:
        out += data
    with open(path, 'wb') as f:
        f.write(out)


def write_svg(path):
    def rect(box, r, color):
        x0, y0, x1, y1 = box
        return (f'<rect x="{x0}" y="{y0}" width="{x1 - x0}" height="{y1 - y0}" rx="{r}" '
                f'fill="#{color[0]:02X}{color[1]:02X}{color[2]:02X}"/>')
    parts = [rect(TILE, TILE_R, SLATE)] + [rect(b, BAR_R, MAGENTA) for b in BARS] + [rect(CURSOR, CURSOR_R, WHITE)]
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" aria-label="Prompt2Print">'
           + ''.join(parts) + '</svg>\n')
    with open(path, 'w') as f:
        f.write(svg)


def main():
    png_dir = os.path.join(OUT_DIR, 'png')
    os.makedirs(png_dir, exist_ok=True)
    sizes = [16, 24, 32, 48, 64, 128, 256]
    imgs = {}
    for s in sizes + [192, 512]:
        imgs[s] = render(s)
        imgs[s].save(os.path.join(png_dir, f'icon-{s}.png'))
    write_ico(os.path.join(OUT_DIR, 'prompt2print.ico'), [imgs[s] for s in sizes])

    public_img = os.path.join(ROOT, 'public', 'img')
    os.makedirs(public_img, exist_ok=True)
    write_ico(os.path.join(public_img, 'favicon.ico'), [imgs[16], imgs[32], imgs[48]])
    imgs[192].save(os.path.join(public_img, 'icon-192.png'), optimize=True)
    write_svg(os.path.join(public_img, 'logo.svg'))

    # Contact sheet for review.
    sheet = Image.new('RGBA', (sum(sizes) + 20 * len(sizes) + 20, 300), (240, 240, 240, 255))
    x = 20
    for s in sizes:
        sheet.alpha_composite(imgs[s], (x, 20))
        x += s + 20
    sheet.save(os.path.join(png_dir, 'contact-sheet.png'))
    print('icon assets written')


if __name__ == '__main__':
    sys.exit(main())
