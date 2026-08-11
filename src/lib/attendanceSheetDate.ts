export type AttendanceSheetMetadata = Readonly<{
  title: string;
  index?: number | null;
  hidden?: boolean | null;
  sheetType?: string | null;
}>;

export type ResolvedAttendanceDate = Readonly<{
  date: string;
  sheetName: string;
}>;

const ATTENDANCE_SHEET_PATTERN =
  /^attendance\s*-\s*(tuesday|friday)\s*-\s*(\d{1,2})(?:st|nd|rd|th)?\s+of\s+([a-z]+)\s*$/i;
const MONTH_INDEX_BY_NAME = new Map(
  Array.from({ length: 12 }, (_, monthIndex) => [
    new Date(Date.UTC(2024, monthIndex, 1))
      .toLocaleString("en-US", { month: "long", timeZone: "UTC" })
      .toLocaleLowerCase("en-US"),
    monthIndex,
  ]),
);

export function parseAttendanceSheetDate(
  sheetName: string,
  referenceDate: Date,
): Date | null {
  const match = sheetName.trim().match(ATTENDANCE_SHEET_PATTERN);

  if (!match) {
    return null;
  }

  const weekday = match[1].toLocaleLowerCase("en-US");
  const day = Number(match[2]);
  const monthIndex = MONTH_INDEX_BY_NAME.get(
    match[3].toLocaleLowerCase("en-US"),
  );

  if (monthIndex === undefined) {
    return null;
  }

  const expectedWeekday = weekday === "tuesday" ? 2 : 5;
  const candidates = [-1, 0, 1].flatMap((yearOffset) => {
    const candidate = new Date(
      Date.UTC(referenceDate.getUTCFullYear() + yearOffset, monthIndex, day, 12),
    );

    return candidate.getUTCMonth() === monthIndex &&
      candidate.getUTCDate() === day &&
      candidate.getUTCDay() === expectedWeekday
      ? [candidate]
      : [];
  });

  return (
    candidates.sort(
      (left, right) =>
        Math.abs(left.getTime() - referenceDate.getTime()) -
        Math.abs(right.getTime() - referenceDate.getTime()),
    )[0] ?? null
  );
}

function toIsoDate(date: Date): string {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

export function selectLatestAttendanceDate(
  sheets: readonly AttendanceSheetMetadata[],
  referenceDate: Date,
): ResolvedAttendanceDate | null {
  const matches = sheets.flatMap((sheet) => {
    if (sheet.hidden === true || (sheet.sheetType && sheet.sheetType !== "GRID")) {
      return [];
    }

    const eventDate = parseAttendanceSheetDate(sheet.title, referenceDate);
    return eventDate ? [{ sheet, eventDate }] : [];
  });
  const selected = matches.sort(
    (left, right) =>
      right.eventDate.getTime() - left.eventDate.getTime() ||
      (right.sheet.index ?? 0) - (left.sheet.index ?? 0),
  )[0];

  return selected
    ? {
        date: toIsoDate(selected.eventDate),
        sheetName: selected.sheet.title,
      }
    : null;
}
