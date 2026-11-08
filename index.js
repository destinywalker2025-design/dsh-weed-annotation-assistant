import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PREFIX = '/plugins/anno-agent'
const BASELINE = path.join(HERE, 'tools', 'baseline.py')
const IMG_EXT = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.webp'])

export const inject = ['webServer', 'tools']

/** 当前有活动的项目目录；侧栏按钮只在它非空时出现。持久化，重启插件后仍在。 */
const ACTIVE_FILE = path.join(os.homedir(), '.dsh', 'anno-agent-active.json')

function readActive() {
  try {
    return JSON.parse(fs.readFileSync(ACTIVE_FILE, 'utf8')).out || ''
  } catch {
    return ''
  }
}

function setActive(out) {
  activeProject = out || ''
  try {
    fs.mkdirSync(path.dirname(ACTIVE_FILE), { recursive: true })
    fs.writeFileSync(ACTIVE_FILE, JSON.stringify({ out: activeProject }, null, 2), 'utf8')
  } catch {}
}

let activeProject = readActive()

// ---------------------------------------------------------------- 基础

function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
      if (raw.length > 4_000_000) reject(new Error('请求体过大'))
    })
    req.on('end', () => {
      if (!raw.trim()) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch (e) {
        reject(new Error(`请求体不是合法 JSON：${e.message}`))
      }
    })
    req.on('error', reject)
  })
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** 原子写：先写 .tmp 再 rename，避免半截文件。 */
function writeJson(file, value) {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

function writeText(file, text) {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

function safeName(name) {
  const base = path.basename(String(name || ''))
  return base && !base.includes('..') ? base : ''
}

const escapeXml = (v) =>
  String(v).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]))

function linkOrCopy(src, dst) {
  if (fs.existsSync(dst)) return
  try {
    fs.linkSync(src, dst)
  } catch {
    fs.copyFileSync(src, dst)
  }
}

// ---------------------------------------------------------------- 项目

function projectPaths(out) {
  return {
    out,
    images: path.join(out, 'JPEGImages'),
    ann: path.join(out, 'Annotations'),
    sets: path.join(out, 'ImageSets', 'Main'),
    review: path.join(out, 'review.json'),
    flags: path.join(out, 'flags.json'),
    project: path.join(out, 'project.json'),
  }
}

function listImages(out) {
  const p = projectPaths(out)
  try {
    return fs.readdirSync(p.images).filter((f) => IMG_EXT.has(path.extname(f).toLowerCase())).sort()
  } catch {
    return []
  }
}

function loadReview(out) {
  return readJson(projectPaths(out).review, null)
}

function saveReview(out, review) {
  writeJson(projectPaths(out).review, review)
}

function loadFlags(out) {
  return readJson(projectPaths(out).flags, {})
}

function saveFlags(out, flags) {
  writeJson(projectPaths(out).flags, flags)
}

/** 把一条结果落成 VOC XML：多边形优先，其次 bbox，其次空标注。 */
function writeXml(out, item, size) {
  const p = projectPaths(out)
  const pts = Array.isArray(item.polygon) && item.polygon.length >= 3
    ? item.polygon
    : Array.isArray(item.bbox) && item.bbox.length === 4
      ? [[item.bbox[0], item.bbox[1]], [item.bbox[2], item.bbox[1]], [item.bbox[2], item.bbox[3]], [item.bbox[0], item.bbox[3]]]
      : []
  const useObject = !item.empty && item.class && pts.length >= 3
  const poly = useObject
    ? pts.map((q, i) => `      <x${i + 1}>${Math.round(q[0])}</x${i + 1}><y${i + 1}>${Math.round(q[1])}</y${i + 1}>`).join('\n')
    : ''
  const objectXml = useObject
    ? `  <object>\n    <name>${escapeXml(item.class)}</name>\n    <pose>Unspecified</pose>\n    <truncated>0</truncated>\n    <difficult>0</difficult>\n    <polygon>\n${poly}\n    </polygon>\n  </object>\n`
    : ''
  const w = (size && size.w) || item.w || 640
  const h = (size && size.h) || item.h || 480
  const xml =
    `<?xml version="1.0" encoding="utf-8"?>\n<annotation>\n  <folder>JPEGImages</folder>\n` +
    `  <filename>${escapeXml(item.file)}</filename>\n` +
    `  <path>${escapeXml(path.join(p.images, item.file).replace(/\\/g, '/'))}</path>\n` +
    `  <source><database>Unknown</database></source>\n` +
    `  <size><width>${w}</width><height>${h}</height><depth>3</depth></size>\n` +
    `  <segmented>0</segmented>\n${objectXml}</annotation>\n`
  writeText(path.join(p.ann, `${path.parse(item.file).name}.xml`), xml)
}

