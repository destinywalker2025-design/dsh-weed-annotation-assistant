window.__ModuleLoader__.load({
  id: 'dsh-anno-agent',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo } = React
    const API = '/plugins/anno-agent/api'
    const NS = 'anno-agent'

    const ZH = {
      title: '标注复核',
      subtitle: 'AI 出稿 → 人标错 → AI 修改 → 导出',
      out: '项目目录',
      exportDir: '导出目录（留空 = 项目\export）',
      load: '刷新',
      export: '导出',
      total: '总计', labeled: '已标', empty: '空标注', remaining: '未标', flagged: '待处理',
      all: '全部', onlyFlagged: '只看标记', onlyEmpty: '只看空', onlyLow: '低置信', search: '搜索文件名',
      markError: '标错', unmark: '取消', close: '关闭', save: '保存',
      wrongClass: '类别错', badGeometry: '框偏移', missingObject: '漏标', shouldBeEmpty: '该空',
      note: '备注', needClass: '选了「类别错」必须选一个不同的正确类别',
      emptyBadge: '空', noResults: '没有匹配的图片', prev: '上一页', next: '下一页',
      hint: '填项目目录后点「刷新」', exported: '已导出到', hide: '隐藏面板', hidden: '已隐藏，再次调用 anno_open 会重新出现',
      rework: '返工', reworkNone: '没有待返工的标记：先在图上点「标错」', reworkDone: '已复制返工指令，粘到对话里发给我即可',
      quick: '快速选择', quickHint: '点图打标记；换一种标记再点＝改标记；同一种标记重复点＝取消', pickClassFirst: '选了「类别错」时，先在上方选一个正确类别',
    }
    const EN = {
      title: 'Annotation review',
      subtitle: 'AI drafts → human flags → AI fixes → export',
      out: 'Project folder',
      exportDir: 'Export folder (blank = <project>\\export)',
      load: 'Refresh', export: 'Export',
      total: 'Total', labeled: 'Labeled', empty: 'Empty', remaining: 'Unlabeled', flagged: 'Pending',
      all: 'All', onlyFlagged: 'Flagged only', onlyEmpty: 'Empty only', onlyLow: 'Low confidence', search: 'Search filename',
      markError: 'Mark', unmark: 'Unmark', close: 'Close', save: 'Save',
      wrongClass: 'Wrong class', badGeometry: 'Bad box', missingObject: 'Missing', shouldBeEmpty: 'Should be empty',
      note: 'Note', needClass: 'Pick a different class when marking wrong_class',
      emptyBadge: 'EMPTY', noResults: 'No matching images', prev: 'Prev', next: 'Next',
      hint: 'Enter the project folder and click Load', exported: 'Exported to', hide: 'Hide panel', hidden: 'Hidden — call anno_open again to bring it back',
      rework: 'Rework', reworkNone: 'Nothing flagged yet', reworkDone: 'Rework request copied — paste it into the chat',
      quick: 'Quick select', quickHint: 'Click = stamp; different stamp = update; same stamp again = undo', pickClassFirst: 'Pick the correct class above when using wrong_class',
    }

    const REASONS = [
      { key: 'wrong_class', zh: '类别错', en: 'Wrong class' },
      { key: 'bad_geometry', zh: '框偏移', en: 'Bad box' },
      { key: 'missing_object', zh: '漏标', en: 'Missing' },
      { key: 'should_be_empty', zh: '该空', en: 'Should be empty' },
    ]

    const PAGE_SIZE = 24
    const C = {
      bg: 'var(--dsw-alias-bg-base, #fff)',
      layer: 'var(--dsw-alias-bg-layer-1, #fafafa)',
      layer2: 'var(--dsw-alias-bg-layer-2, #f1f1f1)',
      border: 'var(--dsw-alias-border-l1, #e5e5e5)',
      border2: 'var(--dsw-alias-border-l2, #d4d4d4)',
      text: 'var(--dsw-alias-label-primary, #111)',
      dim: 'var(--dsw-alias-label-secondary, #666)',
      brand: 'var(--dsw-alias-brand-primary, #2f6fed)',
      danger: 'var(--dsw-alias-state-error-primary, #d33)',
    }

    function Icon() {
      return h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('rect', { x: 2.5, y: 3.5, width: 19, height: 17, rx: 3 }),
        h('path', { d: 'M7 8h6M7 12h10M7 16h8' }))
    }

    async function api(p, init) {
      const res = await fetch(p, init)
      const text = await res.text()
      let data = null
      try { data = JSON.parse(text) } catch { data = { error: text } }
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`)
      return data
    }
    const post = (p, body) => api(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })

    function Btn({ children, onClick, kind, disabled, style }) {
      const base = {
        border: `1px solid ${C.border2}`, background: C.layer, color: C.text, borderRadius: 8,
        padding: '6px 12px', fontSize: 12, cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1, font: 'inherit', whiteSpace: 'nowrap',
      }
      const kinds = {
        primary: { background: C.brand, borderColor: C.brand, color: '#fff' },
        danger: { background: 'transparent', borderColor: C.danger, color: C.danger },
        ghost: { background: 'transparent', borderColor: 'transparent', color: C.dim },
      }
      return h('button', { onClick, disabled, style: { ...base, ...(kinds[kind] || {}), ...style } }, children)
    }

    function Overlay({ item }) {
      const pts = item.polygon || []
      if (pts.length < 3) return null
      return h('svg', {
        viewBox: '0 0 640 480', preserveAspectRatio: 'none',
        style: { position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', pointerEvents: 'none' },
      }, h('polygon', {
        points: pts.map((q) => `${q[0]},${q[1]}`).join(' '),
        fill: 'rgba(255,80,80,0.16)', stroke: '#ff5252', strokeWidth: 4, vectorEffect: 'non-scaling-stroke',
      }))
    }

    function Thumb({ item, out, onClick, onToggle }) {
      const src = `${API}/image?out=${encodeURIComponent(out)}&file=${encodeURIComponent(item.file)}`
      return h('div', {
        style: { border: `1px solid ${item.flagged ? C.danger : C.border}`, background: C.layer, borderRadius: 10, overflow: 'hidden', display: 'flex', flexDirection: 'column', minWidth: 0 },
      },
        h('div', { onClick: () => onClick(item), title: item.file, style: { position: 'relative', width: '100%', aspectRatio: '4 / 3', background: '#000', cursor: 'pointer' } },
          h('img', { src, alt: item.file, loading: 'lazy', style: { width: '100%', height: '100%', objectFit: 'fill', display: 'block' } }),
          h(Overlay, { item })),
        h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 6, padding: '6px 8px 0', fontSize: 11, color: C.dim } },
          h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.file),
          h('span', { style: { color: item.empty ? C.dim : C.text, fontWeight: 600, whiteSpace: 'nowrap' } }, item.empty ? 'EMPTY' : item.class)),
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 8px 8px', gap: 6 } },
          h('span', { style: { fontSize: 11, color: C.dim } }, item.method || ''),
          h(Btn, { onClick: () => onToggle(item), kind: item.flagged ? 'danger' : undefined, style: { padding: '3px 8px', fontSize: 11 } },
            item.flagged ? '取消' : '标错')))
    }

    function Modal({ item, classes, out, onClose, onSave }) {
      const [reasons, setReasons] = useState(item.flag?.reasons || [])
      const [cls, setCls] = useState(item.flag?.class || (item.empty ? '' : item.class))
      const [note, setNote] = useState(item.flag?.note || '')
      const src = `${API}/image?out=${encodeURIComponent(out)}&file=${encodeURIComponent(item.file)}`
      const toggle = (k) => setReasons((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]))
      const needsClass = reasons.includes('wrong_class') && (!cls || cls === item.class)

      return h('div', {
        onClick: (e) => { if (e.target === e.currentTarget) onClose() },
        style: { position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.82)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 },
      },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 'min(1080px, 96vw)', maxHeight: '94vh' } },
          h('div', { style: { position: 'relative', background: '#000', border: `1px solid ${C.border2}` } },
            h('img', { src, alt: item.file, style: { display: 'block', maxWidth: '100%', maxHeight: '70vh', margin: 'auto' } }),
            h(Overlay, { item })),
          h('div', { style: { background: C.layer, border: `1px solid ${C.border}`, borderRadius: 10, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 } },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' } },
              h('strong', { style: { fontSize: 13 } }, item.file),
              h('span', { style: { fontSize: 12, color: C.dim } }, item.empty ? 'EMPTY' : `${item.class} · ${item.method || ''}`)),
            h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
              REASONS.map((r) => h(Btn, { key: r.key, onClick: () => toggle(r.key), kind: reasons.includes(r.key) ? 'danger' : undefined, style: { padding: '4px 10px' } }, r.zh)),
              h('span', { style: { width: 8 } }),
              item.empty ? null : h('select', {
                value: cls, onChange: (e) => setCls(e.target.value),
                style: { border: `1px solid ${C.border2}`, background: C.layer2, color: C.text, borderRadius: 7, padding: '5px 8px', fontSize: 12 },
              }, [''].concat(classes).map((c) => h('option', { key: c || 'none', value: c }, c || '—'))),
              h('input', {
                value: note, placeholder: '备注', onChange: (e) => setNote(e.target.value),
                style: { flex: '1 1 160px', minWidth: 120, border: `1px solid ${C.border2}`, background: C.layer2, color: C.text, borderRadius: 7, padding: '5px 8px', fontSize: 12 },
              })),
            h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, alignItems: 'center' } },
              needsClass ? h('span', { style: { color: C.danger, fontSize: 11, marginRight: 'auto' } }, '选了「类别错」要选一个不同的正确类别') : null,
              h(Btn, { onClick: onClose, kind: 'ghost' }, '关闭'),
              h(Btn, { kind: 'primary', disabled: needsClass, onClick: () => onSave(item.file, reasons, cls, note) }, '保存')))))
    }

    function Page(props) {
      const { ctx } = props
      const t = (k) => {
        const loc = String(ctx.locale?.getLocale?.()?.id || 'zh').toLowerCase()
        return (loc.startsWith('zh') ? ZH : EN)[k] || k
      }
      const [out, setOut] = useState('')
      const [exportDir, setExportDir] = useState(() => {
        try { return window.localStorage.getItem('anno-agent.export') || '' } catch { return '' }
      })
      const [data, setData] = useState(null)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [busy, setBusy] = useState(false)
      const [q, setQ] = useState('')
      const [cls, setCls] = useState('')
      const [onlyFlagged, setOnlyFlagged] = useState(false)
      const [onlyEmpty, setOnlyEmpty] = useState(false)
      const [onlyLow, setOnlyLow] = useState(false)
      const [page, setPage] = useState(1)
      const [modal, setModal] = useState(null)
      const [quick, setQuick] = useState(true)
      const [quickReason, setQuickReason] = useState('bad_geometry')
      const [quickClass, setQuickClass] = useState('')

      async function load(dir) {
        const target = dir || out
        if (!target) return setError(t('hint'))
        setBusy(true); setError(''); setNotice('')
        try {
          const r = await api(`${API}/review?out=${encodeURIComponent(target)}`)
          setData(r); setOut(target); setPage(1)
          try { await post(`${API}/active`, { out: target }) } catch {}
        } catch (e) { setData(null); setError(String(e.message || e)) } finally { setBusy(false) }
      }

      async function rework() {
        const n = (data?.items || []).filter((i) => i.flagged).length
        if (!n) return setNotice(t('reworkNone'))
        const text = `返工：${out} 里有 ${n} 张标记（anno_review 后逐条修正，用完 anno_commit 提交）`
        try { await navigator.clipboard.writeText(text) } catch {}
        setNotice(`${t('reworkDone')}  ——  ${text}`)
      }

      useEffect(() => {
        const saved = window.localStorage.getItem('anno-agent.out')
        if (saved) { setOut(saved); load(saved); return }
        ;(async () => {
          try {
            const r = await (await fetch(`${API}/active`)).json()
            if (r && r.out) { setOut(r.out); load(r.out) }
          } catch {}
        })()
      }, [])

      useEffect(() => {
        if (!out) return
        let stop = false
        let last = ''
        const tick = async () => {
          try {
            const s = await (await fetch(`${API}/stamp?out=${encodeURIComponent(out)}`)).json()
            if (stop || !s || !s.stamp) return
            if (!last) { last = s.stamp; return }
            if (s.stamp === last) return
            last = s.stamp
            const r = await (await fetch(`${API}/review?out=${encodeURIComponent(out)}`)).json()
            if (!stop && r && r.items) setData(r)
          } catch {}
        }
        tick()
        const id = setInterval(tick, 3000)
        return () => { stop = true; clearInterval(id) }
      }, [out])

      // 面板已经开着时，若之后才有活动项目（agent 刚调完 anno_open），自动载入
      useEffect(() => {
        if (data) return
        const id = setInterval(async () => {
          try {
            const r = await (await fetch(`${API}/active`)).json()
            if (r && r.out && r.out !== out) { clearInterval(id); setOut(r.out); load(r.out) }
          } catch {}
        }, 2000)
        return () => clearInterval(id)
      }, [data, out])

      function remember(dir) { try { window.localStorage.setItem('anno-agent.out', dir) } catch {} }

      async function flagWith(file, reasons, klass, note, closeModal) {
        setBusy(true)
        try {
          await post(`${API}/flag`, { out, file, reasons, class: klass, note })
          remember(out)
          const r = await api(`${API}/review?out=${encodeURIComponent(out)}`)
          setData(r)
          if (closeModal) setModal(null)
        } catch (e) { setError(String(e.message || e)) } finally { setBusy(false) }
      }

      async function saveFlag(file, reasons, klass, note) {
        return flagWith(file, reasons, klass, note, true)
      }

      async function toggle(item) {
        if (!item.flagged) return setModal(item)
        return flagWith(item.file, [], '', '')
      }

      // 快速选择：换了标记就更新，同一种标记重复点才取消
      async function quickFlag(item) {
        const stamped = item.flagged
        const same =
          stamped &&
          (item.flag?.reasons || []).includes(quickReason) &&
          (quickReason !== 'wrong_class' || (item.flag?.class || '') === quickClass)
        if (same) return flagWith(item.file, [], '', '')
        if (quickReason === 'wrong_class' && !quickClass) return setNotice(t('pickClassFirst'))
        return flagWith(item.file, [quickReason], quickReason === 'wrong_class' ? quickClass : '', '')
      }

      function onThumb(item) {
        return quick ? quickFlag(item) : setModal(item)
      }

      async function doExport() {
        setBusy(true); setError(''); setNotice('')
        try {
          const q = `${API}/export?out=${encodeURIComponent(out)}${exportDir ? `&dir=${encodeURIComponent(exportDir)}` : ''}`
          const r = await api(q)
          setNotice(`${t('exported')} ${r.exportRoot}`)
        } catch (e) { setError(String(e.message || e)) } finally { setBusy(false) }
      }

      const items = data?.items || []
      const classes = data?.classes || []
      const s = data?.summary || {}
      const filtered = useMemo(() => items.filter((i) => {
        if (q && !i.file.toLowerCase().includes(q.toLowerCase())) return false
        if (cls && i.class !== cls) return false
        if (onlyFlagged && !i.flagged) return false
        if (onlyEmpty && !i.empty) return false
        if (onlyLow && !(typeof i.confidence === 'number' && i.confidence < 0.15)) return false
        return true
      }), [items, q, cls, onlyFlagged, onlyEmpty, onlyLow])
      const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
      const pageItems = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
      const chip = (active) => ({
        padding: '4px 10px', borderRadius: 999, fontSize: 12, cursor: 'pointer', font: 'inherit',
        border: `1px solid ${active ? C.brand : C.border2}`, background: active ? C.brand : 'transparent', color: active ? '#fff' : C.text,
      })

      return h('div', { style: { boxSizing: 'border-box', height: '100%', overflow: 'auto', background: C.bg, color: C.text, padding: '24px clamp(16px,4vw,40px) 48px', fontSize: 13, lineHeight: 1.55 } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 14 } },
          h('div', null,
            h('h1', { style: { margin: 0, fontSize: 20, fontWeight: 600 } }, t('title')),
            h('div', { style: { color: C.dim, fontSize: 12 } }, t('subtitle'))),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            h(Btn, { onClick: () => load(), disabled: busy }, t('load')),
            h(Btn, {
              onClick: rework,
              kind: (data?.summary?.flaggedOpen || 0) > 0 ? 'primary' : undefined,
              disabled: busy || !data,
            }, `${t('rework')}${data?.summary?.flaggedOpen ? ` ${data.summary.flaggedOpen}` : ''}`),
            h(Btn, { onClick: doExport, disabled: busy || !data }, t('export')))),

        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 } },
          h('input', {
            value: out, onChange: (e) => setOut(e.target.value), placeholder: t('out'), spellCheck: false,
            style: { width: '100%', boxSizing: 'border-box', border: `1px solid ${C.border2}`, background: C.layer2, color: C.text, borderRadius: 7, padding: '7px 10px', fontSize: 12 },
          }),
          h('input', {
            value: exportDir,
            onChange: (e) => { setExportDir(e.target.value); try { window.localStorage.setItem('anno-agent.export', e.target.value) } catch {} },
            placeholder: t('exportDir'), spellCheck: false,
            style: { width: '100%', boxSizing: 'border-box', border: `1px solid ${C.border2}`, background: C.layer2, color: C.text, borderRadius: 7, padding: '7px 10px', fontSize: 12 },
          })),

        error ? h('div', { style: { border: `1px solid ${C.danger}`, color: C.danger, borderRadius: 8, padding: '8px 11px', marginBottom: 12, fontSize: 12 } }, error) : null,
        notice ? h('div', { style: { border: `1px solid ${C.brand}`, color: C.brand, borderRadius: 8, padding: '8px 11px', marginBottom: 12, fontSize: 12 } }, notice) : null,

        data ? h('div', null,
          h('div', { style: { display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12, color: C.dim, marginBottom: 10 } },
            h('span', null, `${t('total')} ${s.total ?? 0}`),
            h('span', null, `${t('labeled')} ${s.labeled ?? 0}`),
            h('span', null, `${t('empty')} ${s.empty ?? 0}`),
            h('span', null, `${t('remaining')} ${s.remaining ?? 0}`),
            h('span', { style: { color: s.flaggedOpen ? C.danger : C.dim } }, `${t('flagged')} ${s.flaggedOpen ?? 0}`)),

          h('div', {
            style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10, padding: '8px 10px', border: `1px solid ${C.border}`, borderRadius: 9, background: C.layer },
          },
            h('label', { style: { display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12, color: quick ? C.text : C.dim, fontWeight: quick ? 600 : 400 } },
              h('input', { type: 'checkbox', checked: quick, onChange: (e) => setQuick(e.target.checked) }), t('quick')),
            h('span', { style: { width: 1, height: 16, background: C.border2 } }),
            REASONS.map((r) => h('span', {
              key: r.key,
              onClick: () => setQuickReason(r.key),
              style: {
                padding: '4px 10px', borderRadius: 999, fontSize: 12, cursor: 'pointer',
                border: `1px solid ${quickReason === r.key ? C.danger : C.border2}`,
                background: quickReason === r.key ? C.danger : 'transparent',
                color: quickReason === r.key ? '#fff' : C.text,
              },
            }, r.zh)),
            h('select', {
              value: quickClass, onChange: (e) => setQuickClass(e.target.value), title: '目标类别',
              style: {
                border: `1px solid ${quickReason === 'wrong_class' && !quickClass ? C.danger : C.border2}`,
                background: C.layer2, color: quickReason === 'wrong_class' ? C.text : C.dim,
                borderRadius: 7, padding: '4px 8px', fontSize: 12,
              },
            }, [''].concat(classes).map((c) => h('option', { key: c || 'none', value: c }, c || '— 目标类别 —'))),
            h('span', { style: { marginLeft: 'auto', fontSize: 11, color: C.dim } }, t('quickHint'))),

          h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 } },
            h('span', { style: chip(!cls), onClick: () => { setCls(''); setPage(1) } }, t('all')),
            classes.map((c) => h('span', { key: c, style: chip(cls === c), onClick: () => { setCls(cls === c ? '' : c); setPage(1) } }, `${c} ${s.byClass?.[c] || 0}`))),

          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 } },
            h('input', {
              value: q, placeholder: t('search'), onChange: (e) => { setQ(e.target.value); setPage(1) },
              style: { border: `1px solid ${C.border2}`, background: C.layer2, color: C.text, borderRadius: 7, padding: '5px 9px', fontSize: 12, width: 180 },
            }),
            h('label', { style: { display: 'inline-flex', gap: 5, alignItems: 'center', fontSize: 12, color: C.dim } },
              h('input', { type: 'checkbox', checked: onlyFlagged, onChange: (e) => { setOnlyFlagged(e.target.checked); setPage(1) } }), t('onlyFlagged')),
            h('label', { style: { display: 'inline-flex', gap: 5, alignItems: 'center', fontSize: 12, color: C.dim } },
              h('input', { type: 'checkbox', checked: onlyEmpty, onChange: (e) => { setOnlyEmpty(e.target.checked); setPage(1) } }), t('onlyEmpty')),
            h('label', { style: { display: 'inline-flex', gap: 5, alignItems: 'center', fontSize: 12, color: C.dim } },
              h('input', { type: 'checkbox', checked: onlyLow, onChange: (e) => { setOnlyLow(e.target.checked); setPage(1) } }), t('onlyLow')),
            h('span', { style: { marginLeft: 'auto', color: C.dim, fontSize: 12 } }, `${filtered.length} / ${items.length}`)),

          h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 12 } },
            pageItems.map((item) => h(Thumb, { key: item.file, item, out, onClick: onThumb, onToggle: toggle }))),

          !filtered.length ? h('div', { style: { color: C.dim, padding: 30, textAlign: 'center' } }, t('noResults')) : null,

          h('div', { style: { display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 12, marginTop: 18 } },
            h(Btn, { onClick: () => setPage(page - 1), disabled: page <= 1 }, t('prev')),
            h('span', { style: { color: C.dim, fontSize: 12 } }, `${page} / ${pages}`),
            h(Btn, { onClick: () => setPage(page + 1), disabled: page >= pages }, t('next'))))
          : h('div', { style: { color: C.dim, padding: '18px 4px', fontSize: 12 } }, t('hint')),

        modal ? h(Modal, { item: modal, classes, out, onClose: () => setModal(null), onSave: saveFlag }) : null)
    }

    function apply(ctx) {
      ctx.effect?.(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'anno-agent: locale')
      const label = () => {
        const loc = String(ctx.locale?.getLocale?.()?.id || 'zh').toLowerCase()
        return (loc.startsWith('zh') ? ZH : EN).title
      }
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: NS, locale: NS }, (p) => h(Page, { ...p, ctx })))
      // 侧栏入口常驻：默认可见，不随项目状态出现/消失
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: NS, order: 12, locale: NS, label }, Icon))
    }

    return { name: 'dsh-anno-agent', inject: ['slots', 'locale'], apply }
  },
})
