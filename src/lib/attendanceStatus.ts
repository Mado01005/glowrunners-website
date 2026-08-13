import { evaluateRunnerState } from "@/lib/gateRunnerStatus";

export function isConfirmedAttendanceStatus(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }

  return evaluateRunnerState({ status: value }).isConfirmed;
}
