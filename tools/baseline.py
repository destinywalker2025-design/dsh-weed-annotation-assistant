#!/usr/bin/env python3
"""杂草图片自动标注引擎。

操作规范见 docs/SPEC.md，本文件实现其中 §6（引擎）与 §5（输出）。

设计要点：
- 几何层：经典 CV 白卡检测，无模型。
- 类别层：HSV+HOG 特征库 kNN，无训练。
- 精度主来源：§6.3 段级传播（视频帧相邻帧同卡）。
- 只依赖 opencv + numpy。

用法：
  python annotate.py --images 数据集 --refs 杂草种类 --train .../outputs --out auto_annotations
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import sys
from collections import Counter, defaultdict
from pathlib import Path
from xml.etree import ElementTree as ET
from xml.sax.saxutils import escape

import cv2
import numpy as np

# stdout 一律 UTF-8：Node 侧按 utf8 解析 JSONL，不受 Windows 控制台代码页影响
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, OSError):
        pass

CROP = "__crop__"
IMG_EXT = (".jpg", ".jpeg", ".png", ".bmp", ".webp")

# 类别完全由调用方决定，脚本不内置任何物种名。
#   优先级：--class-map 给的 {子目录名: 英文类名}  →  --train 里 XML 的 <name>
#           →  refs 子目录名（原样使用，不做任何中英翻译）
# 类名由插件按「参考图子文件夹 + 用户给的标签文档」算好后传进来。
CROP_DIRS = ("作物", "crop", "negative", "empty", "背景", "non-weed", "nonweed")

# 全局开关：True 时用四边形候选（实测更差，仅实验用）
QUAD_MODE = False


# ---------------------------------------------------------------- 基础 IO


def imread(path: Path):
    """支持中文路径的读取。"""
    try:
        data = np.fromfile(str(path), dtype=np.uint8)
    except OSError:
        return None
    if data.size == 0:
        return None
    return cv2.imdecode(data, cv2.IMREAD_COLOR)


def emit(kind: str, **payload) -> None:
    print(json.dumps({"type": kind, **payload}, ensure_ascii=False), flush=True)


def scan_key(stem: str):
    """§2.2 解析 (seq, index)；解析失败归入 misc。"""
    m = re.search(r"\((\d+)\)\s*$", stem)
    if m:
        return stem[: m.start()].strip(" (_-"), int(m.group(1))
    m = re.search(r"(\d+)\s*$", stem)
    if m:
        return stem[: m.start()].strip(" (_-"), int(m.group(1))
    return "misc", 0


def norm_ref_name(name: str) -> str:
    """`稗草1` -> `稗草`；`barnyard_grass_2` -> `barnyard_grass`。"""
    s = re.sub(r"^\d+[\s._-]*", "", str(name).strip())
    s = re.sub(r"[\s._-]*\d+$", "", s)
    return s.strip()


def discover_classes(train_dir, refs_dir, skip=frozenset(), class_map=None):
    """类别完全由数据决定，不写死任何物种。

    class_map 形如 {"classes": ["barnyard_grass"], "folderMap": {"稗草1": "barnyard_grass"}}，
    由插件按「参考图子文件夹 + 用户提供的标签文档」算好后传入，优先级最高。
    否则回退到：--train 的 XML <name> → refs 子目录名（原样）。
    """
    classes, seen = [], set()

    def add(name):
        name = (name or "").strip()
        if name and name != CROP and name not in seen:
            seen.add(name)
            classes.append(name)

    class_map = class_map or {}
    folder_map = class_map.get("folderMap") or {}
    for c in class_map.get("classes") or []:
        add(c)

    if train_dir and Path(train_dir).is_dir():
        for xml in sorted(Path(train_dir).glob("*.xml")):
            if xml.stem in skip:
                continue
            try:
                root = ET.parse(xml).getroot()
            except ET.ParseError:
                continue
            for obj in root.findall("object"):
                add(obj.findtext("name"))

    ref_map = {}
    if refs_dir and Path(refs_dir).is_dir():
        known = {c.lower(): c for c in classes}
        for sub in sorted(p for p in Path(refs_dir).iterdir() if p.is_dir()):
            raw = sub.name
            base = norm_ref_name(raw)
            low = f"{raw} {base}".lower()
            if any(k in low for k in CROP_DIRS):
                ref_map[raw] = CROP
                continue
            cls = folder_map.get(raw) or folder_map.get(base)
            if not cls:
                cls = known.get(base.lower()) or known.get(raw.lower())
            if not cls:
                cls = base or raw  # 调用方没给映射：直接用目录名当类名
            ref_map[raw] = cls
            add(cls)
    return classes, ref_map


# ---------------------------------------------------------------- 几何（§6.1）


def _quad_of(contour):
    """把轮廓拟合成 4–6 边形；不是四边形就返回 None（背景亮块在这一步被筛掉）。"""
    peri = cv2.arcLength(contour, True)
    if peri <= 0:
        return None
    for eps in (0.02, 0.03, 0.045, 0.06):
        ap = cv2.approxPolyDP(contour, eps * peri, True)
        if 4 <= len(ap) <= 6:
            return ap
    return None


def _valid_card(quad):
    """卡片校验：凸、尺寸合理、长宽比合理、四边形填满外接框。"""
    if quad is None or len(quad) < 4:
        return None
    if not cv2.isContourConvex(quad):
        return None
    area = cv2.contourArea(quad)
    x, y, w, h = cv2.boundingRect(quad)
    if area < 8000 or w < 45 or h < 45:
        return None
    if not (0.45 <= w / float(h) <= 2.2):
        return None
    if area / float(w * h) < 0.68:  # 背景亮区轮廓是不规则形状，填不满外接框
        return None
    return (quad, (x, y, x + w, y + h), int(area))


def _seed_contours(img):
    """两类种子：亮卡连通域 + 边缘围成的封闭区域。"""
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    v, s = hsv[:, :, 2], hsv[:, :, 1]
    m = ((v > 90) & (s < 90)).astype(np.uint8) * 255
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8))
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    seeds = list(cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[0])

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(gray, 45, 130)
    edges = cv2.dilate(edges, np.ones((3, 3), np.uint8), iterations=1)
    edges = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    seeds += list(cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)[0])
    return seeds


def _blob_candidates(img, limit=4):
    """亮度连通域候选（v1 行为，实测最稳：106 张上 IoU 0.835）。"""
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    v, s = hsv[:, :, 2], hsv[:, :, 1]
    m = ((v > 90) & (s < 90)).astype(np.uint8) * 255
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8))
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    raw = []
    for c in cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[0]:
        a = cv2.contourArea(c)
        if a < 4000:
            continue
        x, y, w, h = cv2.boundingRect(c)
        if w < 30 or h < 30:
            continue
        if not (0.4 <= w / float(h) <= 2.3):
            continue
        raw.append((c, (x, y, x + w, y + h), a))
    raw.sort(key=lambda t: -t[2])
    kept = []
    for item in raw:
        if any(bbox_iou(item[1], k[1]) > 0.7 for k in kept):
            continue
        kept.append(item)
    return kept[:limit]


def _quad_candidates(img, limit=4):
    """四边形候选：先拟合四边形并校验，再做面积去重。

    背景亮区轮廓不规则、填不满外接框，会在校验里被丢掉。
    实测（106 张）IoU 只有 0.47——比连通域方案差，经 --quads 开关启用。
    """
    raw = []
    for c in _seed_contours(img):
        item = _valid_card(_quad_of(c))
        if item:
            raw.append(item)
    raw.sort(key=lambda t: -t[2])
    kept = []
    for item in raw:
        if any(bbox_iou(item[1], k[1]) > 0.7 for k in kept):
            continue
        kept.append(item)
    return kept[:limit]


def candidates(img, limit=4):
    return _quad_candidates(img, limit) if QUAD_MODE else _blob_candidates(img, limit)


FEATURES = 7


def candidate_features(img, contour, bbox):
    """候选卡的 7 维特征：尺寸、长宽比、白度、绿植、暗部、矩形度、线稿感。"""
    x1, y1, x2, y2 = bbox
    H, W = img.shape[:2]
    crop = img[max(0, y1) : min(H, y2), max(0, x1) : min(W, x2)]
    if crop.size == 0:
        return np.zeros(FEATURES, np.float32)
    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    s = hsv[:, :, 1].astype(np.float32)
    v = hsv[:, :, 2].astype(np.float32)
    hue = hsv[:, :, 0].astype(np.float32)
    white = float(((s < 60) & (v > 120)).mean())
    green = float(((hue > 25) & (hue < 100) & (s > 60)).mean())
    dark = float((v < 90).mean())
    w, h = max(1, x2 - x1), max(1, y2 - y1)
    area_frac = math.sqrt(float(w * h) / float(W * H))
    rect = min(1.0, float(cv2.contourArea(contour)) / float(w * h))
    return np.array(
        [area_frac, abs(w / float(h) - 1.0), white, green, dark, rect, white - green], np.float32
    )


class TargetPicker:
    """用已有标注监督「选哪张卡」。

    直接优化真正的任务——同一帧里目标卡的分数要高于其它候选卡——
    所以用成对感知机（pairwise perceptron），而不是逐样本逻辑回归：
    只有 100 来个标注帧时，分类损失退化成“全都判正”，排序损失不会。
    """

    def __init__(self, w, mean, std):
        self.w, self.mean, self.std = w, mean, std

    @classmethod
    def fit(cls, feats, pairs, epochs=60, lr=0.05, l2=1e-4):
        X = np.vstack(feats)
        mean = X.mean(axis=0)
        std = X.std(axis=0)
        std = np.where(std < 1e-6, 1.0, std)
        w = np.zeros(X.shape[1], np.float64)
        for _ in range(epochs):
            for pos, neg in pairs:
                d = (pos - neg) / std
                if float(d @ w) < 1.0:
                    w += lr * d
                    w -= l2 * w
        return cls(w, mean, std)

    def score(self, feat):
        return float(((feat - self.mean) / self.std) @ self.w)


def build_picker(train_dir, skip=frozenset()):
    """从已有标注学习目标卡判别器；样本不足时返回 (None, 0) 退回手写打分。"""
    if not train_dir or not Path(train_dir).is_dir():
        return None, 0
    train_dir = Path(train_dir)
    feats, pairs = [], []
    for xml in sorted(train_dir.glob("*.xml")):
        if xml.stem in skip:
            continue
        try:
            root = ET.parse(xml).getroot()
        except ET.ParseError:
            continue
        img_path = resolve_train_image(root, xml, train_dir)
        if img_path is None:
            continue
        img = imread(img_path)
        if img is None:
            continue
        gold = []
        for obj in root.findall("object"):
            pts = object_points(obj)
            if len(pts) < 3:
                continue
            xs = [p[0] for p in pts]
            ys = [p[1] for p in pts]
            gold.append((min(xs), min(ys), max(xs), max(ys)))
        if not gold:
            continue  # 空标注帧没有正例，不参与选卡学习
        cands = candidates(img)
        if len(cands) < 2:
            continue  # 只有一张卡时没有可学的选择
        ious = [max((bbox_iou(bbox, g) for g in gold), default=0.0) for _, bbox, _ in cands]
        best = int(np.argmax(ious))
        if ious[best] < 0.5:
            continue  # 金标准卡没被检出，这一帧给不出监督
        for i, (contour, bbox, _) in enumerate(cands):
            if i == best:
                pos = candidate_features(img, contour, bbox)
                feats.append(pos)
        # 先收齐本帧全部候选，再和正例配成对
        idxs = [len(feats) - 1]
        for i, (contour, bbox, _) in enumerate(cands):
            if i == best:
                continue
            idxs.append(len(feats))
            feats.append(candidate_features(img, contour, bbox))
        for idx in idxs[1:]:
            pairs.append((idxs[0], idx))
    if len(pairs) < 10:
        return None, len(pairs)
    return TargetPicker.fit(feats, pairs), len(pairs)


def heuristic_score(img, contour, bbox, area):
    """没有标注可学时的手写打分（v1 行为，作为 fallback）。"""
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    x1, y1, x2, y2 = bbox
    q = hsv[y1:y2, x1:x2]
    white = float(((q[:, :, 1] < 60) & (q[:, :, 2] > 120)).mean())
    plant = float((((q[:, :, 1] > 45) | (q[:, :, 2] < 110)) & (q[:, :, 2] > 20)).mean())
    return min(area / 40000.0, 2.0) * 0.35 + white * 0.55 + plant * 0.35


def detect_card(img):
    """建特征库时用：按手写打分取一张卡。"""
    cs = candidates(img)
    if not cs:
        return None
    best = max(cs, key=lambda t: heuristic_score(img, t[0], t[1], t[2]))
    return (best[0], best[1])


def polygon_of(contour, bbox, w: int, h: int):
    """§4.4 轮廓 -> 4~8 点多边形，clamp 到图像范围内。"""
    peri = cv2.arcLength(contour, True)
    approx = cv2.approxPolyDP(contour, 0.02 * peri, True)
    if 4 <= len(approx) <= 8:
        pts = [[int(round(p[0][0])), int(round(p[0][1]))] for p in approx]
    else:
        x1, y1, x2, y2 = bbox
        pts = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]
    return [[max(0, min(w, x)), max(0, min(h, y))] for x, y in pts]


def bbox_iou(a, b) -> float:
    if not a or not b:
        return 0.0
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
    iw, ih = max(0, ix2 - ix1), max(0, iy2 - iy1)
    inter = iw * ih
    if inter <= 0:
        return 0.0
    ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return float(inter) / float(ua) if ua > 0 else 0.0


# ---------------------------------------------------------------- 特征（§6.2）


def plant_mask(hsv):
    return ((hsv[:, :, 1] > 45) | (hsv[:, :, 2] < 110)).astype(np.uint8)


def hog_like(gray):
    gray = cv2.resize(gray, (64, 64), interpolation=cv2.INTER_AREA)
    gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
    mag = cv2.magnitude(gx, gy)
    ang = (np.arctan2(gy, gx) + np.pi) * (9.0 / (2.0 * np.pi))
    bins = np.clip(ang.astype(np.int32), 0, 8)
    cells = []
    for by in range(0, 64, 8):
        for bx in range(0, 64, 8):
            cell = np.zeros(9, dtype=np.float32)
            b = bins[by : by + 8, bx : bx + 8].reshape(-1)
            m = mag[by : by + 8, bx : bx + 8].reshape(-1)
            np.add.at(cell, b, m)
            cells.append(cell)
    vec = np.concatenate(cells).astype(np.float32)
    n = float(np.linalg.norm(vec))
    return vec / n if n > 1e-6 else vec


def feature(img):
    if img is None or img.size == 0:
        return None
    img = cv2.resize(img, (96, 96), interpolation=cv2.INTER_AREA)
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    mask = plant_mask(hsv)
    if int(mask.sum()) < 80:
        mask[:] = 1
    hist = cv2.calcHist([hsv], [0, 1], mask, [12, 8], [0, 180, 0, 256]).astype(np.float32).reshape(-1)
    s = float(hist.sum())
    hist = hist / s if s > 0 else hist
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    vec = np.concatenate([hist * 0.65, hog_like(gray) * 0.35]).astype(np.float32)
    n = float(np.linalg.norm(vec))
    return vec / n if n > 1e-6 else vec


def plant_crop(img):
    """参考图没有卡片时，按绿植外接框裁切。"""
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    m = plant_mask(hsv)
    ys, xs = np.where(m > 0)
    if len(xs) > 100:
        x1, x2 = max(0, int(xs.min())), min(img.shape[1], int(xs.max()) + 1)
        y1, y2 = max(0, int(ys.min())), min(img.shape[0], int(ys.max()) + 1)
        crop = img[y1:y2, x1:x2]
        if crop.size:
            return crop
    return img


# ---------------------------------------------------------------- 特征库


def resolve_train_image(root, xml: Path, train_dir: Path):
    filename = root.findtext("filename") or (xml.stem + ".jpg")
    declared = Path(root.findtext("path") or "")
    candidates = [
        declared,
        train_dir.parent / "JPEGImages" / filename,
        train_dir / "JPEGImages" / filename,
        train_dir.parent / filename,
        train_dir / filename,
    ]
    for c in candidates:
        try:
            if c and c.is_file():
                return c
        except OSError:
            continue
    return None


def object_points(obj):
    pts = []
    poly = obj.find("polygon")
    if poly is not None:
        i = 1
        while poly.findtext(f"x{i}") is not None and poly.findtext(f"y{i}") is not None:
            pts.append([float(poly.findtext(f"x{i}")), float(poly.findtext(f"y{i}"))])
            i += 1
    if len(pts) < 3:
        b = obj.find("bndbox")
        if b is not None:
            try:
                x1, y1 = float(b.findtext("xmin")), float(b.findtext("ymin"))
                x2, y2 = float(b.findtext("xmax")), float(b.findtext("ymax"))
                pts = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]
            except (TypeError, ValueError):
                pts = []
    return pts


def load_bank(train_dir: Path | None, refs_dir: Path | None, skip=frozenset(), ref_map=None):
    """§6.2 候选库：train XML 的 object 裁切 + 参考图裁切。类名不设任何白名单。"""
    vecs, labels = [], []
    stats = Counter()
    ref_map = ref_map or {}

    if train_dir and train_dir.is_dir():
        for xml in sorted(train_dir.glob("*.xml")):
            if xml.stem in skip:
                continue
            try:
                root = ET.parse(xml).getroot()
            except ET.ParseError:
                stats["bad-xml"] += 1
                continue
            img_path = resolve_train_image(root, xml, train_dir)
            if img_path is None:
                stats["missing-image"] += 1
                continue
            img = imread(img_path)
            if img is None:
                stats["unreadable-image"] += 1
                continue
            objs = root.findall("object")
            if not objs:
                cand = detect_card(img)
                if cand is None:
                    continue
                x1, y1, x2, y2 = cand[1]
                v = feature(img[y1:y2, x1:x2])
                if v is not None:
                    vecs.append(v)
                    labels.append(CROP)
                    stats[CROP] += 1
                continue
            for obj in objs:
                name = (obj.findtext("name") or "").strip()
                if not name or name == CROP:
                    stats["empty-class"] += 1
                    continue
                pts = object_points(obj)
                if len(pts) < 3:
                    stats["no-polygon"] += 1
                    continue
                xs = [p[0] for p in pts]
                ys = [p[1] for p in pts]
                x1, y1 = max(0, int(min(xs))), max(0, int(min(ys)))
                x2, y2 = min(img.shape[1], int(max(xs))), min(img.shape[0], int(max(ys)))
                if x2 - x1 < 4 or y2 - y1 < 4:
                    stats["tiny"] += 1
                    continue
                v = feature(img[y1:y2, x1:x2])
                if v is not None:
                    vecs.append(v)
                    labels.append(name)
                    stats[name] += 1

    if refs_dir and refs_dir.is_dir():
        for sub in sorted(p for p in refs_dir.iterdir() if p.is_dir()):
            raw = sub.name
            base = norm_ref_name(raw)
            cls = ref_map.get(raw)
            if cls is None:
                # 兜底：类名完全来自目录名，不查任何内置物种表
                ref_map[raw] = CROP if any(k in (raw + base).lower() for k in CROP_DIRS) else (base or raw)
                cls = ref_map[raw]
            for path in sorted(p for p in sub.iterdir() if p.suffix.lower() in IMG_EXT):
                img = imread(path)
                if img is None:
                    stats["unreadable-image"] += 1
                    continue
                if cls == CROP:
                    cand = detect_card(img)
                    crop = img[cand[1][1] : cand[1][3], cand[1][0] : cand[1][2]] if cand else plant_crop(img)
                else:
                    crop = plant_crop(img)
                v = feature(crop)
                if v is not None:
                    vecs.append(v)
                    labels.append(cls)
                    stats[f"ref:{cls}"] += 1

    if not vecs:
        return None, None, stats
    return np.vstack(vecs).astype(np.float32), labels, stats


def classify(vec, bank, labels):
    """§6.2 margin = top1 - top2（同类取最大相似度）。"""
    if bank is None or vec is None or len(bank) == 0:
        return None, 0.0, {}
    sims = bank @ vec
    by_class = defaultdict(float)
    for s, label in zip(sims, labels):
        s = float(s)
        if s > by_class[label]:
            by_class[label] = s
    ranked = sorted(by_class.items(), key=lambda kv: kv[1], reverse=True)
    best_cls, best = ranked[0]
    second = ranked[1][1] if len(ranked) > 1 else 0.0
    return best_cls, float(best - second), {k: round(float(v), 4) for k, v in ranked[:5]}


# ---------------------------------------------------------------- 段级传播（§6.3）


def segment_pass(items):
    """相邻同段帧的加权投票；只改低置信帧的类别，不改几何。"""
    ordered = sorted(items, key=lambda r: (r["seq"], r["index"], r["file"]))
    runs, cur = [], []
    for rec in ordered:
        if not cur:
            cur = [rec]
            continue
        prev = cur[-1]
        same = (
            rec["seq"] == prev["seq"]
            and abs(rec["index"] - prev["index"]) <= 2
            and bbox_iou(rec.get("bbox"), prev.get("bbox")) >= 0.5
        )
        if same:
            cur.append(rec)
        else:
            runs.append(cur)
            cur = [rec]
    if cur:
        runs.append(cur)

    changed = 0
    for run in runs:
        if len(run) < 3:
            continue
        votes = defaultdict(float)
        for rec in run:
            # 空标注帧不参与投票（§6.3）：没有类别就不该定段的类
            if rec["empty"] or not rec["class"]:
                continue
            votes[rec["class"]] += max(rec.get("margin") or 0.0, 0.01)
        if not votes:
            continue
        total = sum(votes.values())
        winner, weight = max(votes.items(), key=lambda kv: kv[1])
        if weight / total < 0.6:
            continue
        for rec in run:
            if rec["empty"] or not rec["class"]:
                continue
            if (rec.get("margin") or 0.0) >= 0.5:
                continue  # 守卫：高置信帧以自身为准
            if rec["class"] != winner:
                rec["class"] = winner
                rec["source"] = "segment"
                changed += 1
    return changed


# ---------------------------------------------------------------- 输出（§5）


def write_xml(path: Path, filename: str, image_path: Path, cls, pts, size):
    w, h = size
    object_xml = ""
    if cls and pts:
        poly = "\n".join(
            f"      <x{i + 1}>{int(x)}</x{i + 1}><y{i + 1}>{int(y)}</y{i + 1}>"
            for i, (x, y) in enumerate(pts)
        )
        object_xml = (
            "  <object>\n"
            f"    <name>{escape(str(cls))}</name>\n"
            "    <pose>Unspecified</pose>\n"
            "    <truncated>0</truncated>\n"
            "    <difficult>0</difficult>\n"
            "    <polygon>\n"
            f"{poly}\n"
            "    </polygon>\n"
            "  </object>\n"
        )
    xml = (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        "<annotation>\n"
        "  <folder>JPEGImages</folder>\n"
        f"  <filename>{escape(str(filename))}</filename>\n"
        f"  <path>{escape(str(image_path).replace(os.sep, '/'))}</path>\n"
        "  <source><database>Unknown</database></source>\n"
        f"  <size><width>{w}</width><height>{h}</height><depth>3</depth></size>\n"
        "  <segmented>0</segmented>\n"
        f"{object_xml}"
        "</annotation>\n"
    )
    path.write_text(xml, encoding="utf-8")


def link_or_copy(src: Path, dst: Path):
    if dst.exists():
        return
    try:
        os.link(src, dst)
    except OSError:
        try:
            shutil.copy2(src, dst)
        except OSError:
            pass


def build_peek(items, images_dir: Path, out_dir: Path, conf: float, per_batch=12):
    """§5.5 不确定样本拼图，3 列 × 4 行。"""
    queue = [r for r in items if r["reason"] or r["empty"] or (r.get("margin") or 0) < conf]
    peek_dir = out_dir / "peek"
    if not queue:
        return []
    peek_dir.mkdir(parents=True, exist_ok=True)
    cols, rows, tw, th = 3, 4, 320, 240
    batches = []
    for start in range(0, len(queue), per_batch):
        part = queue[start : start + per_batch]
        canvas = np.full((rows * th, cols * tw, 3), 245, dtype=np.uint8)
        entries = []
        for j, rec in enumerate(part):
            img = imread(images_dir / rec["file"])
            if img is None:
                continue
            scale = min((tw - 10) / img.shape[1], (th - 34) / img.shape[0])
            small = cv2.resize(
                img,
                (max(1, int(img.shape[1] * scale)), max(1, int(img.shape[0] * scale))),
                interpolation=cv2.INTER_AREA,
            )
            cx, cy = (j % cols) * tw, (j // cols) * th
            ox = cx + (tw - small.shape[1]) // 2
            oy = cy + 30 + (th - 30 - small.shape[0]) // 2
            canvas[oy : oy + small.shape[0], ox : ox + small.shape[1]] = small
            cv2.rectangle(canvas, (cx, cy), (cx + tw - 1, cy + th - 1), (170, 170, 170), 1)
            cv2.putText(canvas, str(j + 1), (cx + 8, cy + 24), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 0), 2, cv2.LINE_AA)
            entries.append(
                {"no": j + 1, "file": rec["file"], "class": rec["class"],
                 "confidence": rec.get("margin") or 0, "empty": rec["empty"], "reason": rec["reason"]}
            )
        if not entries:
            continue
        bid = f"batch_{len(batches) + 1:03d}"
        cv2.imwrite(str(peek_dir / f"{bid}.jpg"), canvas, [cv2.IMWRITE_JPEG_QUALITY, 90])
        (peek_dir / f"{bid}.json").write_text(
            json.dumps({"batch": bid, "items": entries}, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        batches.append({"batch": bid, "image": str(peek_dir / f"{bid}.jpg"),
                        "json": str(peek_dir / f"{bid}.json"), "count": len(entries)})
    return batches


# ---------------------------------------------------------------- 主流程


def main():
    ap = argparse.ArgumentParser(description="杂草图片自动标注引擎")
    ap.add_argument("--images", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--refs", default="")
    ap.add_argument("--train", default="")
    ap.add_argument("--class-map", default="", help="JSON 文件：{classes:[...], folderMap:{子目录: 英文类名}}（由插件传入）")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--conf", type=float, default=0.15)
    ap.add_argument("--only", default="", help="只处理文件列表（每行一个文件名）")
    ap.add_argument("--bank-skip", default="", help="从特征库排除的 stem 列表（两折交叉验证用）")
    ap.add_argument("--no-segment", action="store_true", help="关闭段级传播（消融实验用）")
    ap.add_argument("--picker", action="store_true", help="启用标注监督的选卡判别器（实验性）")
    ap.add_argument("--quads", action="store_true", help="用四边形候选生成（实验性）")
    ap.add_argument("--exclude", default="", help="JSON: {stem: [x1,y1,x2,y2]}，重标时排除已有框、取次优候选")
    args = ap.parse_args()

    exclude = {}
    if args.exclude:
        try:
            exclude = json.loads(Path(args.exclude).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            exclude = {}

    global QUAD_MODE
    QUAD_MODE = bool(args.quads)
    images_dir = Path(args.images).resolve()
    out_dir = Path(args.out).resolve()
    refs_dir = Path(args.refs).resolve() if args.refs else None
    train_dir = Path(args.train).resolve() if args.train else None

    if not images_dir.is_dir():
        emit("error", message=f"图片目录不存在：{images_dir}")
        return 2

    skip = set()
    if args.bank_skip:
        skip = {x.strip() for x in Path(args.bank_skip).read_text(encoding="utf-8").splitlines() if x.strip()}

    emit("log", message=f"特征库构建：train={train_dir} refs={refs_dir}")
    class_map = None
    if args.class_map:
        try:
            class_map = json.loads(Path(args.class_map).read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            emit("error", message=f"--class-map 读取失败：{exc}")
            return 2
    classes, ref_map = discover_classes(train_dir, refs_dir, skip, class_map)
    if not classes:
        emit("error", message="没有发现任何类别：请提供含 <name> 的 VOC 标注，或带子目录的参考图目录")
        return 2
    emit("log", message=f"发现类别 {len(classes)} 个：{classes}")
    emit("log", message=f"参考图目录映射：{ {k: v for k, v in ref_map.items()} }")
    bank, labels, stats = load_bank(train_dir, refs_dir, skip, ref_map)
    if bank is None:
        emit("error", message="特征库为空：train 与 refs 至少一个要提供有效标注/参考图")
        return 2
    emit("log", message=f"特征库样本 {len(labels)} 条；类目 {sorted(set(labels))}；统计 {dict(stats)}")
    class_names = [c for c in classes if c in set(labels)]

    picker, picker_n = build_picker(train_dir, skip) if args.picker else (None, 0)
    emit("log", message=f"选卡判别器：{'已用标注训练' if picker else '未启用（手写打分）'}，监督对 {picker_n}")

    files = [p for p in images_dir.iterdir() if p.is_file() and p.suffix.lower() in IMG_EXT]
    files.sort(key=lambda p: (*scan_key(p.stem), p.name))
    if args.only:
        wanted = {x.strip() for x in Path(args.only).read_text(encoding="utf-8").splitlines() if x.strip()}
        files = [p for p in files if p.name in wanted]
    if args.limit:
        files = files[: args.limit]
    if not files:
        emit("error", message="没有可处理的图片")
        return 2

    for d in (out_dir / "Annotations", out_dir / "JPEGImages", out_dir / "ImageSets" / "Main"):
        d.mkdir(parents=True, exist_ok=True)

    total = len(files)
    items = []
    by_class = Counter()
    prev_by_seq = {}
    for idx, path in enumerate(files, 1):
        img = imread(path)
        seq, index = scan_key(path.stem)
        rec = {
            "file": path.name, "seq": seq, "index": index,
            "w": 640, "h": 480, "class": "", "confidence": 0.0, "margin": 0.0,
            "scores": {}, "polygon": [], "bbox": [], "empty": True,
            "source": "auto", "reason": "",
        }
        if img is not None:
            rec["h"], rec["w"] = int(img.shape[0]), int(img.shape[1])
        dest = out_dir / "JPEGImages" / path.name
        if img is not None:
            link_or_copy(path.resolve(), dest)

        pts = []
        if img is None:
            rec["reason"] = "unreadable"
        else:
            cands = candidates(img)
            # 重标：先排掉“原来那个框”，逼它换一个假设，而不是重算同一个
            old = exclude.get(path.stem)
            if old and cands:
                kept_alt = [c for c in cands if bbox_iou(c[1], old) < 0.5]
                if not kept_alt:
                    rec["reason"] = "no-alternative"
                    cands = []
                else:
                    cands = kept_alt
            if not cands:
                if not rec["reason"]:
                    rec["reason"] = "no-card"
            else:
                prev = prev_by_seq.get(seq)
                best, best_score = None, -1e9
                for contour, bbox, area in cands:
                    if picker is not None:
                        base = picker.score(candidate_features(img, contour, bbox))
                    else:
                        base = heuristic_score(img, contour, bbox, area)
                    iou_prev = bbox_iou(bbox, prev[1]) if (prev and abs(index - prev[0]) <= 2) else 0.0
                    score = base + 0.25 * iou_prev
                    if score > best_score:
                        best_score, best = score, (contour, bbox)
                contour, bbox = best
                prev_by_seq[seq] = (index, bbox)
                x1, y1, x2, y2 = bbox
                crop = img[y1:y2, x1:x2]
                if crop.size == 0:
                    rec["reason"] = "empty-crop"
                else:
                    cls, margin, scores = classify(feature(crop), bank, labels)
                    rec.update(
                        {"class": cls or "", "margin": round(margin, 4), "confidence": round(margin, 4),
                         "scores": scores, "bbox": list(bbox), "empty": False}
                    )
                    if cls == CROP or cls is None:
                        rec["class"] = ""
                        rec["empty"] = True
                        rec["reason"] = "crop" if cls == CROP else "no-class"
                    else:
                        by_class[cls] += 1
                        if margin < args.conf:
                            rec["reason"] = "low-conf"
                        pts = polygon_of(contour, bbox, rec["w"], rec["h"])
                        rec["polygon"] = pts

        write_xml(
            out_dir / "Annotations" / (path.stem + ".xml"),
            path.name,
            dest,
            None if rec["empty"] else rec["class"],
            [] if rec["empty"] else pts,
            (rec["w"], rec["h"]),
        )
        items.append(rec)
        emit("progress", done=idx, total=total, file=path.name)

    changed = segment_pass(items) if not args.no_segment else 0
    emit("log", message=f"段级传播修正 {changed} 条")
    # 段级传播改了类别后重写 XML（几何不变）
    if changed:
        for rec in items:
            if rec["source"] == "segment":
                write_xml(out_dir / "Annotations" / (Path(rec["file"]).stem + ".xml"),
                          rec["file"], out_dir / "JPEGImages" / rec["file"],
                          rec["class"], rec["polygon"], (rec["w"], rec["h"]))
        by_class = Counter(r["class"] for r in items if r["class"])

    (out_dir / "ImageSets" / "Main" / "trainval.txt").write_text(
        "\n".join(Path(p.stem).name for p in files) + "\n", encoding="utf-8"
    )

    uncertain = [r for r in items if r["reason"] or r["empty"] or (r.get("margin") or 0) < args.conf]
    batches = build_peek(items, images_dir, out_dir, args.conf)
    summary = {
        "total": total,
        "labeled": sum(1 for r in items if not r["empty"]),
        "empty": sum(1 for r in items if r["empty"]),
        "uncertain": len(uncertain),
        "segmentChanged": changed,
        "byClass": dict(sorted(by_class.items(), key=lambda kv: -kv[1])),
        "classes": class_names,
        "batches": len(batches),
        "conf": args.conf,
    }
    payload = {"schema": 1, "classes": class_names, "summary": summary,
               "items": items, "batches": batches}
    (out_dir / "review.json").write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    (out_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    flags_file = out_dir / "flags.json"
    if not flags_file.exists():
        flags_file.write_text("{}", encoding="utf-8")
    emit("done", summary=summary)
    return 0


if __name__ == "__main__":
    sys.exit(main())
