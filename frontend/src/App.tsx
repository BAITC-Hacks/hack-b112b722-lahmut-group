import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

type Participant = { id: string; display_name: string; speaker_id: string | null }
type Segment = { id: string; start_ms: number; end_ms: number; speaker_id: string; text: string }
type Action = { id: string; title: string; assignee: string; due_text: string; due_date: string | null; evidence_segment_ids: string[]; review_reasons: string[]; status: 'open' | 'done' }
type Meeting = { id: string; title: string; occurred_at: string; timezone: string; source_mode: 'audio' | 'text' | 'demo'; status: 'queued' | 'transcribing' | 'diarizing' | 'extracting' | 'review_ready' | 'failed'; approved: boolean; revision: number; participants: Participant[]; segments: Segment[]; summary: string; actions: Action[]; warnings: string[]; error: string | null; created_at: string; has_audio: boolean }
type Notification = { id: string; meeting_id: string; action_id: string; title: string; kind: 'due_soon' | 'overdue'; assignee: string }
type Health = { status: string; mode: string; providers: { speech: boolean; llm: boolean; diarization: boolean }; details: Record<string, unknown> }
type Draft = { summary: string; actions: Action[] }
type View = 'meetings' | 'tasks' | 'notifications'

const api = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`/api${path}`, init)
  if (!response.ok) {
    let detail = `Ошибка сервера (${response.status})`
    try { detail = (await response.json()).detail || detail } catch { /* use status */ }
    throw new Error(detail)
  }
  if (response.headers.get('content-type')?.includes('application/json')) return response.json() as Promise<T>
  return response as unknown as T
}
const json = (body: unknown) => ({ method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const dateLabel = (value: string) => { if (!value) return 'Без срока'; const d = new Date(`${value}T00:00:00`); return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' }).format(d) }
const fullDate = (value: string) => { if (!value) return 'Дата не указана'; const d = new Date(`${value}T00:00:00`); return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).format(d) }
const timeLabel = (ms: number) => `${Math.floor(ms / 60000).toString().padStart(2, '0')}:${Math.floor(ms / 1000 % 60).toString().padStart(2, '0')}`
const initialFor = (m: Meeting): Draft => ({ summary: m.summary, actions: m.actions.map(a => ({ ...a, evidence_segment_ids: [...a.evidence_segment_ids], review_reasons: [...a.review_reasons] })) })
const id = () => crypto.randomUUID()

function Icon({ name, size = 19 }: { name: string; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true as const }
  const paths: Record<string, React.ReactNode> = {
    grid: <><rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/></>,
    check: <><path d="m5 12 4 4L19 6"/><path d="M21 12a9 9 0 1 1-2.64-6.36"/></>, bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></>, plus: <><path d="M12 5v14M5 12h14"/></>, search: <><circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 4.5 4.5"/></>, download: <><path d="M12 3v12m0 0 4-4m-4 4-4-4"/><path d="M5 17v3h14v-3"/></>, play: <path d="m8 5 11 7-11 7z" fill="currentColor" stroke="none"/>, upload: <><path d="M12 16V4m0 0L8 8m4-4 4 4"/><path d="M5 16v4h14v-4"/></>, clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>, chevron: <path d="m9 18 6-6-6-6"/>, close: <><path d="m18 6-12 12M6 6l12 12"/></>, file: <><path d="M13 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10z"/><path d="M13 3v7h7M8 15h8M8 18h6"/></>, mic: <><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3m-4 0h8"/></>, users: <><path d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="10" cy="7" r="4"/><path d="M20 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></>, edit: <><path d="m15 5 4 4M4 20l4-.8L19 8a2.8 2.8 0 0 0-4-4L4 15z"/></>, arrow: <><path d="M7 17 17 7M7 7h10v10"/></>
  }
  return <svg {...common}>{paths[name] || paths.file}</svg>
}

function App() {
  const [meetings, setMeetings] = useState<Meeting[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [health, setHealth] = useState<Health | null>(null)
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [allActions, setAllActions] = useState<(Action & { meeting_id: string; meeting_title: string; approved: boolean; overdue: boolean })[]>([])
  const [view, setView] = useState<View>('meetings')
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [createMode, setCreateMode] = useState<'audio' | 'text'>('audio')
  const [title, setTitle] = useState('')
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [participantsText, setParticipantsText] = useState('')
  const [transcript, setTranscript] = useState('')
  const [audioFile, setAudioFile] = useState<File | null>(null)
  const audioRef = useRef<HTMLAudioElement>(null)

  const selected = meetings.find(m => m.id === selectedId) || null
  const draft = selected ? drafts[selected.id] || initialFor(selected) : null
  const draftDirty = selected && draft ? JSON.stringify(draft) !== JSON.stringify(initialFor(selected)) : false
  const refresh = useCallback(async () => {
    const list = await api<Meeting[]>('/meetings')
    setMeetings(list)
    setSelectedId(current => current && list.some(m => m.id === current) ? current : list[0]?.id || null)
    setDrafts(current => {
      const next = { ...current }
      list.forEach(m => { if (!next[m.id]) next[m.id] = initialFor(m) })
      return next
    })
  }, [])
  const refreshExtras = useCallback(async () => {
    const [h, n, a] = await Promise.allSettled([api<Health>('/health'), api<Notification[]>('/notifications'), api<typeof allActions>('/actions')])
    if (h.status === 'fulfilled') setHealth(h.value)
    if (n.status === 'fulfilled') setNotifications(n.value)
    if (a.status === 'fulfilled') setAllActions(a.value)
  }, [])
  useEffect(() => {
    refresh().catch(e => setError(`Не удалось загрузить встречи: ${e.message}`))
    refreshExtras()
  }, [refresh, refreshExtras])
  useEffect(() => {
    const timer = window.setInterval(() => {
      const running = meetings.filter(m => ['queued', 'transcribing', 'diarizing', 'extracting'].includes(m.status))
      running.forEach(async m => {
        try {
          const updated = await api<Meeting>(`/meetings/${m.id}`)
          setMeetings(items => items.map(item => item.id === updated.id ? updated : item))
          setDrafts(current => current[updated.id] ? current : { ...current, [updated.id]: initialFor(updated) })
        } catch (e) { setError(`Не удалось обновить обработку: ${(e as Error).message}`) }
      })
    }, 2200)
    return () => window.clearInterval(timer)
  }, [meetings])
  useEffect(() => { refreshExtras() }, [meetings, refreshExtras])

  const filtered = useMemo(() => meetings.filter(m => `${m.title} ${m.participants.map(p => p.display_name).join(' ')}`.toLowerCase().includes(query.toLowerCase())), [meetings, query])
  const setAction = (actionId: string, change: Partial<Action>) => {
    if (!selected || !draft) return
    setDrafts(current => ({ ...current, [selected.id]: { ...draft, actions: draft.actions.map(a => a.id === actionId ? { ...a, ...change } : a) } }))
  }
  const setSummary = (summary: string) => { if (selected && draft) setDrafts(current => ({ ...current, [selected.id]: { ...draft, summary } })) }
  const save = async () => {
    if (!selected || !draft) return
    setBusy('save'); setError('')
    try {
      const updated = await api<Meeting>(`/meetings/${selected.id}`, json({ revision: selected.revision, summary: draft.summary, actions: draft.actions }))
      setMeetings(items => items.map(m => m.id === updated.id ? updated : m))
      setDrafts(current => ({ ...current, [updated.id]: initialFor(updated) }))
    } catch (e) { setError(`Не удалось сохранить изменения: ${(e as Error).message}`) }
    finally { setBusy('') }
  }
  const approve = async () => {
    if (!selected || draftDirty || draft?.actions.some(a => a.review_reasons.length || !a.title.trim() || !a.assignee.trim())) return
    setBusy('approve'); setError('')
    try {
      const updated = await api<Meeting>(`/meetings/${selected.id}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: selected.revision }) })
      setMeetings(items => items.map(m => m.id === updated.id ? updated : m)); setDrafts(current => ({ ...current, [updated.id]: initialFor(updated) }))
    } catch (e) { setError(`Не удалось утвердить протокол: ${(e as Error).message}`) }
    finally { setBusy(''); refreshExtras() }
  }
  const exportDoc = async () => {
    if (!selected?.approved) return
    setBusy('export'); setError('')
    try {
      const response = await fetch(`/api/meetings/${selected.id}/export.docx`)
      if (!response.ok) { const d = await response.json(); throw new Error(d.detail || `Ошибка сервера (${response.status})`) }
      const blob = await response.blob(); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `${selected.title.replace(/[^\p{L}\p{N}-]+/gu, '_')}.docx`; link.click(); URL.revokeObjectURL(url)
    } catch (e) { setError(`Не удалось скачать DOCX: ${(e as Error).message}`) }
    finally { setBusy('') }
  }
  const markTask = async (actionId: string, status: 'open' | 'done') => {
    setBusy(`task-${actionId}`); setError('')
    try { await api(`/actions/${actionId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) }); await refreshExtras(); await refresh() }
    catch (e) { setError(`Не удалось обновить задачу: ${(e as Error).message}`) }
    finally { setBusy('') }
  }
  const addAction = () => {
    if (!selected || !draft) return
    const action: Action = { id: id(), title: '', assignee: '', due_text: '', due_date: null, evidence_segment_ids: [], review_reasons: [], status: 'open' }
    setDrafts(current => ({ ...current, [selected.id]: { ...draft, actions: [...draft.actions, action] } }))
  }
  const createMeeting = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy('create'); setError('')
    const participants: Participant[] = participantsText.split(/[,\n]/).map(s => s.trim()).filter(Boolean).map(display_name => ({ id: id(), display_name, speaker_id: null }))
    try {
      let meeting: Meeting
      if (createMode === 'audio') {
        if (!audioFile) throw new Error('Выберите аудиофайл')
        const body = new FormData(); body.append('file', audioFile); body.append('title', title); body.append('occurred_at', date); body.append('timezone', 'Asia/Almaty'); body.append('participants', JSON.stringify(participants))
        meeting = await api<Meeting>('/meetings/audio', { method: 'POST', body })
      } else {
        if (!transcript.trim()) throw new Error('Добавьте текст расшифровки')
        meeting = await api<Meeting>('/meetings/text', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, occurred_at: date, timezone: 'Asia/Almaty', transcript, participants }) })
      }
      setMeetings(items => [meeting, ...items]); setSelectedId(meeting.id); setDrafts(current => ({ ...current, [meeting.id]: initialFor(meeting) })); setShowCreate(false); setTitle(''); setParticipantsText(''); setTranscript(''); setAudioFile(null)
    } catch (e) { setError(`Не удалось создать встречу: ${(e as Error).message}`) }
    finally { setBusy('') }
  }
  const addDemo = async () => {
    setBusy('demo'); setError('')
    try { const meeting = await api<Meeting>('/meetings/demo', { method: 'POST' }); setMeetings(items => [meeting, ...items]); setSelectedId(meeting.id); setDrafts(current => ({ ...current, [meeting.id]: initialFor(meeting) })) }
    catch (e) { setError(`Не удалось открыть демо: ${(e as Error).message}`) }
    finally { setBusy('') }
  }
  const seekTo = (segment: Segment) => { if (!audioRef.current || !selected?.has_audio) return; audioRef.current.currentTime = segment.start_ms / 1000; void audioRef.current.play() }

  const statusText: Record<Meeting['status'], string> = { queued: 'В очереди', transcribing: 'Расшифровка', diarizing: 'Распознаём участников', extracting: 'Готовим задачи', review_ready: 'Нужна проверка', failed: 'Ошибка обработки' }
  const statusClass: Record<Meeting['status'], string> = { queued: 'queued', transcribing: 'working', diarizing: 'working', extracting: 'working', review_ready: 'review', failed: 'failed' }

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><span>Х</span><i /></div><div><strong>Хаттама</strong><small>ВСТРЕЧИ В ПОРЯДКЕ</small></div></div>
      <div className="workspace-label">РАБОЧЕЕ ПРОСТРАНСТВО</div>
      <nav className="main-nav" aria-label="Основная навигация">
        <button className={view === 'meetings' ? 'nav-item active' : 'nav-item'} onClick={() => setView('meetings')}><Icon name="grid"/>Встречи <span className="nav-count">{meetings.length}</span></button>
        <button className={view === 'tasks' ? 'nav-item active' : 'nav-item'} onClick={() => setView('tasks')}><Icon name="check"/>Задачи <span className="nav-count">{allActions.filter(a => a.status === 'open').length}</span></button>
        <button className={view === 'notifications' ? 'nav-item active' : 'nav-item'} onClick={() => setView('notifications')}><Icon name="bell"/>Напоминания {notifications.length > 0 && <span className="nav-dot"/>}</button>
      </nav>
      <div className="sidebar-bottom">
        <div className="local-card"><div className="local-icon"><Icon name="mic" size={17}/></div><div><strong>Локальная обработка</strong><span>Данные остаются на устройстве</span></div><span className={`health-dot ${health?.status === 'ok' ? 'online' : ''}`} title={health?.status === 'ok' ? 'API доступен' : 'Проверяем API'}/></div>
        <div className="profile"><div className="avatar">Б</div><div><strong>Берик</strong><span>Личное пространство</span></div><button className="more-button" aria-label="Меню профиля">···</button></div>
      </div>
    </aside>
    <main className="main-area">
      <header className="topbar"><div className="crumb">Рабочее пространство <Icon name="chevron" size={14}/> <strong>{view === 'meetings' ? 'Встречи' : view === 'tasks' ? 'Задачи' : 'Напоминания'}</strong></div><div className="top-actions"><div className="service-status"><span className={`health-dot ${health?.status === 'ok' ? 'online' : ''}`}/>{health?.status === 'ok' ? 'Сервисы доступны' : 'Проверка сервисов'}</div><button className="icon-button" title="Напоминания" onClick={() => setView('notifications')}><Icon name="bell"/>{notifications.length > 0 && <i/>}</button><div className="avatar top-avatar">Б</div></div></header>
      <div className="page-content">
        {error && <div className="error-banner"><span>{error}</span><button onClick={() => setError('')} aria-label="Закрыть"><Icon name="close" size={16}/></button></div>}
        {view === 'meetings' && <>
          <section className="welcome-row"><div><div className="eyebrow">{new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date())}</div><h1>Встречи в порядке<span className="period">.</span></h1><p>Записи, решения и следующие шаги — в одном месте.</p></div><button className="primary-button" onClick={() => setShowCreate(true)}><Icon name="plus" size={18}/>Новая встреча</button></section>
          <section className="overview-grid"><div className="overview-card"><div className="overview-icon teal"><Icon name="file"/></div><div><span>Всего встреч</span><strong>{meetings.length}</strong></div><div className="overview-foot">В вашей библиотеке</div></div><div className="overview-card"><div className="overview-icon amber"><Icon name="edit"/></div><div><span>Ждут проверки</span><strong>{meetings.filter(m => m.status === 'review_ready' && !m.approved).length}</strong></div><div className="overview-foot">Протоколы</div></div><div className="overview-card"><div className="overview-icon blue"><Icon name="check"/></div><div><span>Открытые задачи</span><strong>{allActions.filter(a => a.status === 'open').length}</strong></div><div className="overview-foot">По всем встречам</div></div></section>
          <section className="meetings-section"><div className="section-heading"><div><h2>Последние встречи</h2><span>{meetings.length ? 'Ваши недавние записи и протоколы' : 'Начните с первой записи'}</span></div><label className="search-box"><Icon name="search" size={17}/><input aria-label="Поиск встреч" value={query} onChange={e => setQuery(e.target.value)} placeholder="Найти встречу"/><kbd>⌘ K</kbd></label></div>
            <div className="meeting-layout"><div className="meeting-list">{filtered.length ? filtered.map(m => <button key={m.id} className={`meeting-row ${selectedId === m.id ? 'selected' : ''}`} onClick={() => setSelectedId(m.id)}><div className="meeting-date"><span>{new Intl.DateTimeFormat('ru-RU', { day: '2-digit' }).format(new Date(`${m.occurred_at}T00:00:00`))}</span><small>{new Intl.DateTimeFormat('ru-RU', { month: 'short' }).format(new Date(`${m.occurred_at}T00:00:00`)).replace('.', '')}</small></div><div className="meeting-info"><strong>{m.title}</strong><span><Icon name="users" size={14}/>{m.participants.length ? m.participants.map(p => p.display_name).join(', ') : 'Участники не указаны'}</span><div className="meeting-tags"><span className={`status-pill ${statusClass[m.status]}`}>{m.approved ? 'Утверждён' : statusText[m.status]}</span>{m.source_mode === 'demo' && <span className="demo-tag">Демо</span>}</div></div><Icon name="chevron" size={17}/></button>) : <div className="empty-list"><span className="empty-icon"><Icon name="file" size={22}/></span><strong>{query ? 'Ничего не найдено' : 'Пока нет встреч'}</strong><p>{query ? 'Попробуйте изменить запрос.' : 'Загрузите аудио или создайте пример, чтобы увидеть, как устроен протокол.'}</p>{!query && <button className="text-button" disabled={!!busy} onClick={addDemo}>{busy === 'demo' ? 'Загружаем…' : 'Посмотреть демо →'}</button>}</div>}</div>
              {selected ? <article className="detail-card"><div className="detail-head"><div className="detail-title"><div className="detail-overline">ПРОТОКОЛ ВСТРЕЧИ <span>·</span> {fullDate(selected.occurred_at)}</div><h3>{selected.title}</h3><div className="detail-meta"><span className={`status-pill ${statusClass[selected.status]}`}>{selected.approved ? 'Утверждён' : statusText[selected.status]}</span><span>Asia/Almaty</span><span>Редакция {selected.revision}</span></div></div>{selected.source_mode === 'demo' && <span className="demo-ribbon">Демо · вымышленные данные</span>}</div>
                {selected.has_audio && <div className="audio-player"><div className="player-symbol"><Icon name="mic" size={17}/></div><div className="player-file"><strong>Аудиозапись встречи</strong><span>Оригинальный файл · воспроизведение по фрагментам</span></div><audio ref={audioRef} controls src={`/api/meetings/${selected.id}/audio`}>Ваш браузер не поддерживает аудио.</audio></div>}
                {selected.status === 'failed' ? <div className="processing-box failed-box"><span className="processing-icon"><Icon name="close"/></span><div><strong>Не удалось обработать встречу</strong><p>{selected.error || 'Проверьте доступность локальных сервисов и попробуйте снова.'}</p></div></div> : ['queued', 'transcribing', 'diarizing', 'extracting'].includes(selected.status) ? <div className="processing-box"><span className="spinner"/><div><strong>{statusText[selected.status]}…</strong><p>Мы обновляем состояние автоматически. Черновик встречи сохранится.</p></div></div> : <>
                  {selected.warnings.length > 0 && <div className="notice-box"><strong>Обратите внимание</strong>{selected.warnings.map((w, i) => <p key={i}>{w}</p>)}</div>}
                  <div className="editor-section"><div className="editor-heading"><div><span className="section-kicker">01 / КОНТЕКСТ</span><h4>Краткий итог</h4></div><Icon name="edit" size={17}/></div><textarea className="summary-editor" aria-label="Краткий итог встречи" value={draft?.summary || ''} onChange={e => setSummary(e.target.value)} disabled={selected.approved}/></div>
                  <div className="editor-section action-editor-section"><div className="editor-heading"><div><span className="section-kicker">02 / РЕШЕНИЯ</span><h4>Следующие шаги <span className="count-badge">{draft?.actions.length || 0}</span></h4></div>{!selected.approved && <button className="small-add" onClick={addAction}><Icon name="plus" size={15}/>Добавить</button>}</div>
                    {draft?.actions.length ? <div className="action-list">{draft.actions.map((a, i) => <div className={`action-card ${a.status === 'done' ? 'action-done' : ''}`} key={a.id}><div className="action-card-head"><span className="action-number">{String(i + 1).padStart(2, '0')}</span><input className="action-title" aria-label="Задача" placeholder="Что нужно сделать?" value={a.title} onChange={e => setAction(a.id, { title: e.target.value })} disabled={selected.approved}/>{selected.approved && <span className={`task-state ${a.status}`}>{a.status === 'done' ? 'Выполнено' : 'Открыта'}</span>}</div><div className="action-fields"><label><span>ОТВЕТСТВЕННЫЙ</span><input placeholder="Имя участника" value={a.assignee} onChange={e => setAction(a.id, { assignee: e.target.value })} disabled={selected.approved}/></label><label className="due-field"><span>СРОК</span><input type="date" value={a.due_date || ''} onChange={e => setAction(a.id, { due_date: e.target.value || null, due_text: e.target.value ? dateLabel(e.target.value) : a.due_text })} disabled={selected.approved}/></label>{a.due_text && !a.due_date && <label className="due-text-field"><span>УКАЗАННЫЙ СРОК</span><input placeholder="Например, на следующей неделе" value={a.due_text} onChange={e => setAction(a.id, { due_text: e.target.value })} disabled={selected.approved}/></label>}</div>
                      {!!a.review_reasons.length && <label className="review-check"><input type="checkbox" onChange={e => { if (e.target.checked) setAction(a.id, { review_reasons: [] }) }}/><span>Проверил вручную: {a.review_reasons.join(' · ')}</span></label>}
                      {a.evidence_segment_ids.length > 0 && <div className="evidence-row"><span>ОСНОВАНИЕ</span>{a.evidence_segment_ids.map(segId => { const s = selected.segments.find(seg => seg.id === segId); return s ? <button key={segId} className="evidence-chip" onClick={() => seekTo(s)} disabled={!selected.has_audio}><Icon name="play" size={10}/>{selected.has_audio ? timeLabel(s.start_ms) : 'Фрагмент'} <span>«{s.text.slice(0, 58)}{s.text.length > 58 ? '…' : ''}»</span></button> : null })}</div>}
                    </div>)}</div> : <div className="no-actions">Решения и задачи не обнаружены. При необходимости добавьте их вручную.</div>}
                  </div>
                  {selected.segments.length > 0 && <div className="editor-section transcript-section"><div className="editor-heading"><div><span className="section-kicker">03 / ЗАПИСЬ</span><h4>Расшифровка <span className="count-badge">{selected.segments.length}</span></h4></div></div><div className="transcript-list">{selected.segments.map(s => <div key={s.id} className="transcript-line"><button className="timestamp" onClick={() => seekTo(s)} disabled={!selected.has_audio}>{selected.has_audio ? timeLabel(s.start_ms) : 'Текст'}</button><div><strong>{selected.participants.find(p => p.speaker_id === s.speaker_id)?.display_name || s.speaker_id || 'Участник'}</strong><p>{s.text}</p></div></div>)}</div></div>}
                  <div className="detail-footer">{draftDirty && <span className="unsaved-note">Есть несохранённые изменения</span>}{!selected.approved ? <div className="footer-buttons"><button className="secondary-button" onClick={save} disabled={!draftDirty || !!busy}>{busy === 'save' ? 'Сохраняем…' : 'Сохранить'}</button><button className="approve-button" onClick={approve} disabled={!!busy || draftDirty || selected.status !== 'review_ready' || draft?.actions.some(a => a.review_reasons.length || !a.title.trim() || !a.assignee.trim())}>{busy === 'approve' ? 'Утверждаем…' : 'Утвердить протокол'}</button></div> : <button className="export-button" onClick={exportDoc} disabled={!!busy}><Icon name="download" size={17}/>{busy === 'export' ? 'Готовим файл…' : 'Скачать DOCX'}</button>}</div>
                </>}</article> : <div className="detail-placeholder"><div className="placeholder-art"><div className="paper-shape"><span/><span/><span/><i/></div><div className="sparkle">✳</div></div><strong>Выберите встречу</strong><p>Здесь появится её расшифровка, решения и задачи.</p></div>}
            </div>
          </section>
        </>}
        {view === 'tasks' && <section className="secondary-page"><div className="eyebrow">В РАБОТЕ</div><h1>Задачи<span className="period">.</span></h1><p className="secondary-intro">Обязательства из утверждённых протоколов.</p><div className="task-board">{allActions.filter(a => a.approved).length ? allActions.filter(a => a.approved).map(a => <div className={`global-task ${a.status === 'done' ? 'global-done' : ''}`} key={a.id}><button className={`task-toggle ${a.status === 'done' ? 'checked' : ''}`} onClick={() => markTask(a.id, a.status === 'done' ? 'open' : 'done')} aria-label={a.status === 'done' ? 'Вернуть в работу' : 'Отметить выполненной'}>{a.status === 'done' && <Icon name="check" size={14}/>}</button><div className="global-task-main"><strong>{a.title}</strong><button className="meeting-link" onClick={() => { setView('meetings'); setSelectedId(a.meeting_id) }}>{a.meeting_title} <Icon name="arrow" size={12}/></button></div><span className="assignee-chip">{a.assignee || 'Без ответственного'}</span><span className={`global-due ${a.overdue ? 'overdue' : ''}`}><Icon name="clock" size={14}/>{a.due_date ? fullDate(a.due_date) : a.due_text || 'Без срока'}</span><span className={`task-state ${a.status}`}>{a.status === 'done' ? 'Выполнено' : 'Открыта'}</span></div>) : <div className="large-empty"><span className="empty-icon"><Icon name="check" size={23}/></span><strong>Пока нет задач</strong><p>Задачи появятся здесь после утверждения протокола встречи.</p></div>}</div></section>}
        {view === 'notifications' && <section className="secondary-page"><div className="eyebrow">СРОКИ И НАПОМИНАНИЯ</div><h1>Напоминания<span className="period">.</span></h1><p className="secondary-intro">Ближайшие сроки по открытым задачам.</p><div className="task-board">{notifications.length ? notifications.map(n => <button className="notification-row" key={n.id} onClick={() => { setView('meetings'); setSelectedId(n.meeting_id) }}><div className={`notification-icon ${n.kind}`}><Icon name="clock"/></div><div><strong>{n.title}</strong><span>{n.assignee} · {n.kind === 'overdue' ? 'Срок прошёл' : 'Срок скоро'}</span></div><Icon name="chevron" size={17}/></button>) : <div className="large-empty"><span className="empty-icon"><Icon name="bell" size={22}/></span><strong>Пока всё спокойно</strong><p>Напоминания появятся для утверждённых задач с указанным сроком.</p></div>}</div></section>}
      </div>
    </main>
    {showCreate && <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setShowCreate(false) }}><form className="create-modal" onSubmit={createMeeting}><div className="modal-head"><div><span className="section-kicker">НОВАЯ ЗАПИСЬ</span><h2>Добавить встречу</h2></div><button type="button" className="icon-button close-button" onClick={() => setShowCreate(false)} aria-label="Закрыть"><Icon name="close"/></button></div><div className="mode-tabs"><button type="button" className={createMode === 'audio' ? 'mode-tab active' : 'mode-tab'} onClick={() => setCreateMode('audio')}><Icon name="mic" size={16}/>Аудиозапись</button><button type="button" className={createMode === 'text' ? 'mode-tab active' : 'mode-tab'} onClick={() => setCreateMode('text')}><Icon name="file" size={16}/>Текст расшифровки</button></div><label className="form-label">Название встречи<input required value={title} onChange={e => setTitle(e.target.value)} placeholder="Например, Планирование проекта"/></label><div className="form-row"><label className="form-label">Дата встречи<input required type="date" value={date} onChange={e => setDate(e.target.value)}/></label><label className="form-label">Часовой пояс<input value="Asia/Almaty (UTC+5)" readOnly/></label></div><label className="form-label">Участники <span className="optional">необязательно</span><textarea value={participantsText} onChange={e => setParticipantsText(e.target.value)} placeholder="Имена через запятую или с новой строки" rows={2}/></label>{createMode === 'audio' ? <label className={`file-drop ${audioFile ? 'has-file' : ''}`}><input type="file" accept="audio/wav,audio/mpeg,audio/mp4,audio/webm,audio/ogg,audio/flac,.wav,.mp3,.m4a,.mp4,.webm,.ogg,.flac" onChange={e => setAudioFile(e.target.files?.[0] || null)}/><span className="upload-circle"><Icon name="upload"/></span><strong>{audioFile ? audioFile.name : 'Выберите аудиофайл'}</strong><span>{audioFile ? `${(audioFile.size / 1024 / 1024).toFixed(1)} МБ · готов к загрузке` : 'Перетащите сюда или нажмите для выбора'}</span><small>WAV, MP3, M4A, MP4, WebM, OGG, FLAC · до 100 МБ</small></label> : <label className="form-label transcript-input-label">Текст расшифровки<textarea required value={transcript} onChange={e => setTranscript(e.target.value)} placeholder="Вставьте готовую расшифровку…" rows={6}/><small>Это отдельный импорт текста без привязки к аудиозаписи и таймкодам.</small></label>}<div className="modal-footer"><span><span className="health-dot online"/>Обработка на этом устройстве</span><button className="primary-button" disabled={!!busy}>{busy === 'create' ? 'Добавляем…' : 'Добавить встречу'}<Icon name="arrow" size={16}/></button></div></form></div>}
  </div>
}

export default App
