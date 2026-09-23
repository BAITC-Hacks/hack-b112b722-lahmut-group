import type { APIRequestContext, Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test, expect, python } from "./fixtures";

function wav() {
  const b = Buffer.alloc(128044); // Four seconds, mono PCM16, 16 kHz.
  b.write("RIFF"); b.writeUInt32LE(b.length - 8, 4); b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(b.length - 44, 40);
  return b;
}
const payload = (title: string, transcript = "Әлия: Подготовим отчёт. Жақсы.") => ({
  title, transcript, occurred_at: "2020-01-01", timezone: "Asia/Almaty", participants: [],
});
async function configure(request: APIRequestContext, values: object = {}) {
  expect((await request.post("/__test__/scenario", { data: { name: "review", delay_ms: 40, ...values } })).ok()).toBeTruthy();
}
async function meeting(request: APIRequestContext, id: string) {
  const response = await request.get(`/api/meetings/${id}`);
  expect(response.ok()).toBeTruthy();
  return response.json();
}
async function finished(request: APIRequestContext, id: string, status = "review_ready") {
  await expect.poll(async () => (await meeting(request, id)).status).toBe(status);
  return meeting(request, id);
}
async function createText(request: APIRequestContext, title: string) {
  const response = await request.post("/api/meetings/text", { data: payload(title) });
  expect(response.status()).toBe(200);
  return response.json();
}
async function open(page: Page, title: string) {
  await page.goto("/");
  await page.getByRole("button", { name: "Встречи", exact: true }).click();
  await expect(page.getByRole("article", { name: "Протокол встречи" })).toBeVisible();
  const library = page.getByRole("button", { name: /^Все встречи/ });
  if (await library.getAttribute("aria-expanded") !== "true") await library.click();
  await page.locator(".meeting-row").filter({ hasText: title }).click();
}
async function uploadUI(page: Page, title: string, buffer = wav()) {
  await page.goto("/");
  await expect(page.getByTestId("ml-stub-banner")).toContainText("Реальные модели не запускались");
  await page.getByRole("button", { name: "Новая встреча", exact: true }).click();
  const modal = page.getByRole("dialog");
  await modal.getByLabel("Название встречи", { exact: true }).fill(title);
  await modal.getByLabel("Дата встречи", { exact: true }).fill("2020-01-01");
  await modal.getByLabel("Участники (необязательно)", { exact: true }).fill("Әлия, Данияр");
  await modal.getByLabel("Файл записи").setInputFiles({ name: "synthetic-test.wav", mimeType: "audio/wav", buffer });
  await modal.getByLabel("Подтверждаю, что участники уведомлены", { exact: false }).check();
  const response = page.waitForResponse(r => r.url().endsWith("/meetings/audio") && r.request().method() === "POST");
  await modal.getByRole("button", { name: "Создать встречу" }).click();
  const result = await response;
  expect(result.status()).toBe(200);
  return result.json();
}
async function save(page: Page) {
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Правки сохранены на сервере" })).toBeVisible();
}
async function review(page: Page) {
  await expect(page.getByLabel("Поручение 2", { exact: true })).toBeVisible();
  await page.getByLabel("Исполнитель 2", { exact: true }).fill("Данияр");
  await page.getByRole("button", { name: /^Подтвердить ручную проверку:/ }).click();
  await save(page);
}
function inspectDocx(path: string) {
  return JSON.parse(execFileSync(python, ["-c", "import json,sys,zipfile; from docx import Document; d=Document(sys.argv[1]); print(json.dumps({'paragraphs':[p.text for p in d.paragraphs],'rows':[[c.text for c in row.cells] for t in d.tables for row in t.rows],'xml':zipfile.ZipFile(sys.argv[1]).read('word/document.xml').decode('utf-8')}))", path], { encoding: "utf8" }));
}

test.beforeEach(async ({ request }) => { await configure(request); });

