import { useEffect, useRef, useState } from "react";
import { api, body } from "./api";
import type { Meeting, Participant } from "./types";
import Icon from "./Icon";

export default function CreateMeeting({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (m: Meeting) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<"audio" | "text">("audio");
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(
    new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Almaty" }).format(
      new Date(),
    ),
  );
  const [timezone, setTimezone] = useState("Asia/Almaty");
  const [names, setNames] = useState("");
  const [transcript, setTranscript] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  useEffect(() => {
    dialog.current?.showModal();
    titleInput.current?.focus();
  }, []);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (pending.current) return;
    setError("");
    try {
      if (!title.trim()) throw new Error("Введите название встречи.");
      try {
        new Intl.DateTimeFormat("ru", { timeZone: timezone }).format();
      } catch {
        throw new Error(
          "Введите действующий часовой пояс, например Asia/Almaty.",
        );
      }
      const participants: Participant[] = names
        .split(/[,\n]/)
        .map((n) => n.trim())
        .filter(Boolean)
        .map((display_name) => ({
          id: crypto.randomUUID(),
          display_name,
          speaker_id: null,
        }));
      if (
        participants.length > 100 ||
        participants.some((p) => p.display_name.length > 200)
      )
        throw new Error("Допустимо до 100 участников, имя — до 200 символов.");
      if (mode === "audio") {
        if (!file) throw new Error("Выберите запись.");
        if (!/\.(wav|mp3|m4a|mp4|webm|ogg|flac)$/i.test(file.name))
          throw new Error(
            "Поддерживаются WAV, MP3, M4A, MP4, WebM, OGG и FLAC.",
          );
        if (file.size === 0 || file.size > 100 * 1024 * 1024)
          throw new Error("Выберите непустой файл размером до 100 МБ.");
        if (!consent)
          throw new Error(
            "Подтвердите, что участники уведомлены об обработке записи.",
          );
      } else if (!transcript.trim())
        throw new Error("Добавьте текст расшифровки.");
      pending.current = true;
      setBusy(true);
      let meeting: Meeting;
      if (mode === "audio") {
        const data = new FormData();
        data.append("file", file!);
        data.append("title", title.trim());
        data.append("occurred_at", date);
        data.append("timezone", timezone);
        data.append("participants", JSON.stringify(participants));
        meeting = await api<Meeting>("/meetings/audio", {
          method: "POST",
          body: data,
        });
      } else
        meeting = await api<Meeting>(
          "/meetings/text",
          body(
            {
              title: title.trim(),
              occurred_at: date,
              timezone,
              participants,
              transcript,
            },
            "POST",
          ),
        );
      onCreated(meeting);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось создать встречу.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <dialog
      ref={dialog}
      className="create-modal"
      aria-labelledby="create-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <form onSubmit={submit}>
        <div className="modal-head">
          <div>
            <div className="eyebrow">НАЧНЁМ С МАТЕРИАЛОВ</div>
            <h2 id="create-title">Новая встреча</h2>
            <p>Добавьте запись или готовую расшифровку.</p>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Закрыть"
            disabled={busy}
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>
        <fieldset disabled={busy} className="editor-fields">
          <div className="mode-tabs">
            <button
              type="button"
              aria-pressed={mode === "audio"}
              className={`mode-tab ${mode === "audio" ? "active" : ""}`}
              onClick={() => {
                setMode("audio");
                setError("");
              }}
            >
              <Icon name="mic" size={17} />
              Аудио / видео
            </button>
            <button
              type="button"
              aria-pressed={mode === "text"}
              className={`mode-tab ${mode === "text" ? "active" : ""}`}
              onClick={() => {
                setMode("text");
                setError("");
              }}
            >
              <Icon name="file" size={17} />
              Импорт текста
            </button>
          </div>
          <label className="form-label">
            Название встречи
            <input
              ref={titleInput}
              required
              maxLength={300}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <div className="form-grid">
            <label className="form-label">
              Дата встречи
              <input
                type="date"
                required
                min="1900-01-01"
                max="2100-12-31"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </label>
            <label className="form-label">
              Часовой пояс
              <input
                required
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
              />
            </label>
          </div>
          <label className="form-label">
            Участники (необязательно)
            <textarea
              value={names}
              onChange={(e) => setNames(e.target.value)}
              placeholder="Имена через запятую или с новой строки"
              rows={2}
            />
          </label>
          {mode === "audio" ? (
            <>
              <label className={`upload-zone ${file ? "has-file" : ""}`}>
                <span className="upload-icon">
                  <Icon name={file ? "file" : "upload"} size={25} />
                </span>
                <strong>{file ? file.name : "Выберите файл записи"}</strong>
                <span>
                  {file
                    ? `${(file.size / 1024 / 1024).toFixed(1)} МБ · нажмите, чтобы заменить`
                    : "Аудио или видео с вашего устройства"}
                </span>
                <span className="upload-formats">
                  WAV, MP3, M4A, MP4, WebM, OGG, FLAC · до 100 МБ
                </span>
                <input
                  type="file"
                  aria-label="Файл записи"
                  accept=".wav,.mp3,.m4a,.mp4,.webm,.ogg,.flac"
                  onChange={(e) => setFile(e.target.files?.[0] || null)}
                />
              </label>
              <p className="form-hint">
                Подойдёт сохранённая запись из Teams, Zoom или Google Meet.
                Подключение к онлайн-встречам пока не поддерживается.
              </p>
              <label className="consent">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                />
                Подтверждаю, что участники уведомлены об обработке записи на
                сервере команды.
              </label>
            </>
          ) : (
            <>
              <p>
                Текстовый импорт проверяет извлечение поручений локальной
                моделью. Распознавание речи и аудиотаймкоды здесь не
                используются.
              </p>
              <label className="form-label">
                Текст расшифровки
                <textarea
                  required
                  maxLength={80000}
                  rows={7}
                  value={transcript}
                  onChange={(e) => setTranscript(e.target.value)}
                />
              </label>
            </>
          )}
        </fieldset>
        {error && (
          <p className="error-banner" role="alert">
            {error}
          </p>
        )}
        <div className="modal-footer">
          <span>
            <Icon name="shield" size={16} />
            На сервере команды
          </span>
          <button className="primary-button" disabled={busy}>
            {busy ? "Загружаем…" : "Создать встречу"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
