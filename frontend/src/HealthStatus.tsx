import type { Health } from "./types";
import Icon from "./Icon";

export default function HealthStatus({
  health,
  error,
}: {
  health: Health | null;
  error?: string;
}) {
  const ready = health && Object.values(health.providers).every(Boolean);
  return (
    <details className="health-panel">
      <summary>
        <span className={`connection-dot ${health ? "connected" : ""}`} />
        {health
          ? "Сервер доступен"
          : error
            ? "Нет связи с сервером"
            : "Подключение…"}
        <Icon name="chevron" size={14} />
      </summary>
      <div className="health-popover">
        <div className="eyebrow">СОСТОЯНИЕ СЕРВИСА</div>
        <h3>
          {health
            ? ready
              ? "Модели доступны"
              : "Требуется настройка моделей"
            : "Проверяем соединение"}
        </h3>
        <p>
          Проверка доступности компонентов. Качество распознавания оценивается
          на вашей записи.
        </p>
        {health && (
          <ul className="provider-list">
            {(
              [
                ["speech", "Распознавание речи"],
                ["diarization", "Разделение голосов"],
                ["llm", "Извлечение поручений"],
              ] as const
            ).map(([key, label]) => (
              <li key={key}>
                <span>{label}</span>
                <strong
                  className={
                    health.providers[key]
                      ? "provider-ready"
                      : "provider-missing"
                  }
                >
                  {health.providers[key] ? "Доступно" : "Не готово"}
                </strong>
              </li>
            ))}
          </ul>
        )}
        {error && <p>{error}</p>}
        {health && (
          <details className="technical-details">
            <summary>Технические подробности</summary>
            <pre>{JSON.stringify(health.details, null, 2)}</pre>
          </details>
        )}
      </div>
    </details>
  );
}