test("audio upload → real queue/stages → human review → approved DOCX → completion → reapproval", async ({ page, request }, info) => {
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  await configure(request, { delay_ms: 150 });
  const m = await uploadUI(page, `Full audio ${Date.now()}`);
  expect(m.status).toBe("queued");
  const ready = await finished(request, m.id);
  await expect(page.getByLabel("Краткий итог встречи")).toHaveValue(/ТЕСТОВАЯ ИМИТАЦИЯ ML/);
  const state = await (await request.get("/__test__/state")).json();
  expect(state.events.filter((e: any) => e.title === m.title).map((e: any) => e.stage)).toEqual(["transcribing", "diarizing", "extracting"]);
  expect(ready.actions).toHaveLength(3);
  expect((await request.get(`/api/meetings/${m.id}/export.docx`)).status()).toBe(409);
  expect((await request.post(`/api/meetings/${m.id}/approve`, { data: { revision: ready.revision } })).status()).toBe(409);
  const range = await request.get(`/api/meetings/${m.id}/audio`, { headers: { Range: "bytes=0-43" } });
  expect(range.status()).toBe(206); expect(await range.body()).toEqual(wav().subarray(0, 44));
  await page.locator(".participants-section > summary").click();
  await page.getByRole("combobox", { name: "Голос участника 1", exact: true }).selectOption("SPEAKER_00");
  await page.getByRole("combobox", { name: "Голос участника 2", exact: true }).selectOption("SPEAKER_01");
  await page.getByRole("button", { name: `Источник ${ready.segments[0].id} поручения 1`, exact: true }).click();
  await expect(page.locator(`#segment-${ready.segments[0].id}`)).toBeFocused();
  await expect.poll(() => page.locator("audio").evaluate((a: HTMLAudioElement) => a.currentTime)).toBeGreaterThanOrEqual(1);
  await review(page);
  await page.reload();
  await page.locator(".participants-section > summary").click();
  await expect(page.getByRole("combobox", { name: "Голос участника 1", exact: true })).toHaveValue("SPEAKER_00");
  await expect(page.getByLabel("Исходный срок 2", { exact: true })).toHaveValue("после совещания");
  await expect(page.getByLabel("Дата срока 2", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "Утвердить протокол", exact: true }).click();
  await expect(page.getByRole("button", { name: "Скачать DOCX" })).toBeEnabled();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Скачать DOCX" }).click();
  const path = info.outputPath("synthetic-approved.docx");
  await (await download).saveAs(path);
  const document = inspectDocx(path);
  expect(document.rows).toHaveLength(4);
  expect(JSON.stringify(document)).toContain("Ә Ғ Қ Ң Ө Ұ Ү Һ І");
  expect(document.paragraphs.join("\n")).toContain("ТЕСТОВАЯ ИМИТАЦИЯ ML");
  expect(document.rows[1][3]).toContain("2020-01-02");
  expect(document.rows[2][3]).toContain("Дата не указана");
  const approved = await meeting(request, m.id);
  const reminders = (await (await request.get("/api/notifications")).json()).filter((n: any) => n.meeting_id === m.id);
  expect(reminders).toHaveLength(1); expect(reminders[0].kind).toBe("overdue");
  await page.getByRole("button", { name: "Задачи", exact: true }).click();
  const row = page.locator(".global-task").filter({ has: page.getByRole("button", { name: m.title, exact: true }) }).filter({ hasText: ready.actions[0].title });
  await row.getByRole("button", { name: /^Завершить:/ }).click();
  await expect(row).toContainText("Выполнено");
  const done = await meeting(request, m.id);
  expect(done.approved).toBe(true); expect(done.revision).toBe(approved.revision + 1);
  expect((await (await request.get("/api/notifications")).json()).filter((n: any) => n.meeting_id === m.id)).toHaveLength(0);
  const snapshot = info.outputPath("after-completion.docx");
  const fs = await import("node:fs/promises");
  await fs.writeFile(snapshot, await (await request.get(`/api/meetings/${m.id}/export.docx`)).body());
  expect(inspectDocx(snapshot).xml).toBe(document.xml);
  await row.getByRole("button", { name: m.title, exact: true }).click();
  await page.getByLabel("Краткий итог встречи").fill("Изменённый итог — Ә Ғ Қ Ң Ө Ұ Ү Һ І");
  await expect(page.getByRole("button", { name: "Скачать DOCX" })).toBeDisabled();
  await save(page);
  expect((await request.get(`/api/meetings/${m.id}/export.docx`)).status()).toBe(409);
  await page.getByRole("button", { name: "Утвердить протокол", exact: true }).click();
  await expect(page.getByRole("button", { name: "Скачать DOCX" })).toBeEnabled();
  await page.screenshot({ path: info.outputPath("full-audio-reviewed.png"), fullPage: true });
  expect(errors).toEqual([]);
});

for (const [stage, label] of [["transcribing", "Расшифровка речи"], ["diarizing", "Разделение голосов"], ["extracting", "Извлечение поручений"]]) {
  test(`browser displays genuine backend stage ${stage} while the stub is gated`, async ({ page, request }) => {
    await configure(request, { gate_stage: stage });
    const m = await uploadUI(page, `Stage ${stage} ${Date.now()}`);
    await expect.poll(async () => (await meeting(request, m.id)).status).toBe(stage);
    await expect(page.locator(".processing-box")).toContainText(label);
    await request.post("/__test__/release");
    await finished(request, m.id);
    await expect(page.getByLabel("Поручение 1", { exact: true })).toBeVisible();
  });
}

