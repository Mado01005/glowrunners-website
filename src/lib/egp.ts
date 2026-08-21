export function sanitizeEGP(
  value: number | string | undefined | null,
): number {
  const parsed =
    typeof value === "string"
      ? Number.parseFloat(value.replace(/[^\d.-]/g, ""))
      : Number(value);

  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}
