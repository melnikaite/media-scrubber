"""Generate extension/icons/{16,48,128}.png with a pure-Python PNG writer.

Run: python3 tools/make_icons.py
"""
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(__file__), '..', 'extension', 'icons')


def png(path, w, h, pixels):
    raw = b''.join(b'\x00' + bytes(pixels[y * w * 4:(y + 1) * w * 4]) for y in range(h))

    def chunk(tag, data):
        c = tag + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)

    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n')
        f.write(chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)))
        f.write(chunk(b'IDAT', zlib.compress(raw, 9)))
        f.write(chunk(b'IEND', b''))


def coverage(x, y, s, r):
    """Anti-aliased coverage of a rounded square (radius r) for pixel (x, y)."""
    n, hit = 4, 0
    for i in range(n):
        for j in range(n):
            px, py = x + (i + .5) / n, y + (j + .5) / n
            cx = min(max(px, r), s - r)
            cy = min(max(py, r), s - r)
            if (px - cx) ** 2 + (py - cy) ** 2 <= r * r:
                hit += 1
    return hit / (n * n)


def icon(s):
    px = [0] * (s * s * 4)
    r = s * 0.22
    bar_h = max(2, round(s * 0.14))
    bar_y0 = (s - bar_h) // 2
    bx0, bx1 = round(s * 0.16), s - round(s * 0.16)
    head_w = max(2, round(s * 0.12))
    head_h = max(bar_h + 2, round(s * 0.42))
    hx0 = round(s * 0.55)
    hy0 = (s - head_h) // 2
    for y in range(s):
        for x in range(s):
            a = coverage(x, y, s, r)
            col = (0x2B, 0x2E, 0x33)
            if hx0 <= x < hx0 + head_w and hy0 <= y < hy0 + head_h:
                col = (0x5A, 0xA8, 0xFF)
            elif bx0 <= x < bx1 and bar_y0 <= y < bar_y0 + bar_h:
                col = (0xFF, 0xFF, 0xFF)
            i = (y * s + x) * 4
            px[i:i + 4] = [col[0], col[1], col[2], round(a * 255)]
    return px


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    for s in (16, 48, 128):
        png(os.path.join(OUT, f'{s}.png'), s, s, icon(s))
        print('wrote', s)
