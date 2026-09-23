import type { Meeting, Notification, Task } from "./types";
import Icon from "./Icon";
import SourceTag from "./SourceTag";

type Props = {
  meetings: Meeting[];
  tasks: Task[];
  notifications: Notification[];
  loading: boolean;
  extrasLoading: boolean;
  loadError: string;
  extraErrors: Record<string, string>;
  busy: boolean;
  onCreate: () => void;
  onDemo: () => void;
  onMeeting: (id: string) => void;
  onMeetings: () => void;
  onTasks: (filter: string) => void;
  onNotifications: () => void;
};
const date = (value: string) =>
  new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" }).format(
    new Date(`${value}T00:00:00`),
  );

export default function Overview(p: Props) {
  const open = p.tasks.filter((a) => a.approved && a.status === "open");
  const review = p.meetings.filter(
    (m) => m.status === "review_ready" && !m.approved,
  );
  const stats = [
    {
      label: "Встреч в пространстве",
      value: p.meetings.length,
      icon: "file",
      hint: "Все записи и протоколы",
      action: p.onMeetings,
      unavailable: !!p.loadError,
      loading: p.loading,
    },
    {
      label: "Ожидают проверки",
      value: review.length,
      icon: "edit",
      hint: "Перед утверждением",
      action: () => (review[0] ? p.onMeeting(review[0].id) : p.onMeetings()),
      unavailable: !!p.loadError,
      loading: p.loading,
    },
    {
      label: "Поручений в работе",
      value: open.length,
      icon: "check",
      hint: "Из утверждённых протоколов",
      action: () => p.onTasks("open"),
      unavailable: !!p.extraErrors.tasks,
      loading: p.extrasLoading,
    },
    {
      label: "Срок истёк",
      value: open.filter((a) => a.overdue).length,
      icon: "clock",
      hint: "Требуют вашего внимания",
      action: () => p.onTasks("overdue"),
      unavailable: !!p.extraErrors.tasks,
      loading: p.extrasLoading,
    },
  ];
  return (
    <div className="overview-page">
      <section className="welcome-row">
        <div>
          <div className="eyebrow">РАБОЧИЙ ОБЗОР</div>
          <h1>
            Встречи проходят.
            <br className="mobile-break" /> Решения остаются.
          </h1>
          <p>Протоколы, поручения и сроки — в одном пространстве.</p>
        </div>
        <span className="today-label">
          <Icon name="calendar" size={17} />
          {new Intl.DateTimeFormat("ru-RU", {
            day: "numeric",
            month: "long",
          }).format(new Date())}
        </span>
      </section>
      <section className="overview-hero" aria-labelledby="hero-title">
        <div className="hero-copy">
          <span className="hero-kicker">ОТ ЗАПИСИ К ПРОТОКОЛУ</span>
          <h2 id="hero-title">
            Больше внимания встрече.
            <br />
            <em>Меньше — рутине.</em>
          </h2>
          <p>
            Загрузите запись, проверьте итог и поручения.
            <br />
            Утвердите протокол, когда всё на своих местах.
          </p>
          <div className="button-row">
            <button
              className="primary-button"
              disabled={p.busy}
              onClick={p.onCreate}
            >
              <Icon name="upload" />
              Загрузить запись
            </button>
            <button className="hero-demo" disabled={p.busy} onClick={p.onDemo}>
              <Icon name="play" size={14} />
              Открыть демо
            </button>
          </div>
          <span className="hero-disclaimer">
            Демо — готовый пример с вымышленными данными, без запуска моделей.
          </span>
        </div>
        <div className="hero-art" aria-hidden="true">
          <div className="orbit orbit-one" />
          <div className="orbit orbit-two" />
          <div className="floating-note">
            <span className="art-file">
              <Icon name="file" size={23} />
            </span>
            <div>
              <strong>Итоги встречи</strong>
              <span>Всё важное — зафиксировано</span>
            </div>
            <div className="art-line" />
            <div className="art-line short" />
            <div className="art-task">
              <Icon name="check" size={17} />
              <span>Поручения и ответственные</span>
            </div>
            <div className="art-task">
              <Icon name="calendar" size={17} />
              <span>Согласованные сроки</span>
            </div>
          </div>
          <div className="wave-card">
            <span className="wave-icon">
              <Icon name="mic" size={19} />
            </span>
            <div className="waveform">
              {[
                10, 20, 13, 30, 40, 24, 15, 34, 47, 32, 18, 28, 39, 22, 13, 26,
                35, 17, 10, 20, 12,
              ].map((height, i) => (
                <i key={i} style={{ height }} />
              ))}
            </div>
            <span className="wave-done">
              <Icon name="check" size={19} />
            </span>
          </div>
          <div className="art-caption">
            <span />
            ЗАПИСЬ · ПРОВЕРКА · РЕЗУЛЬТАТ
          </div>
        </div>
      </section>
      <div className="overview-stats" aria-label="Сводка рабочего пространства">
        {stats.map((s) => (
          <button className="stat-card" key={s.label} onClick={s.action}>
            <span className="stat-top">
              {s.label}
              <Icon name={s.icon} size={18} />
            </span>
            <strong>{s.unavailable || s.loading ? "—" : s.value}</strong>
            <span className="stat-hint">
              {s.unavailable
                ? "Данные недоступны"
                : s.loading
                  ? "Загружаем данные…"
                  : s.hint}
              <Icon name="arrow" size={14} />
            </span>
          </button>
        ))}
      </div>
      <div className="overview-lower">
        <section className="surface-card recent-meetings">
          <div className="card-heading">
            <h2>Последние встречи</h2>
            <button className="text-link" onClick={p.onMeetings}>
              Все встречи
              <Icon name="chevron" size={15} />
            </button>
          </div>
          {p.meetings.slice(0, 4).map((m) => (
            <button
              className="recent-row"
              key={m.id}
              onClick={() => p.onMeeting(m.id)}
            >
              <span
                className={`meeting-symbol ${m.source_mode === "demo" ? "sample" : ""}`}
              >
                <Icon
                  name={m.source_mode === "audio" ? "mic" : "file"}
                  size={20}
                />
              </span>
              <span className="recent-title">
                <strong>{m.title}</strong>
                <span>
                  {date(m.occurred_at)}
                  <span className="separator">·</span>
                  {m.source_mode === "demo"
                    ? "Демо · вымышленные данные"
                    : m.source_mode === "text"
                      ? "Импорт текста"
                      : "Аудио / видео"}
                </span>
              </span>
              <span
                className={`status-pill ${m.status === "failed" ? "failed" : m.approved ? "approved" : "review"}`}
              >
                {m.status === "failed"
                  ? "Ошибка"
                  : m.approved
                    ? "Утверждён"
                    : m.status === "review_ready"
                      ? "На проверке"
                      : "Обработка"}
              </span>
              <Icon name="chevron" size={16} />
            </button>
          ))}
          {!p.meetings.length && (
            <div className="empty-state">
              <span className="empty-icon">
                <Icon name="file" size={26} />
              </span>
              <h3>
                {p.loadError
                  ? "Не удалось загрузить встречи"
                  : p.loading
                    ? "Загружаем встречи…"
                    : "Здесь начнётся история встреч"}
              </h3>
              <p>
                {p.loadError
                  ? "Проверьте соединение и обновите данные."
                  : "Добавьте первую запись или познакомьтесь с готовым демо."}
              </p>
              {!p.loading && !p.loadError && (
                <button
                  className="text-link"
                  disabled={p.busy}
                  onClick={p.onCreate}
                >
                  Создать первую встречу
                  <Icon name="plus" size={16} />
                </button>
              )}
            </div>
          )}
        </section>
        <section className="surface-card attention-card">
          <div className="card-heading">
            <h2>На контроле</h2>
            <Icon name="bell" size={19} />
          </div>
          <p className="card-description">Ближайшие и пропущенные сроки</p>
          {p.notifications.slice(0, 3).map((n) => (
            <button
              className="attention-row"
              key={n.id}
              onClick={() => p.onMeeting(n.meeting_id)}
            >
              <span className={`attention-dot ${n.kind}`} />
              <span>
                <strong>{n.title}</strong>
                <small>
                  {n.assignee} ·{" "}
                  {n.kind === "overdue" ? "Срок истёк" : "Срок скоро"}
                </small>
                <SourceTag
                  compact
                  meeting={p.meetings.find((m) => m.id === n.meeting_id)}
                />
              </span>
              <Icon name="chevron" size={14} />
            </button>
          ))}
          {p.extraErrors.notifications ? (
            <p className="inline-warning">
              Напоминания не обновлены. Откройте список для подробностей.
            </p>
          ) : (
            !p.notifications.length && (
              <div className="attention-empty">
                <span className="empty-icon">
                  <Icon name="check" size={25} />
                </span>
                <strong>
                  {p.extrasLoading
                    ? "Проверяем сроки…"
                    : "Срочных напоминаний нет"}
                </strong>
                <p>
                  Здесь появятся поручения с подтверждённым сроком из
                  утверждённых протоколов.
                </p>
              </div>
            )
          )}
          <button
            className="text-link attention-link"
            onClick={p.onNotifications}
          >
            Все напоминания
            <Icon name="chevron" size={15} />
          </button>
        </section>
      </div>
      <p className="overview-footnote">
        <Icon name="shield" size={15} />
        Обработка на сервере команды
        <span>Демо-встречи учитываются в общей сводке</span>
      </p>
    </div>
  );
}