function summarize(review, flags) {
  const items = Object.values(review.items || {})
  const byClass = {}
  const byMethod = {}
  let labeled = 0
  let empty = 0
  for (const it of items) {
    if (it.empty) empty += 1
    else if (it.class) {
      labeled += 1
      byClass[it.class] = (byClass[it.class] || 0) + 1
    }
    const m = it.method || 'unknown'
    byMethod[m] = (byMethod[m] || 0) + 1
  }
  const open = Object.entries(flags || {}).filter(([, f]) => f.state !== 'fixed')
  return {
    total: review.total || items.length,
    labeled,
    empty,
    remaining: Math.max(0, (review.total || items.length) - items.length),
    flaggedOpen: open.length,
    byClass,
    byMethod,
    classes: review.classes || [],
  }
}

// ---------------------------------------------------------------- 类别发现
//
// 类别完全由用户给的数据决定，插件不内置任何物种名。
// 来源优先级：AI 读标签文档后给的 classMap / classes → 手工标注 XML 的 <name>
// → refs 子目录名（原样使用，不做任何中英翻译）。
//
// 用户的输入契约（缺任何一项都要向用户要）：
//   images/   待标注图片            （必需）
//   refs/     每种杂草一个子文件夹 + 一份说明标签英文名的文档（必需）
//   labeled/  用户已手工标注的数据   （可选）

const normName = (s) => String(s || '').replace(/^\d+[\s._-]*/, '').replace(/[\s._-]*\d+$/, '').trim()
const CROP_RE = /作物|crop|negative|empty|背景|non-?weed/i

