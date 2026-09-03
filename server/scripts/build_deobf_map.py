#!/usr/bin/env python3
"""番茄小说反混淆映射表构建工具。

番茄小说将正文高频字替换为私用区字符（U+E3E8 起），并指定一个混淆字体渲染。
字体 URL 全局固定（如 awesome-font/c/dc027189e0ba4cd.woff2），故映射表构建一次即可固化。

构建方法：把混淆字体中每个私用区 glyph 渲染成位图，与参考字体（思源黑体/Noto Sans CJK）
渲染的 GB2312 常用字位图做汉明距离匹配；每个参考字体渲染原始/膨胀1px/膨胀2px 三个
变体取最小距离，吸收字重差异。低距离可疑映射需用真实章节上下文人工判定后写入 FIXES。

用法：
  python3 build_deobf_map.py --obf obf.ttf --out ../src/data/fanqie_deobf_map.json \
      --ref /path/SourceHanSansSC-Normal.otf --ref /path/NotoSansCJKsc-Regular.otf
"""
import argparse
import json
import os

import numpy as np
from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont, ImageFilter

SIZE = 32
POPCOUNT = np.array([bin(i).count('1') for i in range(256)], dtype=np.uint8)

# 上下文人工判定修正（按需追加；key 为码位 hex，value 为正确汉字）
FIXES = {'0xe54c': '子'}

SUSPICIOUS_SIMPLE = set('十一+二三人入八了个')

PU_RANGE = [0xE3E8, 0xE55B]


def make_renderer(path):
    font = ImageFont.truetype(path, 40)

    def render(ch):
        img = Image.new('L', (SIZE, SIZE), 255)
        d = ImageDraw.Draw(img)
        bbox = d.textbbox((0, 0), ch, font=font)
        w, h2 = bbox[2] - bbox[0], bbox[3] - bbox[1]
        if w <= 0 or h2 <= 0:
            return np.zeros(SIZE * SIZE, dtype=np.uint8)
        d.text(((SIZE - w) // 2 - bbox[0], (SIZE - h2) // 2 - bbox[1]), ch, fill=0, font=font)
        return (np.array(img, dtype=np.uint8).reshape(-1) < 128).astype(np.uint8)

    return render


def pack(bits):
    n = bits.shape[1]
    m = (n + 7) // 8
    if n % 8:
        pad = np.zeros((bits.shape[0], m * 8 - n), dtype=np.uint8)
        bits = np.concatenate([bits, pad], axis=1)
    return np.packbits(bits, axis=1)


def gb2312_chars():
    out = []
    for hi in range(0xB0, 0xD8):
        for lo in range(0xA1, 0xFF):
            if hi == 0xD7 and lo > 0xF9:
                continue
            try:
                out.append(bytes([hi, lo]).decode('gb2312'))
            except UnicodeDecodeError:
                pass
    return out


def dilate_variants(bits):
    n = bits.shape[0]
    imgs = bits.reshape(n, SIZE, SIZE) * 255
    out = [bits]
    cur = imgs
    for _ in range(2):
        nxt = np.zeros_like(cur)
        for i in range(n):
            im = Image.fromarray(cur[i].astype(np.uint8), 'L').filter(ImageFilter.MaxFilter(3))
            nxt[i] = (np.array(im) > 128).astype(np.uint8) * 255
        cur = nxt
        out.append(cur.reshape(n, SIZE * SIZE) // 255)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--obf', required=True, help='混淆字体路径（woff2/ttf/otf）')
    ap.add_argument('--out', required=True, help='输出 JSON 路径')
    ap.add_argument('--ref', action='append', required=True, help='参考字体路径，可多次')
    args = ap.parse_args()

    obf_font = TTFont(args.obf)
    obf_cmap = obf_font.getBestCmap()
    codes = sorted(c for c in obf_cmap.keys() if PU_RANGE[0] <= c <= PU_RANGE[1])
    if not codes:
        raise SystemExit('obfuscation font has no private-use glyphs')

    obf_render = make_renderer(args.obf)
    obf_pack = pack(np.vstack([obf_render(chr(c)) for c in codes]))

    cand = list(dict.fromkeys(gb2312_chars() + list('，。！？；：、…—·「」『』（）《》〈〉')))

    ref_packs = []
    for rp in args.ref:
        r = make_renderer(rp)
        bits = np.vstack([r(c) for c in cand])
        ref_packs.append([pack(v) for v in dilate_variants(bits)])
        print(f'rendered {rp}', flush=True)

    mapping = {}
    for i, code in enumerate(codes):
        best_d, best_j = None, -1
        for packs in ref_packs:
            for p in packs:
                dists = POPCOUNT[obf_pack[i] ^ p].sum(axis=1)
                j = int(dists.argmin())
                if best_d is None or int(dists[j]) < best_d:
                    best_d, best_j = int(dists[j]), j
        mapping[code] = (cand[best_j], best_d)

    final = {hex(c): ch for c, (ch, _) in mapping.items()}
    final.update(FIXES)

    susp = [(hex(c), ch, d) for c, (ch, d) in mapping.items() if ch in SUSPICIOUS_SIMPLE and d > 30]
    if susp:
        print('suspicious low-confidence mappings (verify with real chapter context):')
        for s in susp:
            print('  ', s)

    out = {
        'meta': {
            'source': 'fanqienovel.com obfuscated font',
            'method': 'multi-font dilate-aligned bitmap matching + context fixes',
            'pu_range': PU_RANGE,
        },
        'map': final,
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print(f'saved {len(final)} entries -> {args.out}')


if __name__ == '__main__':
    main()
