import { useEffect, useState } from "react";
import { api } from "./api";
import type { Participant } from "./types";

type Status = {
  enabled: boolean;
  ready: boolean;
  bot_username: string | null;
  error: string | null;
  include_task_text: boolean;
  participants: { participant_id: string; bound: boolean; blocked: boolean }[];
  deliveries: Record<string, number>;
  unmatched_action_ids: string[];
};
type Invite = { url: string; expires_at: string };

export default function TelegramPanel({ meetingId, participants, unsaved }: {
  meetingId: string; participants: Participant[]; unsaved: boolean;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [links, setLinks] = useState<Record<string, Invite>>({});
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState("");
  const path = `/meetings/${meetingId}/telegram`;

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const result = await api<Status>(path);
        if (active) { setStatus(result); setLoadError(""); }
      } catch (e) {
        if (active) setLoadError(e instanceof Error ? e.message : "Ошибка Telegram");
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => { active = false; window.clearInterval(timer); };
  }, [path]);

  async function change(participantId: string, operation: "invite" | "unlink") {
    if (busy) return;
    setBusy(participantId);
    setError("");
    try {
      const result = await api<Invite>(`${path}/participants/${encodeURIComponent(participantId)}/${operation}`, { method: "POST" });
      setLinks(old => {
        const next = { ...old };
        if (operation === "invite") next[participantId] = result;
        else delete next[participantId];
        return next;
      });
      setStatus(await api<Status>(path));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ошибка Telegram");
    } finally { setBusy(""); }
  }

  return <section className="telegram-panel" aria-label="Telegram участников">
    <h4>Telegram</h4>
    {!status && !loadError && <p>Проверяем подключение…</p>}
    {loadError && <p role="alert">{loadError}</p>}
    {error && <p role="alert">{error}</p>}
    {status && !status.enabled && <p>Канал выключен. Локальные напоминания продолжают работать.</p>}
    {status?.enabled && <>
      <p>{status.ready ? `Бот @${status.bot_username}` : "Бот подключается…"} · Уведомления после утверждения.</p>
      <p>{status.include_task_text ? "В Telegram отправляются текст поручения и срок." : "Сообщения нейтральные: без текста встречи и поручений."}</p>
      {status.error && <p role="alert">{status.error}</p>}
      {unsaved && <p>Сохраните правки перед подключением участников.</p>}
      {status.unmatched_action_ids.length > 0 && <p>Для отправки имя исполнителя должно точно совпадать с именем одного участника. Проверьте {status.unmatched_action_ids.length} поручений.</p>}
      {participants.map(p => {
        const binding = status.participants.find(b => b.participant_id === p.id);
        const link = links[p.id];
        return <div className="telegram-participant" key={p.id}>
          <strong>{p.display_name}</strong>
          <span>{binding?.blocked ? "Уведомления отключены" : binding?.bound ? "Telegram подключён" : "Telegram не подключён"}</span>
          <button className="small-add" disabled={!!busy || unsaved || !status.ready} onClick={() => change(p.id, "invite")}>
            {binding?.bound ? "Новая ссылка" : "Получить ссылку"} для {p.display_name}
          </button>
          {(binding?.bound || link) && <button className="text-button" disabled={!!busy || unsaved} onClick={() => change(p.id, "unlink")}>Отключить {p.display_name}</button>}
          {link && <div className="telegram-invite">
            <label>Одноразовая ссылка для {p.display_name}<input readOnly value={link.url} onFocus={e => e.target.select()} /></label>
            <small>Передайте лично участнику. Он сам открывает бота и нажимает «Старт». Ссылка действует до {new Date(link.expires_at).toLocaleTimeString("ru-RU")}.</small>
          </div>}
        </div>;
      })}
      <p>Отправлено: {status.deliveries.sent || 0} · В очереди: {status.deliveries.pending || 0} · Ошибок доставки: {status.deliveries.failed || 0}</p>
    </>}
  </section>;
}
