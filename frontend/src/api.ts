export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function request(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 120000);
  try {
    const response = await fetch(`/api${path}`, {
      ...init,
      signal: controller.signal,
    });
    if (!response.ok) {
      let detail = `Ошибка сервера (${response.status})`;
      try {
        const body = await response.json();
        if (typeof body.detail === "string") detail = body.detail;
        else if (Array.isArray(body.detail))
          detail = body.detail.map((e: { msg: string }) => e.msg).join("; ");
      } catch {
        /* Non-JSON proxy errors still retain HTTP status. */
      }
      throw new ApiError(detail, response.status);
    }
    return response;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new Error(
      controller.signal.aborted
        ? "Сервер не ответил за 2 минуты. Обновите список перед повтором: операция могла завершиться."
        : "Нет связи с сервером. Проверьте подключение и запуск backend, затем обновите данные.",
    );
  } finally {
    window.clearTimeout(timer);
  }
}
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  return (await request(path, init)).json();
}
export const body = (value: unknown, method = "PATCH"): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(value),
});
