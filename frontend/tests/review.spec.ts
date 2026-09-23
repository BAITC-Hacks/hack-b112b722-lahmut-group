import type { Page } from "@playwright/test";
import { test, expect } from "../integration/fixtures";
import { readFile, open, unlink } from "node:fs/promises";

async function demo(page: Page) {
  await page.goto("/");
  const response = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/meetings/demo") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Открыть демо", exact: true }).click();
  const meeting = await (await response).json();
  await expect(page.getByLabel("Поручение 1", { exact: true })).toBeVisible();
  return meeting;
}
async function save(page: Page) {
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Правки сохранены на сервере" }),
  ).toBeVisible();
}
async function approve(page: Page) {
  await page
    .getByRole("button", { name: "Утвердить протокол", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Скачать DOCX", exact: true }),
  ).toBeEnabled();
}

test("real backend: demo → sources → save → approve → DOCX → tasks → reapproval", async ({
  page,
  request,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const m = await demo(page);
  const taskTitle = `Проверить пилот: қазақша Ә Ғ Қ Ң Ө Ұ Ү Һ І ${m.id.slice(0, 8)}`;
  await expect(page.locator(".demo-banner")).toHaveText(
    "Вымышленные данные · готовый пример",
  );
  await expect(page.locator(".timestamp").first()).toHaveText("Текст");
  await expect(
    page.getByRole("button", { name: "Утвердить протокол" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Скачать DOCX" }),
  ).toBeDisabled();
  for (const [i, a] of m.actions.entries()) {
    for (const id of a.evidence_segment_ids) {
      await page
        .getByRole("button", {
          name: `Источник ${id} поручения ${i + 1}`,
          exact: true,
        })
        .click();
      await expect(page.locator(`[id="segment-${id}"]`)).toBeFocused();
      await expect(page.locator(`[id="segment-${id}"]`)).toHaveClass(
        /highlighted/,
      );
    }
  }
  await page.getByLabel("Поручение 1", { exact: true }).fill(taskTitle);
  await page
    .getByLabel("Исполнитель 1", { exact: true })
    .fill("Данияр Тестовый");
  await page.getByLabel("Дата срока 1", { exact: true }).fill("2020-01-01");
  await expect(page.getByLabel("Исходный срок 1", { exact: true })).toHaveValue(
    m.actions[0].due_text,
  );
  await page
    .getByLabel("Имя участника 1", { exact: true })
    .fill("Алия Тестовая");
  await page
    .getByRole("button", { name: /^Подтвердить ручную проверку:/ })
    .click();
  await page.waitForTimeout(3500); // Exercise the actual polling interval with an unsaved edit.
  await expect(page.getByLabel("Исполнитель 1", { exact: true })).toHaveValue(
    "Данияр Тестовый",
  );
  await page.getByRole("button", { name: "Задачи", exact: true }).click();
  await page.getByRole("button", { name: "Встречи", exact: true }).click();
  await expect(page.getByLabel("Исполнитель 1", { exact: true })).toHaveValue(
    "Данияр Тестовый",
  );
  await save(page);
  await page.reload();
  await expect(page.getByLabel("Исполнитель 1", { exact: true })).toHaveValue(
    "Данияр Тестовый",
  );
  await expect(page.getByLabel("Дата срока 1", { exact: true })).toHaveValue(
    "2020-01-01",
  );
  await expect(page.getByLabel("Имя участника 1", { exact: true })).toHaveValue(
    "Алия Тестовая",
  );
  let saved = await (await request.get(`/api/meetings/${m.id}`)).json();
  expect(saved.actions[2].due_date).toBeNull();
  expect(saved.actions.map((a: { id: string }) => a.id)).toEqual(
    m.actions.map((a: { id: string }) => a.id),
  );
  await approve(page);
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Скачать DOCX" }).click();
  const doc = await downloaded;
  const path = info.outputPath("approved-demo.docx");
  await doc.saveAs(path);
  expect((await readFile(path)).subarray(0, 2).toString()).toBe("PK");
  await info.attach("approved-demo", {
    path,
    contentType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  await page.screenshot({
    path: info.outputPath("approved-desktop.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Напоминания", exact: true }).click();
  await expect(
    page.locator(".notification-row").filter({ hasText: taskTitle }),
  ).toContainText("Вымышленные данные");
  await page.getByRole("button", { name: "Задачи", exact: true }).click();
  await page.getByRole("button", { name: "Просрочено", exact: true }).click();
  const row = page.locator(".global-task").filter({ hasText: taskTitle });
  await expect(row).toContainText("Просрочено");
  await row.getByRole("button", { name: /^Завершить:/ }).click();
  await expect(row).toHaveCount(0);
  await page.getByRole("button", { name: "Выполнено", exact: true }).click();
  await expect(row).toContainText("Выполнено");
  const all = await (await request.get("/api/actions")).json();
  expect(
    all.find((a: { id: string }) => a.id === m.actions[0].id).overdue,
  ).toBe(false);
  const reminders = await (await request.get("/api/notifications")).json();
  expect(
    reminders.some(
      (n: { action_id: string }) => n.action_id === m.actions[0].id,
    ),
  ).toBe(false);
  await row.getByRole("button", { name: m.title, exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Сохранить", exact: true }),
  ).toBeDisabled();
  await page
    .getByLabel("Краткий итог встречи")
    .fill("Исправленный итог. Ә Ғ Қ Ң Ө Ұ Ү Һ І.");
  await expect(
    page.getByRole("button", { name: "Скачать DOCX" }),
  ).toBeDisabled();
  await save(page);
  saved = await (await request.get(`/api/meetings/${m.id}`)).json();
  expect(saved.approved).toBe(false);
  expect(saved.actions[0].status).toBe("done");
  await approve(page);
  expect(errors).toEqual([]);
});

test("real 409: local draft survives; explicit replacement and backup", async ({
  page,
  request,
}) => {
  const m = await demo(page);
  const oldList = await (await request.get("/api/meetings")).json();
  // Freeze only the list so that PATCH really reaches the server with a stale revision.
  await page.route("**/api/meetings", (route) =>
    route.fulfill({ json: oldList }),
  );
  await page.getByLabel("Краткий итог встречи").fill("Мой локальный черновик");
  const remote = await request.patch(`/api/meetings/${m.id}`, {
    data: { revision: m.revision, summary: "Изменение другого пользователя" },
  });
  expect(remote.ok()).toBe(true);
  const conflict = page.waitForResponse(
    (r) =>
      r.request().method() === "PATCH" && r.url().endsWith(`/meetings/${m.id}`),
  );
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  expect((await conflict).status()).toBe(409);
  await expect(page.locator(".conflict-panel")).toContainText(
    "Ваш черновик не перезаписан",
  );
  await expect(page.getByLabel("Краткий итог встречи")).toHaveValue(
    "Мой локальный черновик",
  );
  const backup = page.waitForEvent("download");
  await page.getByRole("button", { name: "Скачать мой черновик" }).click();
  const file = await (await backup).path();
  expect(JSON.parse(await readFile(file!, "utf8")).summary).toBe(
    "Мой локальный черновик",
  );
  await page.unroute("**/api/meetings");
  await page
    .getByRole("button", { name: "Заменить мой черновик серверной версией" })
    .click();
  await expect(page.getByLabel("Краткий итог встречи")).toHaveValue(
    "Изменение другого пользователя",
  );
});

for (const [language, transcript] of [
  [
    "RU",
    "Алия: Данияр, подготовьте план к 25 сентября 2026 года.\nДанияр: Хорошо.",
  ],
  [
    "KZ",
    "Алия: Мадина, қазақша есепті 2026 жылғы 28 қыркүйекке дейін дайындаңыз.\nМадина: Жақсы.",
  ],
  [
    "RU-KZ",
    "Алия: Данияр, подготовьте план к пятнице.\nДанияр: Жақсы, дайындаймын.",
  ],
])
  test(`real text import ${language}: model failure stays visible`, async ({
    page,
    request,
  }) => {
    const health = await (await request.get("/api/health")).json();
    test.skip(
      health.providers.llm,
      "This negative test requires Ollama to be unavailable.",
    );
    await page.goto("/");
    await page
      .getByRole("button", { name: "Новая встреча", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Импорт текста", exact: true })
      .click();
    await page
      .getByLabel("Название встречи", { exact: true })
      .fill(`QA ${language} вымышленный текст`);
    await page
      .getByLabel("Текст расшифровки", { exact: true })
      .fill(transcript);
    const created = page.waitForResponse(
      (r) =>
        r.url().endsWith("/meetings/text") && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Создать встречу" }).click();
    const m = await (await created).json();
    expect(m.source_mode).toBe("text");
    await expect(page.locator(".failed-box")).toContainText(
      "Не удалось обработать встречу",
    );
    await expect(page.locator(".source-banner")).toContainText("без ASR");
    await page.reload();
    await expect(page.locator(".failed-box")).toContainText("Ollama");
    await expect(
      page.getByRole("button", { name: "Открыть демо", exact: true }),
    ).toBeEnabled();
  });

test("audio form validates consent, size, extension; real upload reports missing models", async ({
  page,
  request,
}, info) => {
  const health = await (await request.get("/api/health")).json();
  test.skip(
    health.providers.speech &&
      health.providers.diarization &&
      health.providers.llm,
    "Negative test needs missing models.",
  );
  await page.goto("/");
  await page
    .getByRole("button", { name: "Новая встреча", exact: true })
    .click();
  const modal = page.getByRole("dialog");
  await modal.getByLabel("Название встречи").fill("QA вымышленная запись");
  const input = modal.getByLabel("Файл записи");
  await input.setInputFiles({
    name: "unsupported.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("test"),
  });
  await modal.getByRole("button", { name: "Создать встречу" }).click();
  await expect(modal.getByRole("alert")).toContainText("Поддерживаются");
  const largePath = info.outputPath("large.wav");
  const large = await open(largePath, "w");
  await large.truncate(100 * 1024 * 1024 + 1);
  await large.close();
  await input.setInputFiles(largePath);
  await modal.getByRole("button", { name: "Создать встречу" }).click();
  await expect(modal.getByRole("alert")).toContainText("до 100 МБ");
  await unlink(largePath);
  const wav = Buffer.alloc(32044);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(32000, 40);
  await input.setInputFiles({
    name: "synthetic-silence.wav",
    mimeType: "audio/wav",
    buffer: wav,
  });
  await modal.getByRole("button", { name: "Создать встречу" }).click();
  await expect(modal.getByRole("alert")).toContainText("участники уведомлены");
  await modal
    .getByLabel("Подтверждаю, что участники уведомлены", { exact: false })
    .check();
  await modal.getByRole("button", { name: "Создать встречу" }).click();
  await expect(page.locator(".failed-box")).toContainText(
    "Не удалось обработать встречу",
  );
  await expect(page.locator("audio")).toBeVisible();
});

test("network failures: no demo fallback; failed register requests are visible", async ({
  page,
}) => {
  await page.route("**/api/**", (route) => route.abort());
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("Нет связи с сервером");
  await page.getByRole("button", { name: "Открыть демо", exact: true }).click();
  await expect(page.locator(".detail-card")).toHaveCount(0);
  await page.getByRole("button", { name: "Задачи", exact: true }).click();
  await expect(page.getByText(/Реестр не обновлён:/)).toBeVisible();
  await page.getByRole("button", { name: "Напоминания", exact: true }).click();
  await expect(page.getByText(/Напоминания не обновлены:/)).toBeVisible();
  await page.unroute("**/api/**");
  await page.getByRole("button", { name: "Обновить данные" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("simulated stage transition: ready result populates untouched editor", async ({
  page,
  request,
}) => {
  const m = await (await request.post("/api/meetings/demo")).json();
  let ready = false;
  await page.route("**/api/meetings", (route) =>
    route.fulfill({
      json: [
        {
          ...m,
          source_mode: "text",
          status: ready ? "review_ready" : "extracting",
          summary: ready ? "Результат имитации стадии" : "",
          actions: ready ? m.actions : [],
          segments: ready ? m.segments : [],
        },
      ],
    }),
  );
  await page.goto("/");
  await expect(
    page.getByText("Извлечение поручений", { exact: true }),
  ).toBeVisible();
  ready = true;
  await expect(page.getByLabel("Краткий итог встречи")).toHaveValue(
    "Результат имитации стадии",
  );
  await expect(page.getByLabel("Поручение 1", { exact: true })).toHaveValue(
    m.actions[0].title,
  );
});

test("narrow window and keyboard dialog; unsaved close warning", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await demo(page);
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
  await page.screenshot({
    path: info.outputPath("mobile.png"),
    fullPage: true,
  });
  const create = page.getByRole("button", {
    name: "Новая встреча",
    exact: true,
  });
  await create.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByLabel("Название встречи", { exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Дата встречи", { exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page
    .getByLabel("Краткий итог встречи")
    .fill("Не закрывать без сохранения");
  let warned = false;
  page.once("dialog", async (dialog) => {
    warned = dialog.type() === "beforeunload";
    await dialog.dismiss();
  });
  await page.reload({ timeout: 3000 }).catch(() => {});
  expect(warned).toBe(true);
  await expect(page.getByLabel("Краткий итог встречи")).toHaveValue(
    "Не закрывать без сохранения",
  );
});

test("simulated audio alignment: source seeks a real playable synthetic WAV", async ({
  page,
  request,
}) => {
  const m = await (await request.post("/api/meetings/demo")).json();
  const timed = {
    ...m,
    source_mode: "audio",
    has_audio: true,
    segments: m.segments.map((s: object) => ({
      ...s,
      start_ms: 1000,
      end_ms: 2000,
    })),
  };
  const wav = Buffer.alloc(96044);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(96000, 40);
  await page.route("**/api/meetings", (route) =>
    route.fulfill({ json: [timed] }),
  );
  await page.route(`**/api/meetings/${m.id}/audio`, (route) =>
    route.fulfill({ body: wav, contentType: "audio/wav" }),
  );
  await page.goto("/");
  await expect
    .poll(() =>
      page.locator("audio").evaluate((el: HTMLAudioElement) => el.readyState),
    )
    .toBeGreaterThanOrEqual(1);
  await page
    .getByRole("button", { name: "Источник s1 поручения 1", exact: true })
    .click();
  await expect(page.locator("#segment-s1")).toBeFocused();
  await expect
    .poll(() =>
      page.locator("audio").evaluate((el: HTMLAudioElement) => el.currentTime),
    )
    .toBeGreaterThanOrEqual(1);
  await expect(page.locator("#segment-s1 .timestamp")).toHaveText("00:01");
});