for (const [language, text] of [["ru", "Әлия: Подготовьте отчёт."], ["kz", "Әлия: Қазақша есепті дайындаңыз."], ["mixed", "Әлия: Отчёт дайындаңыз. Спасибо."]]) {
  test(`successful ${language} text import has no audio alignment and survives reload`, async ({ page, request }) => {
    await configure(request, { language });
    await page.goto("/");
    await page.getByRole("button", { name: "Новая встреча", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Импорт текста", exact: true }).click();
    await dialog.getByLabel("Название встречи", { exact: true }).fill(`Text ${language} ${Date.now()}`);
    await dialog.getByLabel("Текст расшифровки", { exact: true }).fill(text);
    const response = page.waitForResponse(r => r.url().endsWith("/meetings/text") && r.request().method() === "POST");
    await dialog.getByRole("button", { name: "Создать встречу" }).click();
    const m = await (await response).json();
    const ready = await finished(request, m.id);
    expect(ready.segments.every((s: any) => s.start_ms === 0 && s.end_ms === 0)).toBe(true);
    await expect(page.locator(".transcript-list")).toContainText(text);
    await expect(page.locator("audio")).toHaveCount(0);
    await review(page);
    await page.reload();
    await expect(page.getByLabel("Исполнитель 2", { exact: true })).toHaveValue("Данияр");
  });
}

for (const scenario of ["fail-transcribing", "fail-diarizing", "fail-extracting", "invalid-evidence", "invalid-summary"]) {
  test(`${scenario}: failed state is visible and cannot be approved or exported`, async ({ page, request }) => {
    await configure(request, { name: scenario });
    const m = await uploadUI(page, `Error ${scenario} ${Date.now()}`);
    const failed = await finished(request, m.id, "failed");
    await expect(page.locator(".failed-box")).toContainText("Не удалось обработать встречу");
    await expect(page.locator(".failed-box")).toContainText(failed.error);
    expect((await request.post(`/api/meetings/${m.id}/approve`, { data: { revision: failed.revision } })).status()).toBe(409);
    expect((await request.get(`/api/meetings/${m.id}/export.docx`)).status()).toBe(409);
    await page.reload();
    await expect(page.locator(".failed-box")).toContainText(failed.error);
  });
}

test("corrupt audio produces explicit failure, followed by successful re-upload", async ({ page, request }) => {
  const bad = await uploadUI(page, `Corrupt ${Date.now()}`, Buffer.from("not a WAV"));
  await finished(request, bad.id, "failed");
  await expect(page.locator(".failed-box")).toContainText("PCM WAV");
  const good = await uploadUI(page, `Retry ${Date.now()}`);
  await finished(request, good.id);
  await expect(page.getByLabel("Поручение 1", { exact: true })).toBeVisible();
});

test("single worker queues duplicate imports without colliding action IDs", async ({ page, request }) => {
  await configure(request, { gate_stage: "extracting" });
  const first = await createText(request, `Queue first ${Date.now()}`);
  await expect.poll(async () => (await meeting(request, first.id)).status).toBe("extracting");
  const second = await createText(request, `Queue second ${Date.now()}`);
  expect((await meeting(request, second.id)).status).toBe("queued");
  await open(page, second.title);
  await expect(page.locator(".processing-box")).toContainText("В очереди");
  const state = await (await request.get("/__test__/state")).json();
  expect(state.active).toBe(1); expect(state.peak_active).toBe(1);
  await request.post("/__test__/release");
  const a = await finished(request, first.id), b = await finished(request, second.id);
  expect(a.actions.some((x: any) => b.actions.some((y: any) => y.id === x.id))).toBe(false);
  await expect(page.getByLabel("Краткий итог встречи")).toHaveValue(/ТЕСТОВАЯ ИМИТАЦИЯ ML/);
});

test("two real tabs preserve stale draft, detect revision conflict and recover", async ({ page, context, request }) => {
  const m = await createText(request, `Two tabs ${Date.now()}`);
  await finished(request, m.id);
  await open(page, m.title);
  const other = await context.newPage();
  await open(other, m.title);
  await page.getByLabel("Краткий итог встречи").fill("First unsaved local edit");
  await other.getByLabel("Краткий итог встречи").fill("Saved by another tab");
  await save(other);
  await expect(page.locator(".conflict-panel")).toContainText("Конфликт версии");
  await expect(page.getByLabel("Краткий итог встречи")).toHaveValue("First unsaved local edit");
  await expect(page.getByRole("button", { name: "Сохранить", exact: true })).toBeDisabled();
  const backup = page.waitForEvent("download");
  await page.getByRole("button", { name: "Скачать мой черновик" }).click();
  expect(JSON.parse(await readFile((await (await backup).path())!, "utf8")).summary).toBe("First unsaved local edit");
  await page.getByRole("button", { name: "Заменить мой черновик серверной версией" }).click();
  await expect(page.getByLabel("Краткий итог встречи")).toHaveValue("Saved by another tab");
  await other.close();
});

test("empty extraction supports manual participant/task/evidence CRUD and approval", async ({ page, request }) => {
  await configure(request, { name: "empty" });
  const m = await createText(request, `Manual CRUD ${Date.now()}`);
  const ready = await finished(request, m.id);
  await open(page, m.title);
  await expect(page.locator(".action-card")).toHaveCount(0);
  await page.locator(".participants-section > summary").click();
  await page.getByRole("button", { name: "Добавить участника", exact: true }).click();
  await page.getByLabel("Имя участника 1", { exact: true }).fill("Қанат");
  await page.getByRole("combobox", { name: "Голос участника 1", exact: true }).selectOption("SPEAKER_00");
  await page.getByRole("button", { name: "Добавить поручение", exact: true }).click();
  await page.getByLabel("Поручение 1", { exact: true }).fill("Проверить смету");
  await page.getByLabel("Исполнитель 1", { exact: true }).fill("Қанат");
  await page.getByLabel("Исходный срок 1", { exact: true }).fill("после обсуждения");
  await page.locator(".source-picker summary").click();
  await page.locator(".source-picker input[type=checkbox]").first().check();
  await save(page);
  let saved = await meeting(request, m.id);
  expect(saved.actions[0].evidence_segment_ids).toEqual([ready.segments[0].id]);
  expect(saved.actions[0].due_date).toBeNull();
  await page.getByRole("button", { name: "Утвердить протокол", exact: true }).click();
  await expect(page.getByRole("button", { name: "Скачать DOCX" })).toBeEnabled();
  await page.getByRole("button", { name: "Удалить поручение 1", exact: true }).click();
  await page.getByRole("button", { name: "Удалить участника 1", exact: true }).click();
  await save(page);
  saved = await meeting(request, m.id);
  expect(saved.actions).toEqual([]); expect(saved.participants).toEqual([]); expect(saved.approved).toBe(false);
});

test("real process restart preserves approved snapshot, revision, completion and source audio", async ({ page, request, server }, info) => {
  const m = await uploadUI(page, `Persistence ${Date.now()}`);
  await finished(request, m.id); await review(page);
  await page.getByRole("button", { name: "Утвердить протокол", exact: true }).click();
  await expect(page.getByRole("button", { name: "Скачать DOCX" })).toBeEnabled();
  let saved = await meeting(request, m.id);
  expect((await request.patch(`/api/actions/${saved.actions[0].id}`, { data: { status: "done" } })).ok()).toBe(true);
  saved = await meeting(request, m.id);
  const doc = await (await request.get(`/api/meetings/${m.id}/export.docx`)).body();
  await server!.stop(); await server!.start("review");
  expect(await meeting(request, m.id)).toEqual(saved);
  expect(await (await request.get(`/api/meetings/${m.id}/audio`)).body()).toEqual(wav());
  const fs = await import("node:fs/promises");
  const before = info.outputPath("before-restart.docx"), after = info.outputPath("after-restart.docx");
  await fs.writeFile(before, doc);
  await fs.writeFile(after, await (await request.get(`/api/meetings/${m.id}/export.docx`)).body());
  expect(inspectDocx(after).xml).toBe(inspectDocx(before).xml);
  await page.reload();
  await expect(page.getByRole("button", { name: "Скачать DOCX" })).toBeEnabled();
});

test("crash during ML marks active job failed and resumes persisted queued job", async ({ page, request, server }) => {
  await configure(request, { gate_stage: "extracting" });
  const active = await createText(request, `Interrupted ${Date.now()}`);
  await expect.poll(async () => (await meeting(request, active.id)).status).toBe("extracting");
  const queued = await createText(request, `Recovered queue ${Date.now()}`);
  expect((await meeting(request, queued.id)).status).toBe("queued");
  await server!.stop(); await server!.start("review");
  const failed = await finished(request, active.id, "failed");
  expect(failed.error).toContain("restart");
  await finished(request, queued.id);
  await open(page, active.title);
  await expect(page.locator(".failed-box")).toContainText("restart");
  await page.getByRole("button", { name: /^Все встречи/ }).click();
  await page.locator(".meeting-row").filter({ hasText: queued.title }).click();
  await expect(page.getByLabel("Поручение 1", { exact: true })).toBeVisible();
});
