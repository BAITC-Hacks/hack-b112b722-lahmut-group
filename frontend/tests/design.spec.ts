import { test, expect } from "../integration/fixtures";

test("system theme, explicit preference, drafts and navigation survive theme switching", async ({
  page,
  request,
}, info) => {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(
    page.getByRole("button", { name: "Тёмная тема", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Светлая тема", exact: true }).click();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator(".stat-card").first().locator("strong")).toHaveText(
    String((await (await request.get("/api/meetings")).json()).length),
  );
  await page.screenshot({
    path: info.outputPath("overview-light.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Тёмная тема", exact: true }).click();
  await page.screenshot({
    path: info.outputPath("overview-dark.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Открыть демо", exact: true }).click();
  await page
    .getByLabel("Краткий итог встречи")
    .fill("Правки остаются при смене оформления");
  await page.getByRole("button", { name: "Светлая тема", exact: true }).click();
  await page.getByRole("button", { name: "Обзор", exact: true }).click();
  await page.getByRole("button", { name: "Встречи", exact: true }).click();
  await expect(page.getByLabel("Краткий итог встречи")).toHaveValue(
    "Правки остаются при смене оформления",
  );
  await expect(
    page.getByRole("button", { name: "Сохранить", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Скачать DOCX", exact: true }),
  ).toBeDisabled();
  await page.screenshot({ path: info.outputPath("review-light.png") });
  await page.getByRole("button", { name: "Тёмная тема", exact: true }).click();
  await page.screenshot({ path: info.outputPath("review-dark.png") });
});

test("both themes stay usable at phone, tablet and desktop widths", async ({
  page,
}, info) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Открыть демо", exact: true }).click();
  await expect(page.getByLabel("Поручение 1", { exact: true })).toBeVisible();
  for (const width of [390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ["Светлая тема", "Тёмная тема"]) {
      await page.getByRole("button", { name: theme, exact: true }).click();
      for (const view of ["Встречи", "Задачи", "Напоминания", "Обзор"]) {
        await page.getByRole("button", { name: view, exact: true }).click();
        await expect
          .poll(() =>
            page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          )
          .toBe(true);
      }
    }
    if (width === 390)
      await page.screenshot({
        path: info.outputPath("mobile-dark.png"),
        fullPage: true,
        animations: "disabled",
      });
    await page
      .getByRole("button", { name: "Новая встреча", exact: true })
      .click();
    await expect(
      page.getByLabel("Название встречи", { exact: true }),
    ).toBeFocused();
    await expect
      .poll(() =>
        page
          .locator("dialog")
          .evaluate((el) => el.scrollWidth <= el.clientWidth),
      )
      .toBe(true);
    await page.keyboard.press("Escape");
  }
});

test("unavailable storage does not break the interface or theme control", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => {
      throw new DOMException("Storage disabled", "SecurityError");
    };
    Storage.prototype.setItem = () => {
      throw new DOMException("Storage disabled", "SecurityError");
    };
    Storage.prototype.removeItem = () => {
      throw new DOMException("Storage disabled", "SecurityError");
    };
  });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Светлая тема", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page
    .getByRole("button", { name: "Новая встреча", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(errors).toEqual([]);
});
