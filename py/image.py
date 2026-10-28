#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""图像后处理与自检（只用 Pillow，不依赖 numpy）。

VMD 在 Windows 上**只写 BMP**（写 .png 会报 "Unrecognized image file extension" 并偷偷
写成 BMP），所以这里固定做 BMP → PNG，顺带裁掉白边、出一份统计给模型判断「这张图是不是
空的」。

用法：
    python image.py convert in.bmp out.png [--trim]
    python image.py stats in.png

stdout 是**一行 JSON**，由 Node 侧解析。
"""

import json
import sys

from PIL import Image, ImageChops


def non_white_percent(im):
    """非白像素占比（0~100）。用直方图算，比逐像素快两个数量级。"""
    gray = im.convert("L")
    hist = gray.histogram()
    total = sum(hist) or 1
    # 250 以上算“白”，留一点抗锯齿余量
    non_white = sum(hist[:250])
    return round(100.0 * non_white / total, 3)


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"ok": False, "error": "usage: image.py convert|stats <in> [out] [--trim]"}))
        return 1

    cmd = sys.argv[1]
    src = sys.argv[2]

    if cmd == "convert":
        dst = sys.argv[3]
        trim = "--trim" in sys.argv
        im = Image.open(src).convert("RGB")
        info = {"ok": True, "src": src, "inSize": list(im.size)}

        if trim:
            bg = Image.new("RGB", im.size, (255, 255, 255))
            bbox = ImageChops.difference(im, bg).getbbox()
            if bbox:
                pad = 12
                bbox = (
                    max(0, bbox[0] - pad),
                    max(0, bbox[1] - pad),
                    min(im.size[0], bbox[2] + pad),
                    min(im.size[1], bbox[3] + pad),
                )
                im = im.crop(bbox)
                info["bbox"] = list(bbox)

        if dst.lower().endswith((".tif", ".tiff")):
            im.save(dst, compression="tiff_lzw", dpi=(600, 600))
        else:
            im.save(dst)

        info["out"] = dst
        info["outSize"] = list(im.size)
        info["nonWhitePercent"] = non_white_percent(im)
        print(json.dumps(info))
        return 0

    if cmd == "stats":
        im = Image.open(src).convert("RGB")
        print(json.dumps({"ok": True, "src": src, "size": list(im.size), "nonWhitePercent": non_white_percent(im)}))
        return 0

    print(json.dumps({"ok": False, "error": f"unknown command: {cmd}"}))
    return 1


if __name__ == "__main__":
    sys.exit(main())
