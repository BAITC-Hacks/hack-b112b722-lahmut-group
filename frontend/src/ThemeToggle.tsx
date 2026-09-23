import { useEffect, useState } from "react";
import Icon from "./Icon";

type Theme = "light" | "dark";
const preferenceKey = "hattama-theme";

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() =>
    document.documentElement.dataset.theme === "dark" ? "dark" : "light",
  );
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const followSystem = () => {
      try {
        if (localStorage.getItem(preferenceKey)) return;
      } catch {
        /* Storage may be unavailable in private environments. */
      }
      setTheme(media.matches ? "dark" : "light");
    };
    const sync = (event: StorageEvent) => {
      if (event.key !== preferenceKey && event.key !== null) return;
      setTheme(
        event.newValue === "dark" || (!event.newValue && media.matches)
          ? "dark"
          : "light",
      );
    };
    media.addEventListener("change", followSystem);
    window.addEventListener("storage", sync);
    return () => {
      media.removeEventListener("change", followSystem);
      window.removeEventListener("storage", sync);
    };
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", theme === "dark" ? "#242126" : "#f4f3ee");
  }, [theme]);
  const choose = (value: Theme) => {
    setTheme(value);
    try {
      localStorage.setItem(preferenceKey, value);
    } catch {
      /* The current tab can still change themes. */
    }
  };
  return (
    <div className="theme-switch" role="group" aria-label="Цветовая тема">
      <button
        aria-label="Светлая тема"
        aria-pressed={theme === "light"}
        onClick={() => choose("light")}
      >
        <Icon name="sun" size={17} />
        <span>Светлая</span>
      </button>
      <button
        aria-label="Тёмная тема"
        aria-pressed={theme === "dark"}
        onClick={() => choose("dark")}
      >
        <Icon name="moon" size={17} />
        <span>Тёмная</span>
      </button>
    </div>
  );
}
