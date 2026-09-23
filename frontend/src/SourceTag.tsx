import type { Meeting } from "./types";

export default function SourceTag({
  meeting,
  compact = false,
}: {
  meeting?: Meeting;
  compact?: boolean;
}) {
  // Task/reminder responses do not include source_mode. Missing meeting metadata
  // must not make a synthetic task look like a confirmed real-world result.
  const source = !meeting
    ? "unknown"
    : meeting.source_mode === "demo"
      ? "demo"
      : null;
  if (!source) return null;
  return (
    <span className={compact ? "sample-text" : "demo-tag"} data-source={source}>
      {source === "unknown"
        ? "Источник не проверен · данные встречи недоступны"
        : compact
          ? "Демо · вымышленные данные"
          : "Вымышленные данные · готовый пример"}
    </span>
  );
}
