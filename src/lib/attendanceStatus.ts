import { evaluateRunnerState, parseCheckedInCell } from "@/lib/gateRunnerStatus";

export function isConfirmedAttendanceStatus(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }

  if (parseCheckedInCell(value)) {
    return true;
  }

  return evaluateRunnerState({ status: value }).isConfirmed;
}

