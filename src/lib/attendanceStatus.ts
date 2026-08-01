const CONFIRMED_LABEL_PATTERN = /^✅\s*confirmed$/iu;
const CHECKED_CHECKBOX_PATTERN = /^\[\s*x\s*\]$/iu;

export function isConfirmedAttendanceStatus(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }

  const status = value.trim();

  return (
    CONFIRMED_LABEL_PATTERN.test(status) ||
    CHECKED_CHECKBOX_PATTERN.test(status)
  );
}
