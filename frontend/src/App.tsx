import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Action,
  Draft,
  Health,
  Meeting,
  Notification,
  Participant,
  Segment,
  Task,
} from "./types";
import { api, ApiError, body, request } from "./api";
import Icon from "./Icon";
import CreateMeeting from "./CreateMeeting";
import ThemeToggle from "./ThemeToggle";
import HealthStatus from "./HealthStatus";
import Overview from "./Overview";
import SourceTag from "./SourceTag";

type View = "overview" | "meetings" | "tasks" | "notifications";
const viewTitles: Record<View, string> = {
  overview: "Обзор",
  meetings: "Встречи",
  tasks: "Поручения",
  notifications: "Напоминания",
};
function sessionValue(key: string) {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
const initialFor = (m: Meeting): Draft =>
  structuredClone({
    revision: m.revision,
    summary: m.summary,
    participants: m.participants,
    actions: m.actions,
  });
const statusText: Record<Meeting["status"], string> = {
  queued: "В очереди",
  transcribing: "Расшифровка речи",
  diarizing: "Разделение голосов",
  extracting: "Извлечение поручений",
  review_ready: "Готов к проверке",
  failed: "Ошибка обработки",
};
const sourceText = {
  audio: "Запись",
  text: "Импорт текста · без ASR",
  demo: "Вымышленные данные · готовый пример",
};
const fullDate = (v: string) =>
  new Intl.DateTimeFormat("ru-RU", { dateStyle: "long" }).format(
    new Date(`${v}T00:00:00`),
  );
const timeLabel = (ms: number) =>
  `${Math.floor(ms / 60000)
    .toString()
    .padStart(2, "0")}:${Math.floor((ms / 1000) % 60)
    .toString()
    .padStart(2, "0")}`;
const message = (e: unknown) =>
  e instanceof Error ? e.message : "Неизвестная ошибка";
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob),
    link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function App() {
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    sessionValue("hattama-meeting"),
  );
  // Only edited records are kept here. Polling never rebases a local draft's revision.
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [health, setHealth] = useState<Health | null>(null);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [view, setView] = useState<View>(() => {
    const saved = sessionValue("hattama-view");
    return saved && Object.keys(viewTitles).includes(saved)
      ? (saved as View)
      : "overview";
  });
  const [loading, setLoading] = useState(true);
  const [extrasLoading, setExtrasLoading] = useState(true);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [extraErrors, setExtraErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const [conflicts, setConflicts] = useState<Record<string, boolean>>({});
  const [showCreate, setShowCreate] = useState(false);
  const [highlight, setHighlight] = useState("");
  const audioRef = useRef<HTMLAudioElement>(null);
  const polling = useRef(false);
  const operation = useRef(false);
  const generation = useRef(0);
  const selected = meetings.find((m) => m.id === selectedId);
  const draft = selected
    ? drafts[selected.id] || initialFor(selected)
    : undefined;
  const dirty = !!(selected && drafts[selected.id]);
  const conflicted = !!(
    selected &&
    (conflicts[selected.id] || (dirty && draft?.revision !== selected.revision))
  );

  const refresh = useCallback(async () => {
    const requestGeneration = generation.current;
    try {
      const list = await api<Meeting[]>("/meetings");
      if (requestGeneration !== generation.current) return;
      setMeetings(list);
      setLoadError("");
      setSelectedId((current) =>
        current && list.some((m) => m.id === current)
          ? current
          : list[0]?.id || null,
      );
    } catch (e) {
      if (requestGeneration === generation.current) setLoadError(message(e));
    } finally {
      if (requestGeneration === generation.current) setLoading(false);
    }
  }, []);
  const refreshExtras = useCallback(async () => {
    const requestGeneration = generation.current;
    const [h, n, a] = await Promise.allSettled([
      api<Health>("/health"),
      api<Notification[]>("/notifications"),
      api<Task[]>("/actions"),
    ]);
    if (requestGeneration !== generation.current) return;
    const errors: Record<string, string> = {};
    if (h.status === "fulfilled") setHealth(h.value);
    else {
      setHealth(null);
      errors.health = message(h.reason);
    }
    if (n.status === "fulfilled") setNotifications(n.value);
    else errors.notifications = message(n.reason);
    if (a.status === "fulfilled") setTasks(a.value);
    else errors.tasks = message(a.reason);
    setExtraErrors(errors);
    setExtrasLoading(false);
  }, []);
  useEffect(() => {
    try {
      sessionStorage.setItem("hattama-view", view);
      if (selectedId) sessionStorage.setItem("hattama-meeting", selectedId);
      else sessionStorage.removeItem("hattama-meeting");
    } catch {
      /* UI navigation remains available without browser storage. */
    }
  }, [view, selectedId]);
  useEffect(() => {
    void refresh();
    void refreshExtras();
  }, [refresh, refreshExtras]);
  useEffect(() => {
    const timer = window.setInterval(async () => {
      if (polling.current || operation.current) return;
      polling.current = true;
      try {
        await refresh();
        await refreshExtras();
      } finally {
        polling.current = false;
      }
    }, 3000);
    return () => window.clearInterval(timer);
  }, [refresh, refreshExtras]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    if (Object.keys(drafts).length)
      window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [drafts]);
  const accept = (m: Meeting) => {
    generation.current += 1;
    setLoading(false);
    setMeetings((items) =>
      [m, ...items.filter((item) => item.id !== m.id)].sort((a, b) =>
        b.created_at.localeCompare(a.created_at),
      ),
    );
    setDrafts((current) => {
      const next = { ...current };
      delete next[m.id];
      return next;
    });
    setConflicts((current) => ({ ...current, [m.id]: false }));
  };
  const edit = (change: Partial<Draft>) => {
    if (!selected || !draft || busy) return;
    setNotice("");
    setDrafts((current) => ({
      ...current,
      [selected.id]: { ...draft, ...change },
    }));
  };
  const editAction = (id: string, change: Partial<Action>) =>
    edit({
      actions: draft!.actions.map((a) =>
        a.id === id ? { ...a, ...change } : a,
      ),
    });
  const editParticipant = (id: string, change: Partial<Participant>) =>
    edit({
      participants: draft!.participants.map((p) =>
        p.id === id ? { ...p, ...change } : p,
      ),
    });
  const run = async (key: string, action: () => Promise<void>) => {
    if (operation.current) return;
    generation.current += 1;
    operation.current = true;
    setBusy(key);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (e) {
      setError(message(e));
      if (
        e instanceof ApiError &&
        e.status === 409 &&
        selected &&
        ["save", "approve", "export"].includes(key)
      )
        setConflicts((c) => ({ ...c, [selected.id]: true }));
    } finally {
      operation.current = false;
      setBusy("");
    }
  };
  const save = () =>
    selected &&
    draft &&
    run("save", async () => {
      accept(await api<Meeting>(`/meetings/${selected.id}`, body(draft)));
      setNotice("Правки сохранены на сервере. Протокол требует утверждения.");
      await refreshExtras();
    });
  const blockers = draft?.actions.some(
    (a) => a.review_reasons.length > 0 || !a.title.trim() || !a.assignee.trim(),
  );
  const approve = () =>
    selected &&
    draft &&
    !dirty &&
    !blockers &&
    !conflicted &&
    run("approve", async () => {
      accept(
        await api<Meeting>(
          `/meetings/${selected.id}/approve`,
          body({ revision: selected.revision }, "POST"),
        ),
      );
      setNotice("Протокол утверждён. Можно скачать DOCX.");
      await refreshExtras();
    });
  const exportDoc = () =>
    selected?.approved &&
    !dirty &&
    !conflicted &&
    run("export", async () => {
      const response = await request(`/meetings/${selected.id}/export.docx`);
      download(await response.blob(), `Протокол-${selected.id}.docx`);
      setNotice("DOCX скачан из утверждённой версии.");
    });
  const reload = () =>
    selected &&
    run("reload", async () => {
      const latest = await api<Meeting>(`/meetings/${selected.id}`);
      // Explicit replacement, only after a visible user choice. A draft can be downloaded first.
      accept(latest);
      setNotice("Открыта актуальная серверная версия.");
    });
  const seekTo = async (s: Segment) => {
    setHighlight(s.id);
    const element = document.getElementById(`segment-${s.id}`);
    element?.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
      block: "center",
    });
    element?.focus({ preventScroll: true });
    if (
      selected?.source_mode === "audio" &&
      selected.has_audio &&
      audioRef.current
    ) {
      try {
        audioRef.current.currentTime = s.start_ms / 1000;
        await audioRef.current.play();
      } catch {
        setError(
          "Не удалось воспроизвести этот фрагмент. Попробуйте плеер или проверьте формат исходного файла.",
        );
      }
    }
  };
  const openMeeting = (id: string) => {
    setSelectedId(id);
    setView("meetings");
    setError("");
    setNotice("");
    setHighlight("");
    setLibraryOpen(false);
  };
  const openDemo = () =>
    void run("demo", async () => {
      const m = await api<Meeting>("/meetings/demo", { method: "POST" });
      accept(m);
      openMeeting(m.id);
      setLoading(false);
      await refreshExtras();
    });
  const sourceLabel = (id: string) => (
    <SourceTag meeting={meetings.find((m) => m.id === id)} />
  );
  const visibleTasks = tasks.filter(
    (a) =>
      a.approved &&
      (filter === "all" ||
        (filter === "overdue" ? a.overdue : a.status === filter)),
  );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
          </div>
          <div>
            <strong>Хаттама</strong>
            <small>ЯСНОСТЬ ПОСЛЕ ВСТРЕЧ</small>
          </div>
        </div>
        <div className="workspace-label">РАБОЧЕЕ ПРОСТРАНСТВО</div>
        <nav className="main-nav" aria-label="Основная навигация">
          {(
            [
              ["overview", "grid", "Обзор"],
              ["meetings", "file", "Встречи"],
              ["tasks", "check", "Задачи"],
              ["notifications", "bell", "Напоминания"],
            ] as const
          ).map(([v, icon, label]) => (
            <button
              key={v}
              aria-label={label}
              aria-current={view === v ? "page" : undefined}
              className={`nav-item ${view === v ? "active" : ""}`}
              onClick={() => setView(v)}
            >
              <Icon name={icon} />
              <span>{label}</span>
              {v === "notifications" &&
                notifications.length > 0 &&
                !extraErrors.notifications && (
                  <span className="nav-count">{notifications.length}</span>
                )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <Icon name="file" size={21} />
            <strong>От слов — к действиям</strong>
            <p>
              Проверьте протокол.
              <br />
              Зафиксируйте решения.
            </p>
          </div>
          <ThemeToggle />
          <div className="local-card">
            <Icon name="shield" size={18} />
            <div>
              <strong>Сервер команды</strong>
              <span>Локальная обработка</span>
            </div>
          </div>
        </div>
      </aside>
      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumb">
            <span>Рабочее пространство</span>
            <Icon name="chevron" size={13} />
            <strong>{viewTitles[view]}</strong>
          </div>
          <div className="topbar-actions">
            <HealthStatus health={health} error={extraErrors.health} />
            <button
              className="icon-button"
              aria-label="Обновить данные"
              title="Обновить данные"
              disabled={!!busy}
              onClick={() => {
                setError("");
                void refresh();
                void refreshExtras();
              }}
            >
              <Icon name="refresh" size={17} />
            </button>
            <button
              className="primary-button new-meeting-button"
              disabled={!!busy}
              onClick={() => setShowCreate(true)}
            >
              <Icon name="plus" size={17} />
              <span>Новая встреча</span>
            </button>
          </div>
        </header>
        <div className="page-content">
          {health?.details.test_mode === true && (
            <div
              className="notice-box"
              role="note"
              data-testid="ml-stub-banner"
            >
              Тестовый режим: ML имитируется заглушкой. Реальные модели не
              запускались.
            </div>
          )}
          <div className="feedback-stack">
            {(error || loadError) && (
              <div className="error-banner" role="alert">
                <Icon name="info" />
                <span>{error || loadError}</span>
                {error && (
                  <button
                    className="icon-button"
                    aria-label="Закрыть сообщение об ошибке"
                    onClick={() => setError("")}
                  >
                    <Icon name="close" size={16} />
                  </button>
                )}
              </div>
            )}
            {notice && (
              <div className="success-banner" role="status">
                <Icon name="check" />
                <span>{notice}</span>
                <button
                  className="icon-button"
                  aria-label="Закрыть уведомление"
                  onClick={() => setNotice("")}
                >
                  <Icon name="close" size={16} />
                </button>
              </div>
            )}
          </div>
          {Object.keys(drafts).length > 0 && (
            <p className="draft-banner">
              <Icon name="edit" size={16} />
              Есть несохранённые правки во встречах:{" "}
              {Object.keys(drafts).length}. Сохраните их перед закрытием
              вкладки.
            </p>
          )}
          {view === "overview" && (
            <Overview
              meetings={meetings}
              tasks={tasks}
              notifications={notifications}
              loading={loading}
              extrasLoading={extrasLoading}
              loadError={loadError}
              extraErrors={extraErrors}
              busy={!!busy}
              onCreate={() => setShowCreate(true)}
              onDemo={openDemo}
              onMeeting={openMeeting}
              onMeetings={() => {
                setView("meetings");
                setLibraryOpen(true);
              }}
              onTasks={(value) => {
                setFilter(value);
                setView("tasks");
              }}
              onNotifications={() => setView("notifications")}
            />
          )}
          {view === "meetings" && (
            <>
              <section className="welcome-row">
                <div>
                  <div className="eyebrow">ПРОТОКОЛЫ И РЕШЕНИЯ</div>
                  <h1>Встречи</h1>
                  <p>Важные слова становятся понятными поручениями.</p>
                </div>
                <div className="button-row">
                  <button
                    className="secondary-button"
                    disabled={!!busy}
                    onClick={openDemo}
                  >
                    {busy === "demo" ? "Открываем…" : "Открыть демо"}
                  </button>
                  <button
                    className="secondary-button"
                    aria-expanded={libraryOpen || !selected}
                    onClick={() => setLibraryOpen(!libraryOpen)}
                  >
                    <Icon name="file" size={17} />
                    Все встречи{" "}
                    <span className="count-badge">{meetings.length}</span>
                  </button>
                </div>
              </section>
              <section>
                {(libraryOpen || !selected) && (
                  <div className="meeting-library">
                    <div className="section-heading">
                      <h2>История встреч</h2>
                      <label className="search-box">
                        <Icon name="search" />
                        <input
                          aria-label="Поиск встреч"
                          value={query}
                          onChange={(e) => setQuery(e.target.value)}
                          placeholder="Найти встречу"
                        />
                      </label>
                    </div>
                    <div className="meeting-list">
                      {meetings
                        .filter((m) =>
                          `${m.title} ${m.participants.map((p) => p.display_name).join(" ")}`
                            .toLowerCase()
                            .includes(query.toLowerCase()),
                        )
                        .map((m) => (
                          <button
                            key={m.id}
                            className={`meeting-row ${selectedId === m.id ? "selected" : ""}`}
                            onClick={() => openMeeting(m.id)}
                          >
                            <div className="meeting-info">
                              <strong>{m.title}</strong>
                              <span>{fullDate(m.occurred_at)}</span>
                              <span>{sourceText[m.source_mode]}</span>
                              <div className="meeting-tags">
                                <span
                                  className={`status-pill ${m.status === "failed" ? "failed" : m.approved ? "approved" : "review"}`}
                                >
                                  {m.approved
                                    ? "Утверждён"
                                    : `${statusText[m.status]} · черновик`}
                                </span>
                                {drafts[m.id] && <span>Есть правки</span>}
                              </div>
                            </div>
                            <Icon name="chevron" />
                          </button>
                        ))}
                      {!meetings.length && (
                        <div className="empty-list">
                          <strong>
                            {loadError
                              ? "Список недоступен"
                              : "Пока нет встреч"}
                          </strong>
                          <p>
                            Загрузите запись или откройте подготовленный
                            демо-пример.
                          </p>
                        </div>
                      )}
                      {meetings.length > 0 &&
                        !meetings.some((m) =>
                          `${m.title} ${m.participants.map((p) => p.display_name).join(" ")}`
                            .toLowerCase()
                            .includes(query.toLowerCase()),
                        ) && (
                          <div className="empty-list">
                            <strong>Ничего не найдено</strong>
                            <p>Попробуйте другое название или имя участника.</p>
                          </div>
                        )}
                    </div>
                  </div>
                )}
                <div className="meeting-layout">
                  {selected && draft ? (
                    <article
                      className="detail-card"
                      aria-label="Протокол встречи"
                    >
                      <div className="detail-head">
                        <div className="detail-title">
                          <div className="detail-overline">
                            <Icon name="calendar" size={15} />
                            {fullDate(selected.occurred_at)}
                          </div>
                          <h3>{selected.title}</h3>
                          <div className="detail-meta">
                            <span>
                              {selected.approved ? "Утверждён" : "Черновик"}
                            </span>
                            <span>{selected.timezone}</span>
                            <span>Редакция {selected.revision}</span>
                            {dirty && (
                              <span>Правки к редакции {draft.revision}</span>
                            )}
                          </div>
                        </div>
                      </div>
                      <div
                        className="protocol-steps"
                        aria-label="Этапы работы с протоколом"
                      >
                        <span className="complete">
                          <span>1</span>Материалы встречи
                        </span>
                        <i />
                        <span
                          className={
                            selected.status === "review_ready" ? "current" : ""
                          }
                        >
                          <span>2</span>Проверка и правки
                        </span>
                        <i />
                        <span
                          className={
                            selected.approved && !dirty ? "complete" : ""
                          }
                        >
                          <span>3</span>Утверждение
                        </span>
                      </div>
                      <p
                        className={
                          selected.source_mode === "demo"
                            ? "demo-banner"
                            : "source-banner"
                        }
                      >
                        {sourceText[selected.source_mode]}
                      </p>
                      {selected.source_mode === "demo" && (
                        <p className="demo-caption">
                          Готовый пример для знакомства с интерфейсом. Модели
                          распознавания и извлечения не запускались.
                        </p>
                      )}
                      {conflicted && (
                        <div className="conflict-panel" role="alert">
                          <strong>
                            Конфликт версии: протокол изменился на сервере.
                          </strong>
                          <p>
                            Ваш черновик не перезаписан. Скачайте его, затем
                            откройте серверную версию и перенесите нужные
                            изменения вручную.
                          </p>
                          {dirty && (
                            <button
                              className="secondary-button"
                              onClick={() =>
                                download(
                                  new Blob([JSON.stringify(draft, null, 2)], {
                                    type: "application/json",
                                  }),
                                  `Черновик-${selected.id}.json`,
                                )
                              }
                            >
                              Скачать мой черновик
                            </button>
                          )}
                          <button
                            className="secondary-button"
                            disabled={!!busy}
                            onClick={() => void reload()}
                          >
                            {dirty
                              ? "Заменить мой черновик серверной версией"
                              : "Открыть серверную версию"}
                          </button>
                        </div>
                      )}
                      {selected.has_audio && (
                        <div className="audio-player">
                          <span>Исходная запись</span>
                          <audio
                            key={selected.id}
                            ref={audioRef}
                            controls
                            preload="metadata"
                            src={`/api/meetings/${selected.id}/audio`}
                            onError={() =>
                              setError(
                                "Исходная запись недоступна или формат не поддерживается браузером.",
                              )
                            }
                          />
                        </div>
                      )}
                      {selected.status === "failed" ? (
                        <div className="processing-box failed-box" role="alert">
                          <div>
                            <strong>Не удалось обработать встречу</strong>
                            <p>
                              {selected.error ||
                                "Проверьте сервер и доступность моделей."}
                            </p>
                            <p>
                              После устранения причины создайте новую встречу с
                              тем же файлом или текстом. Эта запись сохранена в
                              списке.
                            </p>
                          </div>
                        </div>
                      ) : selected.status !== "review_ready" ? (
                        <div className="processing-box" role="status">
                          <span className="spinner" />
                          <div>
                            <strong>{statusText[selected.status]}</strong>
                            <p>
                              Этап обновляется раз в 3 секунды. Процент
                              готовности сервер не сообщает.
                            </p>
                          </div>
                        </div>
                      ) : (
                        <>
                          {!!selected.warnings.length && (
                            <details className="notice-box server-warnings">
                              <summary>
                                <Icon name="info" size={16} />
                                Замечания к обработке
                                <span className="count-badge">
                                  {selected.warnings.length}
                                </span>
                                <Icon name="chevron" size={14} />
                              </summary>
                              {selected.warnings.map((w, i) => (
                                <p key={i}>{w}</p>
                              ))}
                            </details>
                          )}
                          {selected.approved && (
                            <p className="notice-box">
                              Изменение содержания и сохранение снимут
                              утверждение. Для нового DOCX понадобится повторное
                              утверждение.
                            </p>
                          )}
                          <div className="review-grid">
                            <fieldset
                              disabled={!!busy}
                              className="editor-fields"
                            >
                              <section className="editor-section">
                                <div className="editor-heading">
                                  <h4>
                                    <Icon name="file" size={18} />
                                    Краткий итог
                                  </h4>
                                  <span className="editable-label">
                                    Можно редактировать
                                  </span>
                                </div>
                                <textarea
                                  className="summary-editor"
                                  aria-label="Краткий итог встречи"
                                  value={draft.summary}
                                  onChange={(e) =>
                                    edit({ summary: e.target.value })
                                  }
                                />
                              </section>
                              <details className="editor-section participants-section">
                                <summary>
                                  <span>
                                    <Icon name="users" size={18} />
                                    Участники и голоса{" "}
                                    <span className="count-badge">
                                      {draft.participants.length}
                                    </span>
                                  </span>
                                  <Icon name="chevron" size={16} />
                                </summary>
                                <div className="editor-heading">
                                  <button
                                    className="small-add"
                                    onClick={() =>
                                      edit({
                                        participants: [
                                          ...draft.participants,
                                          {
                                            id: crypto.randomUUID(),
                                            display_name: "",
                                            speaker_id: null,
                                          },
                                        ],
                                      })
                                    }
                                  >
                                    Добавить участника
                                  </button>
                                </div>
                                <p>
                                  Сопоставьте голос с именем вручную. Разделение
                                  голосов не распознаёт личность.
                                </p>
                                {draft.participants.map((p, i) => (
                                  <div className="participant-row" key={p.id}>
                                    <label>
                                      Имя участника {i + 1}
                                      <input
                                        value={p.display_name}
                                        maxLength={200}
                                        onChange={(e) =>
                                          editParticipant(p.id, {
                                            display_name: e.target.value,
                                          })
                                        }
                                      />
                                    </label>
                                    <label>
                                      Голос участника {i + 1}
                                      <select
                                        value={p.speaker_id || ""}
                                        onChange={(e) =>
                                          editParticipant(p.id, {
                                            speaker_id: e.target.value || null,
                                          })
                                        }
                                      >
                                        <option value="">Не сопоставлен</option>
                                        {[
                                          ...new Set([
                                            ...selected.segments
                                              .filter((s) => s.speaker_id)
                                              .map((s) => s.speaker_id),
                                            ...draft.participants.flatMap(
                                              (p) =>
                                                p.speaker_id
                                                  ? [p.speaker_id]
                                                  : [],
                                            ),
                                          ]),
                                        ].map((s) => (
                                          <option
                                            key={s}
                                            disabled={draft.participants.some(
                                              (other) =>
                                                other.id !== p.id &&
                                                other.speaker_id === s,
                                            )}
                                          >
                                            {s}
                                          </option>
                                        ))}
                                      </select>
                                    </label>
                                    <button
                                      className="text-button"
                                      aria-label={`Удалить участника ${i + 1}`}
                                      onClick={() =>
                                        edit({
                                          participants:
                                            draft.participants.filter(
                                              (other) => other.id !== p.id,
                                            ),
                                        })
                                      }
                                    >
                                      <Icon name="close" size={16} />
                                    </button>
                                  </div>
                                ))}
                              </details>
                              <section className="editor-section">
                                <div className="editor-heading">
                                  <h4>
                                    <Icon name="check" size={18} />
                                    Поручения{" "}
                                    <span className="count-badge">
                                      {draft.actions.length}
                                    </span>
                                  </h4>
                                  <button
                                    className="small-add"
                                    onClick={() =>
                                      edit({
                                        actions: [
                                          ...draft.actions,
                                          {
                                            id: crypto.randomUUID(),
                                            title: "",
                                            assignee: "",
                                            due_text: "",
                                            due_date: null,
                                            evidence_segment_ids: [],
                                            review_reasons: [],
                                            status: "open",
                                          },
                                        ],
                                      })
                                    }
                                  >
                                    <Icon name="plus" size={16} />
                                    Добавить поручение
                                  </button>
                                </div>
                                <div className="action-list">
                                  {draft.actions.map((a, i) => (
                                    <div className="action-card" key={a.id}>
                                      <div className="action-card-heading">
                                        <span className="action-index">
                                          {String(i + 1).padStart(2, "0")}
                                        </span>
                                        <span>
                                          {a.review_reasons.length ||
                                          !a.title.trim() ||
                                          !a.assignee.trim()
                                            ? "Требует проверки"
                                            : "Поручение"}
                                        </span>
                                        <button
                                          className="icon-button"
                                          aria-label={`Удалить поручение ${i + 1}`}
                                          onClick={() =>
                                            edit({
                                              actions: draft.actions.filter(
                                                (other) => other.id !== a.id,
                                              ),
                                            })
                                          }
                                        >
                                          <Icon name="close" size={15} />
                                        </button>
                                      </div>
                                      <label className="task-title-label">
                                        <span className="sr-only">
                                          Поручение {i + 1}
                                        </span>
                                        <textarea
                                          aria-label={`Поручение ${i + 1}`}
                                          value={a.title}
                                          maxLength={1000}
                                          onChange={(e) =>
                                            editAction(a.id, {
                                              title: e.target.value,
                                            })
                                          }
                                        />
                                      </label>
                                      <div className="action-fields">
                                        <label>
                                          <span>Исполнитель {i + 1}</span>
                                          <input
                                            value={a.assignee}
                                            maxLength={200}
                                            placeholder="Не указан"
                                            onChange={(e) =>
                                              editAction(a.id, {
                                                assignee: e.target.value,
                                              })
                                            }
                                          />
                                        </label>
                                        <label>
                                          <span>Дата срока {i + 1}</span>
                                          <input
                                            type="date"
                                            min="1900-01-01"
                                            max="2100-12-31"
                                            value={a.due_date || ""}
                                            onChange={(e) =>
                                              editAction(a.id, {
                                                due_date:
                                                  e.target.value || null,
                                              })
                                            }
                                          />
                                        </label>
                                      </div>
                                      <label className="due-text-label">
                                        Исходный срок {i + 1}
                                        <input
                                          value={a.due_text}
                                          maxLength={300}
                                          placeholder="Не указан"
                                          onChange={(e) =>
                                            editAction(a.id, {
                                              due_text: e.target.value,
                                            })
                                          }
                                        />
                                      </label>
                                      {!a.due_date && (
                                        <p>
                                          Календарная дата не указана.
                                          Автоматических напоминаний по сроку не
                                          будет.
                                        </p>
                                      )}
                                      {a.review_reasons.length ? (
                                        <button
                                          className="review-check"
                                          onClick={() =>
                                            editAction(a.id, {
                                              review_reasons: [],
                                            })
                                          }
                                        >
                                          Подтвердить ручную проверку:{" "}
                                          {a.review_reasons.join(" · ")}
                                        </button>
                                      ) : (
                                        <p className="review-status">
                                          <Icon name="check" size={14} />
                                          Нет нерешённых причин проверки
                                        </p>
                                      )}
                                      <div className="evidence-row">
                                        <span>Источники поручения {i + 1}</span>
                                        {a.evidence_segment_ids.length ===
                                          0 && (
                                          <p>
                                            Источник не указан — поручение
                                            добавлено вручную.
                                          </p>
                                        )}
                                        {a.evidence_segment_ids.map((id) => {
                                          const s = selected.segments.find(
                                            (seg) => seg.id === id,
                                          );
                                          return s ? (
                                            <button
                                              className="evidence-chip"
                                              key={id}
                                              onClick={() => void seekTo(s)}
                                              aria-label={`Источник ${id} поручения ${i + 1}`}
                                            >
                                              {selected.source_mode === "audio"
                                                ? timeLabel(s.start_ms)
                                                : "Реплика"}{" "}
                                              ·{" "}
                                              {draft.participants.find(
                                                (p) =>
                                                  p.speaker_id === s.speaker_id,
                                              )?.display_name ||
                                                s.speaker_id ||
                                                "Говорящий не определён"}
                                              <span>«{s.text}»</span>
                                            </button>
                                          ) : (
                                            <p key={id}>
                                              Источник {id} недоступен.
                                            </p>
                                          );
                                        })}
                                      </div>
                                      <details className="source-picker">
                                        <summary>
                                          Изменить источники поручения {i + 1}
                                        </summary>
                                        {selected.segments.map((s) => (
                                          <label key={s.id}>
                                            <input
                                              type="checkbox"
                                              checked={a.evidence_segment_ids.includes(
                                                s.id,
                                              )}
                                              onChange={(e) =>
                                                editAction(a.id, {
                                                  evidence_segment_ids: e.target
                                                    .checked
                                                    ? [
                                                        ...a.evidence_segment_ids,
                                                        s.id,
                                                      ]
                                                    : a.evidence_segment_ids.filter(
                                                        (id) => id !== s.id,
                                                      ),
                                                })
                                              }
                                            />
                                            {s.speaker_id ||
                                              "Говорящий не определён"}
                                            : {s.text}
                                          </label>
                                        ))}
                                      </details>
                                    </div>
                                  ))}
                                  {!draft.actions.length && (
                                    <div className="empty-list">
                                      <strong>Поручений пока нет</strong>
                                      <p>
                                        Если договорённости есть в расшифровке,
                                        добавьте их и укажите источники.
                                      </p>
                                    </div>
                                  )}
                                </div>
                              </section>
                            </fieldset>
                            <section className="editor-section transcript-section">
                              <div className="editor-heading">
                                <h4>
                                  <Icon name="mic" size={18} />
                                  Исходные реплики
                                </h4>
                                <span className="count-badge">
                                  {selected.segments.length}
                                </span>
                              </div>
                              {selected.source_mode !== "audio" && (
                                <p>
                                  Текстовый источник без аудиотаймкодов. Нажмите
                                  на источник поручения, чтобы найти нужную
                                  реплику.
                                </p>
                              )}
                              <div className="transcript-list">
                                {selected.segments.map((s) => (
                                  <div
                                    key={s.id}
                                    id={`segment-${s.id}`}
                                    tabIndex={-1}
                                    className={`transcript-line ${highlight === s.id ? "highlighted" : ""}`}
                                  >
                                    <button
                                      className="timestamp"
                                      onClick={() => void seekTo(s)}
                                    >
                                      {selected.source_mode === "audio"
                                        ? timeLabel(s.start_ms)
                                        : "Текст"}
                                    </button>
                                    <div>
                                      <strong>
                                        {draft.participants.find(
                                          (p) => p.speaker_id === s.speaker_id,
                                        )?.display_name ||
                                          s.speaker_id ||
                                          "Говорящий не определён"}
                                      </strong>
                                      <p>{s.text}</p>
                                    </div>
                                  </div>
                                ))}
                                {!selected.segments.length && (
                                  <p className="empty-list">
                                    Исходные реплики отсутствуют.
                                  </p>
                                )}
                              </div>
                            </section>
                          </div>
                          <div className="review-bottom">
                            <div className="approval-help" role="status">
                              {dirty
                                ? "Есть несохранённые изменения. Сначала сохраните, затем утвердите."
                                : blockers
                                  ? "Перед утверждением заполните текст и исполнителей, подтвердите причины проверки."
                                  : selected.approved
                                    ? "Сохранённая версия утверждена."
                                    : "Все обязательные поля заполнены. Проверьте содержание и утвердите протокол."}
                            </div>
                            <div className="detail-footer">
                              <button
                                className="secondary-button"
                                onClick={() => void save()}
                                disabled={
                                  !dirty ||
                                  !!busy ||
                                  conflicted ||
                                  draft.participants.some(
                                    (p) => !p.display_name.trim(),
                                  )
                                }
                              >
                                {busy === "save" ? "Сохраняем…" : "Сохранить"}
                              </button>
                              <button
                                className="approve-button"
                                onClick={() => void approve()}
                                disabled={
                                  !!busy ||
                                  dirty ||
                                  conflicted ||
                                  selected.approved ||
                                  blockers
                                }
                              >
                                {busy === "approve"
                                  ? "Утверждаем…"
                                  : "Утвердить протокол"}
                              </button>
                              <button
                                className="export-button"
                                onClick={() => void exportDoc()}
                                disabled={
                                  !!busy ||
                                  dirty ||
                                  conflicted ||
                                  !selected.approved
                                }
                              >
                                <Icon name="download" />
                                Скачать DOCX
                              </button>
                            </div>
                          </div>
                        </>
                      )}
                    </article>
                  ) : (
                    <div className="detail-placeholder">
                      <strong>Выберите встречу</strong>
                      <p>Здесь появятся исходные реплики и протокол.</p>
                    </div>
                  )}
                </div>
              </section>
            </>
          )}
          {view === "tasks" && (
            <section className="secondary-page">
              <div className="eyebrow">КОНТРОЛЬ ИСПОЛНЕНИЯ</div>
              <h1>Поручения</h1>
              <p>
                Задачи из утверждённых протоколов. Просрочку рассчитывает
                сервер.
              </p>
              {extraErrors.tasks && (
                <p className="error-banner" role="alert">
                  Реестр не обновлён: {extraErrors.tasks}
                </p>
              )}
              <div className="filter-tabs" aria-label="Фильтр поручений">
                {[
                  ["all", "Все"],
                  ["open", "В работе"],
                  ["overdue", "Просрочено"],
                  ["done", "Выполнено"],
                ].map(([v, label]) => (
                  <button
                    key={v}
                    aria-pressed={filter === v}
                    className="secondary-button"
                    onClick={() => setFilter(v)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="task-board">
                {visibleTasks.map((a) => (
                  <div className="global-task" key={a.id}>
                    <button
                      className={`task-toggle ${a.status === "done" ? "checked" : ""}`}
                      disabled={
                        !!busy || !!drafts[a.meeting_id] || !!extraErrors.tasks
                      }
                      aria-label={
                        a.status === "done"
                          ? `Вернуть в работу: ${a.title}`
                          : `Завершить: ${a.title}`
                      }
                      onClick={() =>
                        void run(`task-${a.id}`, async () => {
                          await api(
                            `/actions/${a.id}`,
                            body({
                              status: a.status === "done" ? "open" : "done",
                            }),
                          );
                          await refresh();
                          await refreshExtras();
                          setNotice("Статус поручения сохранён.");
                        })
                      }
                    >
                      {a.status === "done" ? "✓" : "○"}
                    </button>
                    <div className="global-task-main">
                      <strong>{a.title}</strong>
                      <button
                        className="meeting-link"
                        onClick={() => openMeeting(a.meeting_id)}
                      >
                        {a.meeting_title}
                      </button>
                      {sourceLabel(a.meeting_id)}
                      {drafts[a.meeting_id] && (
                        <p>
                          Сначала сохраните и утвердите правки этой встречи.
                        </p>
                      )}
                    </div>
                    <span className="assignee-chip">{a.assignee}</span>
                    <span className="global-due">
                      {a.due_date
                        ? fullDate(a.due_date)
                        : a.due_text || "Срок не указан"}
                    </span>
                    <span
                      className={`task-state ${a.status === "done" ? "done" : a.overdue ? "overdue" : "open"}`}
                    >
                      {a.status === "done"
                        ? "Выполнено"
                        : a.overdue
                          ? "Просрочено"
                          : "В работе"}
                    </span>
                  </div>
                ))}
                {!visibleTasks.length && (
                  <p className="empty-list">
                    {extraErrors.tasks
                      ? "Данные недоступны"
                      : "Нет задач для этого фильтра."}
                  </p>
                )}
              </div>
            </section>
          )}
          {view === "notifications" && (
            <section className="secondary-page">
              <div className="eyebrow">НИЧЕГО НЕ УПУСТИТЬ</div>
              <h1>Напоминания</h1>
              <p>
                Локальный список по подтверждённым датам. Внешние сообщения не
                отправляются.
              </p>
              {extraErrors.notifications && (
                <p className="error-banner" role="alert">
                  Напоминания не обновлены: {extraErrors.notifications}
                </p>
              )}
              <div className="task-board">
                {notifications.map((n) => (
                  <button
                    className={`notification-row ${n.kind}`}
                    key={n.id}
                    onClick={() => openMeeting(n.meeting_id)}
                  >
                    <Icon name="clock" />
                    <div>
                      <strong>{n.title}</strong>
                      <span>
                        {n.assignee} ·{" "}
                        {n.kind === "overdue" ? "Просрочено" : "Срок скоро"}
                      </span>
                      {sourceLabel(n.meeting_id)}
                    </div>
                  </button>
                ))}
                {!notifications.length && (
                  <p className="empty-list">
                    {extraErrors.notifications
                      ? "Данные недоступны"
                      : "Нет напоминаний для открытых утверждённых задач с конкретным сроком."}
                  </p>
                )}
              </div>
            </section>
          )}
        </div>
      </main>
      {showCreate && (
        <CreateMeeting
          onClose={() => setShowCreate(false)}
          onCreated={(m) => {
            accept(m);
            openMeeting(m.id);
            setShowCreate(false);
            void refreshExtras();
          }}
        />
      )}
    </div>
  );
}