function listRefDirs(refsDir) {
  if (!refsDir || !fs.existsSync(refsDir)) return []
  return fs
    .readdirSync(refsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
}

/** refs 根目录下非图片的文件＝标签说明文档（任何格式，用户随便写，AI 来读）。 */
function findLabelDocs(refsDir) {
  if (!refsDir || !fs.existsSync(refsDir)) return []
  return fs
    .readdirSync(refsDir, { withFileTypes: true })
    .filter((e) => e.isFile() && !IMG_EXT.has(path.extname(e.name).toLowerCase()))
    .map((e) => e.name)
    .sort()
}

function discoverClasses({ refsDir, labeledDir, explicit, classMap }) {
  const classes = []
  const folderMap = {}
  const add = (c) => {
    const v = String(c || '').trim()
    if (v && !classes.includes(v)) classes.push(v)
  }
  const map = {}
  for (const [k, v] of Object.entries(classMap || {})) {
    const folder = String(k || '').trim()
    const cls = String(v || '').trim()
    if (!folder || !cls) continue
    map[folder] = cls
    map[normName(folder)] = cls
    add(cls)
  }
  for (const c of explicit || []) add(c)

  if (labeledDir && fs.existsSync(labeledDir)) {
    for (const f of fs.readdirSync(labeledDir).filter((x) => x.toLowerCase().endsWith('.xml')).sort()) {
      try {
        const xml = fs.readFileSync(path.join(labeledDir, f), 'utf8')
        for (const m of xml.matchAll(/<name>([\s\S]*?)<\/name>/g)) add(m[1].trim())
      } catch {}
    }
  }

  for (const d of listRefDirs(refsDir)) {
    if (CROP_RE.test(d)) {
      folderMap[d] = ''
      continue
    }
    const cls = map[d] || map[normName(d)] || normName(d) || d
    folderMap[d] = cls
    add(cls)
  }
  return { classes, folderMap }
}

// ---------------------------------------------------------------- Python（仅可选基线）

let pyCache = null

function resolvePython() {
  if (pyCache) return pyCache
  const cands = [
    process.env.ANNO_PYTHON,
    process.env.CONDA_PREFIX ? path.join(process.env.CONDA_PREFIX, 'python.exe') : '',
    'python',
    'python3',
  ].filter(Boolean)
  for (const cmd of cands) {
    if (path.isAbsolute(cmd) && !fs.existsSync(cmd)) continue
    try {
      const r = spawnSync(cmd, ['-c', 'import cv2,numpy'], { timeout: 20_000, windowsHide: true })
      if (r.status === 0) {
        pyCache = { command: cmd, prefix: [] }
        return pyCache
      }
    } catch {}
  }
  pyCache = { command: 'python', prefix: [] }
  return pyCache
}

// ---------------------------------------------------------------- 插件

export function apply(ctx) {
  // -------- 核心：写入口

  function commitItems(out, rawItems, allowNewClasses) {
    const review = loadReview(out)
    if (!review) throw new Error(`${out} 不是标注项目（缺 review.json），先调 anno_open`)
    const names = new Set(listImages(out))
    const classes = review.classes || []
    const added = []
    const skipped = []
    let written = 0

    for (const raw of rawItems || []) {
      const file = safeName(raw.file)
      if (!file || !names.has(file)) {
        skipped.push({ file: raw.file, why: 'not-in-project' })
        continue
      }
      const empty = raw.empty === true
      const prev = review.items[file]
      // 只改框时沿用原类别；只改类别时沿用原几何
      const cls = String(raw.class || '').trim() || (prev && !prev.empty ? (prev.class || '') : '')

      if (!empty) {
        if (!cls) {
          skipped.push({ file, why: 'missing-class' })
          continue
        }
        if (!classes.includes(cls)) {
          if (!allowNewClasses) {
            skipped.push({ file, why: `unknown-class:${cls}` })
            continue
          }
          classes.push(cls)
          added.push(cls)
        }
        const pts = Array.isArray(raw.polygon) ? raw.polygon : []
        const bbox = Array.isArray(raw.bbox) ? raw.bbox : []
        if (pts.length < 3 && bbox.length !== 4) {
          const reusable = prev && !prev.empty &&
            (((prev.polygon || []).length >= 3) || ((prev.bbox || []).length === 4))
          if (!reusable) {
            skipped.push({ file, why: 'missing-geometry' })
            continue
          }
        }
      }

      const keepGeom = !empty && (raw.polygon || []).length < 3 && (raw.bbox || []).length !== 4 && prev && !prev.empty
      const item = {
        file,
        class: empty ? '' : cls,
        polygon: empty ? [] : (keepGeom ? (prev.polygon || []) : (raw.polygon || [])),
        bbox: empty ? [] : (keepGeom ? (prev.bbox || []) : (raw.bbox || [])),
        empty,
        confidence: typeof raw.confidence === 'number' ? raw.confidence : (prev ? prev.confidence ?? null : null),
        method: String(raw.method || 'ai'),
        confirmed: raw.confirmed === true,
        reason: String(raw.reason || ''),
        at: new Date().toISOString(),
      }
      writeXml(out, item)
      review.items[file] = item
      written += 1
    }

    review.classes = classes
    saveReview(out, review)
    return { written, skipped, classesAdded: added }
  }

  // -------- 导出

  /**
   * 导出三个目录（契约见 docs/SPEC.md §7）：
   *   Annotations/  只放「未被标记为错误」的 XML
   *   JPEGImages/   全部原图
   *   flagged/      被标记为错误的那部分原图
   * 被标记的图，其 XML **绝不**进入 Annotations/。
   */
  function exportDataset(out, split, target) {
    const p = projectPaths(out)
    const review = loadReview(out)
    if (!review) throw new Error(`${out} 不是标注项目`)
    const flags = loadFlags(out)
    const openFiles = split
      ? new Set(Object.entries(flags).filter(([, f]) => f.state !== 'fixed').map(([f]) => f))
      : new Set()
    const exportRoot = target ? path.resolve(String(target)) : path.join(out, 'export')
    const annDir = path.join(exportRoot, 'Annotations')
    const imgDir = path.join(exportRoot, 'JPEGImages')
    const flaggedDir = path.join(exportRoot, 'flagged')
    fs.rmSync(exportRoot, { recursive: true, force: true })
    for (const d of [annDir, imgDir, flaggedDir]) fs.mkdirSync(d, { recursive: true })

    let annotated = 0
    let flaggedCount = 0
    const flaggedList = []
    for (const file of listImages(out)) {
      const src = path.join(p.images, file)
      linkOrCopy(src, path.join(imgDir, file)) // 全集：所有原图都进 JPEGImages
      if (openFiles.has(file)) {
        linkOrCopy(src, path.join(flaggedDir, file))
        flaggedCount += 1
        flaggedList.push(file)
        continue // 关键：被标记的图不导出 XML
      }
      const xmlSrc = path.join(p.ann, `${path.parse(file).name}.xml`)
      if (review.items[file] && fs.existsSync(xmlSrc)) {
        linkOrCopy(xmlSrc, path.join(annDir, `${path.parse(file).name}.xml`))
        annotated += 1
      }
    }

    const report = {
      ...summarize(review, flags),
      exportedAt: new Date().toISOString(),
      annotated,
      flagged: flaggedCount,
      flaggedFiles: flaggedList,
      note: 'Annotations 只含未被标记的图；被标记的图在 flagged/，且其 XML 未导出',
    }
    writeJson(path.join(exportRoot, 'report.json'), report)
    return {
      exportRoot,
      annotations: annDir,
      images: imgDir,
      flaggedDir,
      report: path.join(exportRoot, 'report.json'),
      annotated,
      flagged: flaggedCount,
    }
  }

  // -------- HTTP（给复核页用）

  const handler = async (req, res) => {
    const url = new URL(req.url || '/', 'http://dsh.local')
    const p = url.pathname
    try {
      if (req.method === 'GET' && p === `${PREFIX}/api/active`) {
        return sendJson(res, 200, { out: activeProject })
      }

      if (req.method === 'POST' && p === `${PREFIX}/api/active`) {
        const body = await readBody(req)
        setActive(body.out ? path.resolve(String(body.out)) : '')
        return sendJson(res, 200, { out: activeProject })
      }

      if (req.method === 'GET' && p === `${PREFIX}/api/stamp`) {
        const out = path.resolve(url.searchParams.get('out') || '')
        const parts = []
        for (const f of ['review.json', 'flags.json']) {
          try {
            const s = fs.statSync(path.join(out, f))
            parts.push(`${s.mtimeMs}:${s.size}`)
          } catch {
            parts.push('-')
          }
        }
        return sendJson(res, 200, { stamp: parts.join('|') })
      }

      if (req.method === 'GET' && p === `${PREFIX}/api/review`) {
        const out = path.resolve(url.searchParams.get('out') || '')
        const review = loadReview(out)
        if (!review) return sendJson(res, 404, { error: '不是标注项目：缺 review.json' })
        const flags = loadFlags(out)
        const items = Object.values(review.items || {}).map((it) => ({
          ...it,
          flagged: Boolean(flags[it.file] && flags[it.file].state !== 'fixed'),
          flag: flags[it.file] || null,
        }))
        return sendJson(res, 200, { classes: review.classes || [], items, summary: summarize(review, flags) })
      }

      if (req.method === 'POST' && p === `${PREFIX}/api/flag`) {
        const body = await readBody(req)
        const out = path.resolve(String(body.out || ''))
        const file = safeName(body.file)
        if (!loadReview(out)) return sendJson(res, 404, { error: '不是标注项目' })
        if (!file) return sendJson(res, 400, { error: '缺文件名' })
        const flags = loadFlags(out)
        const reasons = Array.isArray(body.reasons) ? body.reasons.filter(Boolean) : []
        if (!reasons.length) delete flags[file]
        else flags[file] = { at: new Date().toISOString(), reasons, class: String(body.class || ''), note: String(body.note || ''), state: 'open' }
        saveFlags(out, flags)
        return sendJson(res, 200, { ok: true })
      }

      if (req.method === 'GET' && p === `${PREFIX}/api/image`) {
        const out = path.resolve(url.searchParams.get('out') || '')
        const file = safeName(url.searchParams.get('file'))
        const base = path.join(out, 'JPEGImages')
        const target = path.join(base, file)
        if (!file || !target.startsWith(base + path.sep) || !fs.existsSync(target)) return sendJson(res, 404, { error: '图片不存在' })
        const ext = path.extname(target).toLowerCase()
        const type = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
        return fs.createReadStream(target).pipe(res)
      }

      if (req.method === 'GET' && p === `${PREFIX}/api/export`) {
        const out = path.resolve(url.searchParams.get('out') || '')
        const dir = url.searchParams.get('dir') || ''
        const { exportRoot } = exportDataset(out, true, dir)
        return sendJson(res, 200, { exportRoot })
      }

      return sendJson(res, 404, { error: 'unknown endpoint' })
    } catch (e) {
      return sendJson(res, 400, { error: String(e?.message || e) })
    }
  }

  ctx.effect(() => {
    const dispose = ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler })
    return () => dispose()
  }, 'anno-agent: http')

  // -------- 工具

  const T = (name, description, properties, required, run) => ({
    name,
    description,
    parameters: { type: 'object', properties, ...(required.length ? { required } : {}) },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] },
    execute: async (args) => run(args || {}),
  })

  const P_OUT = { type: 'string', description: '项目输出目录（anno_open 创建的那个）' }

  ctx.effect(() => {
    const disposers = [
      T(
        'anno_open',
        'Create or reopen an annotation project. Required inputs: images (folder of images to annotate) and refs (one sub-folder per weed species, plus one document naming each species\' English label). Optional: labeled (folder with the user\'s own Pascal VOC / manual labels). If a required input or the label document is missing, this tool fails with an explicit request you must relay to the user.',
        {
          images: { type: 'string', description: '待标注图片文件夹（必需）' },
          out: { type: 'string', description: '项目输出目录（必需，不存在会创建）' },
          refs: { type: 'string', description: '杂草参考文件夹（必需）：每个种类一个子文件夹 + 一份说明标签英文名的文档' },
          labeled: { type: 'string', description: '可选：用户已手工标注的数据文件夹（Pascal VOC XML）' },
          train: { type: 'string', description: 'labeled 的旧名，等价' },
          classMap: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description: '读完标签文档后给出的映射：{"子文件夹名": "english_label"}',
          },
          classes: { type: 'array', items: { type: 'string' }, description: '已确定的英文类名列表（代替 classMap）' },
          fresh: { type: 'boolean', description: 'true 清空既有结果重来' },
        },
        ['images', 'out', 'refs'],
        async (a) => {
          const imagesDir = path.resolve(String(a.images || ''))
          const out = path.resolve(String(a.out || ''))
          const refs = path.resolve(String(a.refs || ''))
          const labeled = path.resolve(String(a.labeled || a.train || ''))

          // ---- 输入契约校验：缺什么就明确要什么 ----
          if (!a.images || !fs.existsSync(imagesDir)) {
            throw new Error(`缺少「待标注图片」文件夹：请提供一个存放待标注图片的文件夹路径（参数 images）。当前值：${imagesDir || '（空）'}`)
          }
          const files = fs.readdirSync(imagesDir).filter((f) => IMG_EXT.has(path.extname(f).toLowerCase())).sort()
          if (!files.length) throw new Error(`「待标注图片」文件夹里没有图片：${imagesDir}（支持 jpg/jpeg/png/bmp/webp）`)

          if (!a.refs || !fs.existsSync(refs)) {
            throw new Error(`缺少「杂草种类参考」文件夹：请提供一个文件夹，里面每个杂草种类一个子文件夹（放该类样例图），并附一份说明各标签英文名的文档（参数 refs）。当前值：${refs || '（空）'}`)
          }
          const refDirs = listRefDirs(refs)
          const labelDocs = findLabelDocs(refs)
          if (!refDirs.length) {
            throw new Error(`参考文件夹里没有任何「种类子文件夹」：${refs}\n请把每种杂草的样例图各自放进一个子文件夹，并在这一层放一份文档说明每个子文件夹对应的英文标签名。\n当前这一层只有文件：${labelDocs.join(', ') || '（无）'}`)
          }
          if (a.labeled || a.train) {
            if (!fs.existsSync(labeled)) throw new Error(`「手工标注」文件夹不存在：${labeled}`)
          }

          const classMap = a.classMap && typeof a.classMap === 'object' ? a.classMap : {}
          const explicit = Array.isArray(a.classes) ? a.classes : []
          const discovered = discoverClasses({
            refsDir: refs,
            labeledDir: a.labeled || a.train ? labeled : '',
            explicit,
            classMap,
          })
          const classes = discovered.classes
          const folderMap = discovered.folderMap
          const providedNames = Object.keys(classMap).length > 0 || explicit.length > 0
          const nonAscii = classes.filter((c) => /[^\x00-\x7F]/.test(c))

          if (!classes.length) {
            throw new Error(`没能确定任何类别。\n参考文件夹：${refs}\n子文件夹：${refDirs.join(', ')}\n请先读标签文档（${labelDocs.join(', ') || '未找到文档'}），再用 classMap 传入 {"子文件夹名":"english_label"}。`)
          }
          if (!providedNames && nonAscii.length && labelDocs.length) {
            throw new Error(
              `发现参考子文件夹，但类名还不是英文：${nonAscii.join(', ')}\n` +
                `请先读标签文档 ${labelDocs.map((d) => path.join(refs, d)).join(', ')}，` +
                `再用 classMap 传入映射，例如 {"${refDirs[0]}":"barnyard_grass"}。`,
            )
          }
          if (!providedNames && !labelDocs.length) {
            throw new Error(
              `参考文件夹里缺少「标签说明文档」：${refs}\n` +
                `请用户在 refs 这一层放一份文档（任何格式），写明每个种类子文件夹对应的英文标签名；` +
                `或者直接把映射作为 classMap 传进来。\n子文件夹：${refDirs.join(', ')}`,
            )
          }

          const p = projectPaths(out)
          for (const d of [p.images, p.ann, p.sets]) fs.mkdirSync(d, { recursive: true })
          for (const f of files) linkOrCopy(path.join(imagesDir, f), path.join(p.images, f))

          setActive(out)

          let review = a.fresh ? null : loadReview(out)
          if (!review) {
            review = {
              schema: 2,
              project: {
                images: imagesDir,
                refs,
                labeled: a.labeled || a.train ? labeled : '',
                labelDocs: labelDocs.map((d) => path.join(refs, d)),
                classMap,
                folderMap,
                createdAt: new Date().toISOString(),
              },
              classes,
              items: {},
              total: files.length,
            }
            if (!fs.existsSync(p.flags)) saveFlags(out, {})
          } else {
            for (const c of classes) if (!review.classes.includes(c)) review.classes.push(c)
            review.total = files.length
          }
          saveReview(out, review)
          if (!fs.existsSync(p.flags)) saveFlags(out, {})
          writeJson(p.project, review.project)

          return {
            out,
            classes: review.classes,
            refFolders: refDirs,
            labelDoc: labelDocs.map((d) => path.join(refs, d)),
            images: files.length,
            labeled: Object.keys(review.items).length,
            remaining: files.length - Object.keys(review.items).length,
            next: 'anno_worklist(out, filter="unlabeled") 取要标的文件；标完用 anno_commit 提交',
          }
        },
      ),

      T(
        'anno_worklist',
        'Page through files that still need work. filter: "unlabeled" (never committed), "flagged" (human marked them wrong), "low-confidence" (sorted by confidence ascending), or "all".',
        {
          out: P_OUT,
          cursor: { type: 'number', description: 'Offset into the list; pass the previous nextCursor to continue.' },
          limit: { type: 'number', description: 'Page size, default 50.' },
          filter: { type: 'string', enum: ['unlabeled', 'flagged', 'low-confidence', 'all'], description: 'Default unlabeled.' },
          threshold: { type: 'number', description: 'For low-confidence: upper bound, default 0.15.' },
        },
        ['out'],
        async (a) => {
          const out = path.resolve(String(a.out || ''))
          const review = loadReview(out)
          if (!review) throw new Error('不是标注项目，先调 anno_open')
          const flags = loadFlags(out)
          const all = listImages(out)
          const mode = a.filter || 'unlabeled'
          const thr = Number(a.threshold) > 0 ? Number(a.threshold) : 0.15
          let pool = all
          if (mode === 'unlabeled') pool = all.filter((f) => !review.items[f])
          if (mode === 'flagged') pool = all.filter((f) => flags[f] && flags[f].state !== 'fixed')
          if (mode === 'low-confidence') {
            pool = all
              .filter((f) => {
                const it = review.items[f]
                return it && typeof it.confidence === 'number' && it.confidence < thr
              })
              .sort((x, y) => review.items[x].confidence - review.items[y].confidence)
          }
          const start = Math.max(0, Number(a.cursor) || 0)
          const limit = Math.min(500, Math.max(1, Number(a.limit) || 50))
          const page = pool.slice(start, start + limit)
          return {
            out,
            filter: mode,
            total: pool.length,
            cursor: start,
            nextCursor: start + page.length < pool.length ? start + page.length : null,
            files: page.map((f) => ({
              file: f,
              path: path.join(projectPaths(out).images, f),
              current: review.items[f] ? { class: review.items[f].class, empty: review.items[f].empty, method: review.items[f].method } : null,
              flag: flags[f] || null,
            })),
          }
        },
      ),

      T(
        'anno_commit',
        'The single write path: submit annotation results (first pass, correction or confirmation). Each item needs file + (class + polygon|bbox) or empty:true. Pass method to record where it came from.',
        {
          out: P_OUT,
          allowNewClasses: { type: 'boolean', description: 'Allow class names outside the project list.' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                file: { type: 'string' },
                class: { type: 'string' },
                polygon: { type: 'array', items: { type: 'array', items: { type: 'number' } } },
                bbox: { type: 'array', items: { type: 'number' } },
                empty: { type: 'boolean' },
                confidence: { type: 'number' },
                method: { type: 'string' },
                reason: { type: 'string' },
              },
              required: ['file'],
              additionalProperties: false,
            },
          },
        },
        ['out', 'items'],
        async (a) => {
          const out = path.resolve(String(a.out || ''))
          const flags = loadFlags(out)
          const result = commitItems(out, a.items, a.allowNewClasses === true)
          for (const it of a.items || []) {
            const f = safeName(it.file)
            if (flags[f] && flags[f].state !== 'fixed') flags[f] = { ...flags[f], state: 'fixed' }
          }
          saveFlags(out, flags)
          const review = loadReview(out)
          return { out, ...result, summary: summarize(review, flags) }
        },
      ),

      T(
        'anno_review',
        'Read progress: totals, per-class counts, per-method counts, and the open human flags grouped by reason (wrong_class / bad_geometry / missing_object / should_be_empty).',
        { out: P_OUT },
        ['out'],
        async (a) => {
          const out = path.resolve(String(a.out || ''))
          const review = loadReview(out)
          if (!review) throw new Error('不是标注项目，先调 anno_open')
          const flags = loadFlags(out)
          const grouped = { wrong_class: [], bad_geometry: [], missing_object: [], should_be_empty: [] }
          const open = []
          for (const [file, f] of Object.entries(flags)) {
            if (f.state === 'fixed') continue
            const entry = { file, class: f.class || '', note: f.note || '' }
            open.push(entry)
            for (const r of f.reasons || []) (grouped[r] ||= []).push(entry)
          }
          return { out, summary: summarize(review, flags), flagged: { total: open.length, byReason: grouped } }
        },
      ),

      T(
        'anno_export',
        'Export three folders: Annotations/ (XML only for images NOT flagged as wrong), JPEGImages/ (all originals), flagged/ (originals of flagged images, whose XML is never exported). Plus report.json. dir overrides the default <out>/export destination.',
        {
          out: P_OUT,
          split: { type: 'boolean', description: 'Default true. false = export every XML (ignore flags).' },
          dir: { type: 'string', description: 'Custom export folder (absolute). Default <out>/export.' },
        },
        ['out'],
        async (a) => {
          const out = path.resolve(String(a.out || ''))
          return { out, ...exportDataset(out, a.split !== false, a.dir || '') }
        },
      ),

      T(
        'anno_baseline',
        'OPTIONAL helper: run the bundled classic-CV baseline (tools/baseline.py) over the whole project and import its output as method="baseline". Use it when you want a cheap first pass; ignore it and commit your own results if you prefer.',
        { out: P_OUT, limit: { type: 'number', description: 'Only the first N images (0 = all).' } },
        ['out'],
        async (a) => {
          const out = path.resolve(String(a.out || ''))
          const review = loadReview(out)
          if (!review) throw new Error('不是标注项目，先调 anno_open')
          if (!fs.existsSync(BASELINE)) throw new Error('没有附带基线脚本（tools/baseline.py），请直接 anno_commit 自备结果')
          const tmp = path.join(out, '_baseline')
          fs.mkdirSync(tmp, { recursive: true })
          const py = resolvePython()
          const args = [BASELINE, '--images', projectPaths(out).images, '--out', tmp]
          if (review.project?.refs) args.push('--refs', review.project.refs)
          if (review.project?.labeled) args.push('--train', review.project.labeled)
          // 类别一律以项目为准（来自用户给的参考图 + 标签文档），基线脚本不内置任何物种
          if (Array.isArray(review.classes) && review.classes.length) {
            const mapFile = path.join(tmp, 'class-map.json')
            fs.writeFileSync(
              mapFile,
              JSON.stringify({ classes: review.classes, folderMap: review.project?.folderMap || {} }, null, 2),
              'utf8',
            )
            args.push('--class-map', mapFile)
          }
          if (Number(a.limit) > 0) args.push('--limit', String(Number(a.limit)))
          const proc = spawnSync(py.command, [...py.prefix, ...args], {
            timeout: 1_800_000, windowsHide: true, encoding: 'utf8',
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
          })
          if (proc.status !== 0) throw new Error(`基线失败：${(proc.stderr || proc.stdout || '').slice(-400)}`)
          const base = readJson(path.join(tmp, 'review.json'), null)
          if (!base) throw new Error('基线没有产出 review.json')
          const items = (base.items || []).map((it) => ({
            file: it.file,
            class: it.class,
            polygon: it.polygon,
            bbox: it.bbox,
            empty: it.empty,
            confidence: it.margin,
            method: 'baseline',
            reason: it.reason,
          }))
          const res = commitItems(out, items, true)
          try {
            fs.rmSync(tmp, { recursive: true, force: true })
          } catch {}
          const after = loadReview(out)
          return { out, imported: res.written, skipped: res.skipped.length, summary: summarize(after, loadFlags(out)) }
        },
      ),
    ]
    const offs = disposers.map((d) => ctx.tools.register(d))
    return () => {
      for (const off of offs.reverse()) off()
    }
  }, 'anno-agent: tools')
}
