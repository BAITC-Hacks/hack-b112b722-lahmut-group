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
import TelegramPanel from "./TelegramPanel";

type View = "meetings" | "tasks" | "notifications";
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Only edited records are kept here. Polling never rebases a local draft's revision.
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [health, setHealth] = useState<Health | null>(null);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [view, setView] = useState<View>("meetings");
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
      setLoadError(message(e));
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
  }, []);
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
    element?.scrollIntoView({ behavior: "smooth", block: "center" });
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
  };
  const demoLabel = (id: string) =>
    meetings.find((m) => m.id === id)?.source_mode === "demo" ? (
      <span className="demo-tag">Вымышленные данные · готовый пример</span>
    ) : null;
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
          <div className="brand-mark">Х</div>
          <div>
            <strong>Хаттама</strong>
            <small>ВСТРЕЧИ В ПОРЯДКЕ</small>
          </div>
        </div>
        <div className="workspace-label">РАБОЧЕЕ ПРОСТРАНСТВО</div>
        <nav className="main-nav" aria-label="Основная навигация">
          {(
            [
              ["meetings", "grid", "Встречи"],
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
              {label}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-card">
            <Icon name="mic" />
            <div>
              <strong>Своя инфраструктура</strong>
              <span>Обработка на сервере команды</span>
            </div>
          </div>
        </div>
      </aside>
      <main className="main-area">
        <header className="topbar">
          <span>
            Рабочее пространство /{" "}
            {view === "meetings"
              ? "Встречи"
              : view === "tasks"
                ? "Задачи"
                : "Напоминания"}
          </span>
          <button
            className="secondary-button"
            disabled={!!busy}
            onClick={() => {
              setError("");
              void refresh();
              void refreshExtras();
            }}
          >
            Обновить данные
          </button>
        </header>
        <div className="page-content">
          {health?.details.test_mode === true && (
            <div className="notice-box" role="note" data-testid="ml-stub-banner">
              Тестовый режим: ML имитируется заглушкой. Реальные модели не запускались.
            </div>
          )}
          <details className="health-panel">
            <summary>
              {health ? "API доступен" : "API: нет подтверждения доступности"} ·
              Диагностика моделей
            </summary>
            <p>Доступность сервиса не является оценкой качества моделей.</p>
            {health && (
              <p>
                Распознавание речи:{" "}
                {health.providers.speech ? "доступно" : "не готово"} ·
                Извлечение: {health.providers.llm ? "доступно" : "не готово"} ·
                Разделение голосов:{" "}
                {health.providers.diarization ? "доступно" : "не готово"}
              </p>
            )}
            {health && <pre>{JSON.stringify(health.details, null, 2)}</pre>}
            {extraErrors.health && <p>{extraErrors.health}</p>}
          </details>
          {(error || loadError) && (
            <div className="error-banner" role="alert">
              {error || loadError}
            </div>
          )}
          {notice && (
            <p className="success-banner" role="status">
              {notice}
            </p>
          )}
          {Object.keys(drafts).length > 0 && (
            <p className="draft-banner">
              Несохранённые черновики: {Object.keys(drafts).length}. Переходы
              между экранами их сохраняют; перед закрытием вкладки сохраните
              правки на сервере.
            </p>
          )}
          {view === "meetings" && (
            <>
              <section className="welcome-row">
                <div>
                  <div className="eyebrow">ПРОВЕРЯЕМЫЙ ПРОТОКОЛ</div>
                  <h1>
                    Встречи в порядке<span className="period">.</span>
                  </h1>
                  <p>От исходной реплики до подтверждённого поручения.</p>
                </div>
                <div className="button-row">
                  <button
                    className="secondary-button"
                    disabled={!!busy}
                    onClick={() =>
                      void run("demo", async () => {
                        const m = await api<Meeting>("/meetings/demo", {
                          method: "POST",
                        });
                        accept(m);
                        openMeeting(m.id);
                        await refreshExtras();
                      })
                    }
                  >
                    {busy === "demo" ? "Открываем…" : "Открыть демо"}
                  </button>
                  <button
                    className="primary-button"
                    disabled={!!busy}
                    onClick={() => setShowCreate(true)}
                  >
                    <Icon name="plus" />
                    Новая встреча
                  </button>
                </div>
              </section>
              <p className="demo-explainer">
                Демо — вымышленные данные и готовый пример, без запуска моделей.
              </p>
              <section>
                <div className="section-heading">
                  <h2>Встречи</h2>
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
                <div className="meeting-layout">
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
                                className={`status-pill ${m.status === "failed" ? "failed" : "review"}`}
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
                          {loadError ? "Список недоступен" : "Пока нет встреч"}
                        </strong>
                        <p>
                          Загрузите запись или откройте подготовленный
                          демо-пример.
                        </p>
                      </div>
                    )}
                  </div>
                  {selected && draft ? (
                    <article
                      className="detail-card"
                      aria-label="Протокол встречи"
                    >
                      <div className="detail-head">
                        <div className="detail-title">
                          <div className="detail-overline">
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
                      <p
                        className={
                          selected.source_mode === "demo"
                            ? "demo-banner"
                            : "source-banner"
                        }
                      >
                        {sourceText[selected.source_mode]}
                      </p>
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
                            <div className="notice-box">
                              <strong>Обратите внимание</strong>
                              {selected.warnings.map((w, i) => (
                                <p key={i}>{w}</p>
                              ))}
                            </div>
                          )}
                          {selected.approved && (
                            <p className="notice-box">
                              Изменение содержания и сохранение снимут
                              утверждение. Для нового DOCX понадобится повторное
                              утверждение.
                            </p>
                          )}
                          <fieldset disabled={!!busy} className="editor-fields">
                            <section className="editor-section">
                              <div className="editor-heading">
                                <h4>1. Краткий итог</h4>
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
                            <section className="editor-section">
                              <div className="editor-heading">
                                <h4>2. Участники и голоса</h4>
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
                                          ...selected.segments.map(
                                            (s) => s.speaker_id,
                                          ),
                                          ...draft.participants.flatMap((p) =>
                                            p.speaker_id ? [p.speaker_id] : [],
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
                                    onClick={() =>
                                      edit({
                                        participants: draft.participants.filter(
                                          (other) => other.id !== p.id,
                                        ),
                                      })
                                    }
                                  >
                                    Удалить участника {i + 1}
                                  </button>
                                </div>
                              ))}
                              <TelegramPanel key={selected.id} meetingId={selected.id} participants={selected.participants} unsaved={dirty} />
                            </section>
                            <section className="editor-section">
                              <div className="editor-heading">
                                <h4>3. Поручения · {draft.actions.length}</h4>
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
                                  Добавить поручение
                                </button>
                              </div>
                              <div className="action-list">
                                {draft.actions.map((a, i) => (
                                  <div className="action-card" key={a.id}>
                                    <label className="task-title-label">
                                      Поручение {i + 1}
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
                                              due_date: e.target.value || null,
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
                                        Нет нерешённых причин проверки
                                      </p>
                                    )}
                                    <div className="evidence-row">
                                      <span>Источники поручения {i + 1}</span>
                                      {a.evidence_segment_ids.length === 0 && (
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
                                            · {s.speaker_id}
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
                                          {s.speaker_id}: {s.text}
                                        </label>
                                      ))}
                                    </details>
                                    <button
                                      className="text-button"
                                      onClick={() =>
                                        edit({
                                          actions: draft.actions.filter(
                                            (other) => other.id !== a.id,
                                          ),
                                        })
                                      }
                                    >
                                      Удалить поручение {i + 1}
                                    </button>
                                  </div>
                                ))}
                              </div>
                            </section>
                          </fieldset>
                          <section className="editor-section transcript-section">
                            <div className="editor-heading">
                              <h4>4. Исходные реплики</h4>
                            </div>
                            {selected.source_mode !== "audio" && (
                              <p>
                                Временных меток нет: это текст, а не
                                выравнивание аудио.
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
                                      )?.display_name || s.speaker_id}
                                    </strong>
                                    <p>{s.text}</p>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </section>
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
                      <small>Поручение №{a.id.slice(0, 8)}</small>
                      <button
                        className="meeting-link"
                        onClick={() => openMeeting(a.meeting_id)}
                      >
                        {a.meeting_title}
                      </button>
                      {demoLabel(a.meeting_id)}
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
                    <span className="task-state">
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
              <h1>Напоминания</h1>
              <p>
                Локальный список по подтверждённым датам. Telegram подключается
                отдельно в карточке участников встречи.
              </p>
              {extraErrors.notifications && (
                <p className="error-banner" role="alert">
                  Напоминания не обновлены: {extraErrors.notifications}
                </p>
              )}
              <div className="task-board">
                {notifications.map((n) => (
                  <button
                    className="notification-row"
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
                      {demoLabel(n.meeting_id)}
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
