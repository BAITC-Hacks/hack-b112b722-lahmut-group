import type { APIRequestContext, Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { test, expect, python } from "./fixtures";

async function demo(page: Page) {
  await page.goto("/");
  const result = page.waitForResponse(r => r.url().endsWith("/meetings/demo") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Открыть демо", exact: true }).click();
  const meeting = await (await result).json();
  await expect(page.getByRole("region", { name: "Telegram участников" })).toBeVisible();
  return meeting;
}
async function link(page: Page) {
  const response = page.waitForResponse(r => r.url().endsWith("/invite") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Получить ссылку для Данияр", exact: true }).click();
  const invite = await (await response).json();
  const input = page.getByLabel("Одноразовая ссылка для Данияр", { exact: true });
  expect(invite.url).toMatch(/^https:\/\/t.me\/Khattama_Test_Bot\?start=/);
  await expect(input).toHaveValue(invite.url);
  return new URL(await input.inputValue()).searchParams.get("start");
}
async function start(request: APIRequestContext, token: string | null, user: number) {
  const response = await request.post("/__test__/telegram/update", { data: {
    message: { from: { id: user, is_bot: false }, chat: { id: user, type: "private" }, text: `/start ${token}` },
  }});
  expect(response.ok()).toBeTruthy();
  return response.json();
}
async function tick(request: APIRequestContext) {
  const response = await request.post("/__test__/telegram/tick");
  expect(response.ok()).toBeTruthy();
  return response.json();
}
const sent = (state: any, user: number) => state.calls.filter((c: any) => c.method === "sendMessage" && c.chat_id === user && c.reply_markup && c.message_id);
async function complete(request: APIRequestContext, message: any, user: number) {
  const response = await request.post("/__test__/telegram/update", { data: { callback_query: {
    id: `query-${Date.now()}`, from: { id: user }, data: message.reply_markup.inline_keyboard[0][0].callback_data,
    message: { message_id: message.message_id, chat: { id: message.chat_id, type: "private" } },
  }}});
  expect(response.ok()).toBeTruthy();
  return response.json();
}
async function approve(page: Page) {
  await page.getByRole("button", { name: /^Подтвердить ручную проверку:/ }).click();
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Правки сохранены на сервере" })).toBeVisible();
  await page.getByRole("button", { name: "Утвердить протокол", exact: true }).click();
  await expect(page.getByRole("button", { name: "Скачать DOCX", exact: true })).toBeEnabled();
}
function docxXml(path: string) {
  return execFileSync(python, ["-c", "import sys,zipfile;sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read('word/document.xml'))", path], { encoding: "utf8" });
}

test("Telegram UI invite → private start → approval → correct user completion → unchanged DOCX", async ({ page, request }, info) => {
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  const m = await demo(page);
  const user = 8000001001;
  const token = await link(page);
  expect(sent(await start(request, token, user), user)).toHaveLength(0);
  const participant = page.locator(".telegram-participant").filter({ has: page.locator("strong", { hasText: /^Данияр$/ }) });
  await expect(participant).toContainText("Telegram подключён");
  m.actions[0].title += ` TG ${m.id.slice(0, 8)}`;
  await page.getByLabel("Поручение 1", { exact: true }).fill(m.actions[0].title);
  await approve(page);
  const before = await (await request.get(`/api/meetings/${m.id}`)).json();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Скачать DOCX", exact: true }).click();
  const beforePath = info.outputPath("before-telegram-completion.docx");
  await (await download).saveAs(beforePath);
  const message = sent(await tick(request), user)[0];
  expect(message.text).toContain(m.actions[0].title);
  expect(message.reply_markup.inline_keyboard[0][0].text).toBe("Выполнено");
  const denied = await complete(request, message, 999);
  expect(denied.calls.filter((c: any) => c.method === "answerCallbackQuery").at(-1).text).toContain("другого исполнителя");
  expect((await (await request.get(`/api/meetings/${m.id}`)).json()).actions[0].status).toBe("open");
  await complete(request, message, user);
  await page.getByRole("button", { name: "Задачи", exact: true }).click();
  await expect(page.getByRole("button", { name: `Вернуть в работу: ${m.actions[0].title}`, exact: true })).toBeVisible();
  const after = await (await request.get(`/api/meetings/${m.id}`)).json();
  expect(after.approved).toBe(true);
  expect(after.revision).toBe(before.revision + 1);
  await complete(request, message, user);
  expect((await (await request.get(`/api/meetings/${m.id}`)).json()).revision).toBe(after.revision);
  await page.getByRole("button", { name: "Встречи", exact: true }).click();
  const afterDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Скачать DOCX", exact: true }).click();
  const afterPath = info.outputPath("after-telegram-completion.docx");
  await (await afterDownload).saveAs(afterPath);
  expect(docxXml(afterPath)).toBe(docxXml(beforePath));
  await page.getByRole("region", { name: "Telegram участников" }).screenshot({ path: info.outputPath("telegram-connected.png") });
  expect(errors).toEqual([]);
});

test("Telegram link rotation, saved-participant guard and unlink work on mobile", async ({ page, request }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const m = await demo(page);
  const first = await link(page);
  const second = await link(page);
  expect(first).not.toBe(second);
  const rejected = await start(request, first, 8000001002);
  expect(rejected.calls.at(-1).text).toContain("недействительна");
  await start(request, second, 8000001002);
  const participant = page.locator(".telegram-participant").filter({ has: page.locator("strong", { hasText: /^Данияр$/ }) });
  await expect(participant).toContainText("Telegram подключён");
  await page.getByLabel("Краткий итог встречи").fill("Несохранённый итог");
  await expect(participant.getByRole("button", { name: "Новая ссылка для Данияр" })).toBeDisabled();
  await expect(page.getByRole("region", { name: "Telegram участников" })).toContainText("Сохраните правки");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(participant.getByRole("button", { name: "Отключить Данияр" })).toBeEnabled();
  await participant.getByRole("button", { name: "Отключить Данияр" }).click();
  await expect(participant).toContainText("Telegram не подключён");
  expect((await (await request.get(`/api/meetings/${m.id}/telegram`)).json()).participants[1].bound).toBe(false);
  await page.getByRole("region", { name: "Telegram участников" }).screenshot({ path: info.outputPath("telegram-mobile.png") });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("Telegram persistence and dedup survive backend process restart; old buttons cannot complete a new deadline", async ({ page, request, server }) => {
  expect(server).toBeTruthy();
  const m = await demo(page);
  const user = 8000001003;
  const token = await link(page);
  await start(request, token, user);
  await approve(page);
  const state = await tick(request);
  const message = sent(state, user)[0];
  await tick(request); // Drain due reminder, if currently applicable.
  const status = await (await request.get(`/api/meetings/${m.id}/telegram`)).json();
  await server!.stop();
  await server!.start();
  await page.reload();
  await expect(page.locator(".telegram-participant").filter({ hasText: "Данияр" })).toContainText("Telegram подключён");
  expect(sent(await tick(request), user)).toHaveLength(0);
  expect((await (await request.get(`/api/meetings/${m.id}/telegram`)).json()).deliveries.sent).toBe(status.deliveries.sent);
  await page.getByLabel("Дата срока 1", { exact: true }).fill("2027-01-01");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.getByRole("button", { name: "Утвердить протокол", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Утвердить протокол", exact: true }).click();
  const stale = await complete(request, message, user);
  expect(stale.calls.filter((c: any) => c.method === "answerCallbackQuery").at(-1).text).toContain("изменилось");
  expect((await (await request.get(`/api/meetings/${m.id}`)).json()).actions[0].status).toBe("open");
  expect(sent(stale, user)).toHaveLength(1);
});
