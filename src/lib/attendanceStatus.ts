const CONFIRMED_LABEL_PATTERN = /^✅\s*confirmed$/iu;
const CHECKED_CHECKBOX_PATTERN = /^\[\s*x\s*\]$/iu;
const CONFIRMED_STATUS_ALIASES = new Set([
  "CONFIRMED",
  "CLEARED",
  "PAID",
]);

export function isConfirmedAttendanceStatus(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }

  const status = value.trim();
  const normalizedStatus = status.toLocaleUpperCase("en-US");

  return (
    CONFIRMED_LABEL_PATTERN.test(status) ||
    CHECKED_CHECKBOX_PATTERN.test(status) ||
    CONFIRMED_STATUS_ALIASES.has(normalizedStatus)
  );
}
