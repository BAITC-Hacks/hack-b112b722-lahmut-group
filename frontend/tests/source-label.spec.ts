import { test, expect } from "../integration/fixtures";

test("partial meeting-list failure never presents demo tasks as confirmed real data", async ({
  page,
  request,
}) => {
  const created = await request.post("/api/meetings/demo");
  expect(created.ok()).toBe(true);
  const m = await created.json();
  const saved = await request.patch(`/api/meetings/${m.id}`, {
    data: {
      revision: m.revision,
      actions: m.actions.map((a: Record<string, unknown>) => ({
        ...a,
        title: `${a.title} · ${m.id}`,
        due_date: "2020-01-01",
        review_reasons: [],
      })),
    },
  });
  expect(saved.ok()).toBe(true);
  const approved = await request.post(`/api/meetings/${m.id}/approve`, {
    data: { revision: (await saved.json()).revision },
  });
  expect(approved.ok()).toBe(true);

  await page.route("**/api/meetings", (route) => route.abort());
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("Нет связи с сервером");
  await expect(
    page.locator(".attention-row").first().locator('[data-source="unknown"]'),
  ).toContainText("Источник не проверен");
  await page.getByRole("button", { name: "Задачи", exact: true }).click();
  const tasks = page.locator(".global-task").filter({ hasText: m.id });
  await expect(tasks.locator('[data-source="unknown"]')).toHaveCount(3);
  await page.getByRole("button", { name: "Напоминания", exact: true }).click();
  await expect(
    page
      .locator(".notification-row")
      .first()
      .locator('[data-source="unknown"]'),
  ).toBeVisible();

  await page.unroute("**/api/meetings");
  await page
    .getByRole("button", { name: "Обновить данные", exact: true })
    .click();
  await expect(page.locator('[data-source="unknown"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Задачи", exact: true }).click();
  await expect(tasks.locator('[data-source="demo"]')).toHaveCount(3);
  await expect(tasks.first()).toContainText(
    "Вымышленные данные · готовый пример",
  );
});
