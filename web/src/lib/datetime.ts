const UTC8 = "Asia/Shanghai";

/** Numeric values are Unix seconds; timezone-less legacy server dates are UTC. */
export function parseServerDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === "number") return new Date(value * 1000);
  if (typeof value !== "string" || !value.trim()) return new Date(NaN);
  const raw = value.trim().replace(" ", "T");
  return new Date(/(?:Z|[+-]\d\d:?\d\d)$/i.test(raw) ? raw : `${raw}Z`);
}

export function formatUtc8Time(value: unknown): string {
  const date = parseServerDate(value);
  if (Number.isNaN(date.getTime())) return "—";
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: UTC8, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find(part => part.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}
