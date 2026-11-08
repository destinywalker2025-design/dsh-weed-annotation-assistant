# 标注智能体协作协议 v2

> 本文件是**契约**。插件只实现这份契约：不规定怎么标注，只规定**结果长什么样、存在哪、怎么复核、怎么导出**。

## 0. 定位

```
人  ──说话──>  AI（决定怎么标）  ──提交──>  插件（存 + 复核 + 导出）  ──标记──>  AI（改）
```

插件**不包含任何图像算法**。标注方法由 agent 现场决定：自带脚本、视觉判定、外部模型、人工手填，都可以。
插件只认一件事：`anno_commit` 提交上来的结果是否符合本契约。

## 1. 三个目录

| 参数 | 含义 | 必需 |
|---|---|---|
| `images` | 待标注图片目录 | 是 |
| `refs` | 参考图目录：每个子目录一个类别 | 否 |
| `train` | 已有 Pascal VOC 标注目录（`<name>` 即类名） | 否 |
| `out` | 输出目录（插件创建并独占管理） | 是 |

`refs` 与 `train` 至少给一个（否则没有类名来源）；两者都给时，`train` 的 `<name>` 优先。

## 2. 类别

- 来源于：`anno_open` 的 `classes` 参数 → `train` 的 `<name>` → `refs` 子目录名（去首尾数字）。
- 目录名中文合法。命中内置中英表（`稗草1` → `barnyard_grass`）时翻译，未命中则原样使用。
- `anno_commit` 里出现未声明的类名时：**报错**，除非 `allowNewClasses: true`。
- 负样本不在类别表里：用 `empty: true` 表示"只有作物"。

## 3. 输出目录

```
<out>/
  JPEGImages/<name>           原图硬链接（失败退回复制）
  Annotations/<stem>.xml      Pascal VOC，多边形；空标注为空 XML
  ImageSets/Main/trainval.txt
  review.json                 唯一真源（见 §4）
  flags.json                  人工标记（见 §5）
  project.json                建项目的参数（images/refs/train/classes/createdAt）
```

XML 是 `review.json` 的**投影**：任何时候都可以用 `anno_commit` 重写，不存在"改了 XML 没改状态"。

## 4. review.json

```jsonc
{
  "schema": 2,
  "project": { "images": "...", "refs": "...", "train": "...", "createdAt": "..." },
  "classes": ["barnyard_grass", "..."],
  "items": {
    "image177.jpg": {
      "file": "image177.jpg",
      "class": "redroot_pigweed",
      "polygon": [[15,144],[217,161],[197,372],[0,353]],
      "bbox": [0,144,217,372],
      "empty": false,
      "confidence": 0.82,
      "method": "baseline",        // baseline | ai | human | 任意自定义
      "confirmed": false,          // 人/AI 明确确认过
      "reason": ""                 // low-conf | no-card | crop | unreadable | no-alternative
    }
  }
}
```

- `items` 用 **文件名作键**，便于增量提交与覆盖写。
- `polygon` 至少 3 点，整数，`0 ≤ x ≤ W`、`0 ≤ y ≤ H`；也可只给 `bbox`，由插件转成 4 点。
- `empty: true` 时不写 `<object>`，但**必须保留 XML**。

## 5. flags.json（人 → AI 的唯一通道）

```jsonc
{
  "image177.jpg": {
    "at": "2026-11-03T22:40:12+08:00",
    "reasons": ["wrong_class"],       // 四类，可多选
    "class": "nutgrass",              // wrong_class 时必填
    "note": "叶形是禾草",
    "state": "open"                   // open | fixed
  }
}
```

| code | 含义 | 通常谁修 |
|---|---|---|
| `wrong_class` | 类别错、框对 | AI 用 `anno_commit` 覆盖 class |
| `bad_geometry` | 框偏移/形状错 | AI 用 `anno_commit` 重提 polygon |
| `missing_object` | 该标未标 | AI 重提该图；做不到就留给人工 |
| `should_be_empty` | 该空未空 | AI 提交 `empty: true` |

## 6. 工具

| 工具 | 参数 | 返回 |
|---|---|---|
| `anno_open` | `images`,`out`,`refs?`,`train?`,`classes?`,`fresh?` | 项目摘要 + 类别表 + 待标数量 |
| `anno_worklist` | `out`,`cursor?`,`limit?=50`,`filter?` | 待处理文件清单（未标 / 被标记 / 全部） |
| `anno_commit` | `out`,`items[]`,`allowNewClasses?` | `{written, skipped[], classesAdded[]}` |
| `anno_review` | `out` | 进度 + 类别分布 + 人工标记（按四类聚合） |
| `anno_export` | `out`,`split?=true`,`zip?` | `final/` `needs_manual/` `report.json` 的路径 |
| `anno_baseline`（可选） | `out`,`limit?` | 调 `tools/baseline.py` 跑一遍，结果按 `method="baseline"` 导入 |

`anno_commit` 是**唯一写入口**：首次标注、修正、确认，都走同一条路。
每条结果都必须带 `method`，插件据此区分"机器给的"和"人确认的"。

## 7. 导出

导出目录默认 `<out>/export`，可用 `dir` 指定任意位置。**固定三个目录**：

```
<export>/
  Annotations/   只放「未被标记为错误」的图的 XML
  JPEGImages/    全部原图
  flagged/       被标记为错误的那部分原图（其 XML 不导出）
  report.json    计数 + flagged 清单 + 备注
```

铁律：

- 一张图若有 open 标记，它的 XML **绝不进入** `Annotations/`，本体只出现在 `flagged/`。
- `JPEGImages/` 始终是全集，这样 `flagged/` 里的图仍能对照原图复查。
- `split: false` 时忽略标记，全部 XML 都导出（用于"先拿一份全量"）。

`report.json` 记录 `annotated` / `flagged` / `flaggedFiles`，便于交接时核对数量。

## 8. 红线

- 插件不写任何图像处理逻辑；`tools/baseline.py` 是**可选**的批量基线，删掉它插件照常工作。
- `anno_commit` 只做校验与落盘，不做纠错、不做猜测。
- 人工标记只能由人在界面上产生（或人明确指示 AI 代填），AI 不得自行清除 `open` 状态。
- 任何覆盖写都要原子：先写临时文件再 rename。
