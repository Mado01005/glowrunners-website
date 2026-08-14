import {
  getActiveAttendanceSheetName,
  getAttendanceRoster,
  resolveActiveAttendanceSheetName,
  type AttendanceRosterEntry,
} from "@/lib/googleSheets";
import {
  getGateEventSettings,
  listGatePayments,
  listGateWalkIns,
  type GateEventSettings,
} from "@/lib/adminOperations";
import { evaluateRunnerState } from "@/lib/gateRunnerStatus";
import { parseAttendanceSheetDate } from "@/lib/attendanceSheetDate";
import {
  listEventParticipants,
  listPostRunEvents,
} from "@/lib/postRunEvents";

const DASHBOARD_CACHE_TTL_MS = 15_000;
const DASHBOARD_STALE_TTL_MS = 5 * 60_000;

let dashboardCache:
  | { loadedAt: number; value: GateDashboardData }
  | undefined;
let dashboardRequest: Promise<GateDashboardData> | undefined;

export type GateRosterEntry = AttendanceRosterEntry & Readonly<{
  source: "attendance" | "walk-in" | "post-run";
  paymentStatus: string;
  checkedIn: boolean;
  eventId?: string;
  participantId?: string;
}>;

export type GateDashboardData = Readonly<{
  sheetName: string;
  isFallbackSheet: boolean;
  walkInCount: number;
  confirmed: number;
  pending: number;
  total: number;
  cashInHand: number;
  digitalRevenue: number;
  changeOwed: number;
  owedRunnerRows: readonly number[];
  roster: GateRosterEntry[];
  eventSettings: GateEventSettings | null;
}>;

function isCashPayment(method: string): boolean {
  return method
    .trim()
    .toLocaleLowerCase("en-US") === "cash";
}

export function emptyGateDashboard(
  sheetName = getActiveAttendanceSheetName(),
): GateDashboardData {
  return {
    sheetName,
    isFallbackSheet: false,
    walkInCount: 0,
    confirmed: 0,
    pending: 0,
    total: 0,
    cashInHand: 0,
    digitalRevenue: 0,
    changeOwed: 0,
    owedRunnerRows: [],
    roster: [],
    eventSettings: null,
  };
}

export function isMissingAttendanceDataError(error: unknown): boolean {
  const message = (
    error instanceof Error ? error.message : String(error)
  ).toLocaleLowerCase("en-US");

  return [
    "unable to parse range",
    "requested entity was not found",
    "sheet not found",
    "no grid with id",
    "does not exist",
  ].some((fragment) => message.includes(fragment));
}

export function isRateLimitedSheetsError(error: unknown): boolean {
  const message = (
    error instanceof Error ? error.message : String(error)
  ).toLocaleLowerCase("en-US");

  return (
    message.includes("quota exceeded") ||
    message.includes("rate limit") ||
    message.includes("status 429")
  );
}

export function invalidateGateDashboardCache(): void {
  dashboardCache = undefined;
  dashboardRequest = undefined;
}

async function loadGateDashboardData(): Promise<GateDashboardData> {
  const { sheetName, isFallback } = await resolveActiveAttendanceSheetName();
  const [attendanceRoster, payments, walkIns, eventSettings, postRunEvents] = await Promise.all([
    getAttendanceRoster(sheetName),
    listGatePayments(sheetName),
    listGateWalkIns(sheetName),
    getGateEventSettings(sheetName).catch((error: unknown) => {
      console.warn(
        JSON.stringify({
          level: "warn",
          message: "Gate event settings are unavailable; using defaults.",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return null;
    }),
    listPostRunEvents().catch((error: unknown) => {
      console.warn(
        JSON.stringify({
          level: "warn",
          message: "Post-run participants are unavailable to Gate Control.",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return [];
    }),
  ]);
  const attendanceDate = parseAttendanceSheetDate(sheetName, new Date());
  const activeDate =
    eventSettings?.eventDate || attendanceDate?.toISOString().slice(0, 10) || "";
  const activePostRunEvents = postRunEvents.filter(
    (event) => event.associatedDate === activeDate,
  );
  const postRunParticipantGroups = await Promise.all(
    activePostRunEvents.map(async (event) => ({
      event,
      participants: await listEventParticipants(event.id).catch(
        (error: unknown) => {
          console.warn(
            JSON.stringify({
              level: "warn",
              message: `Unable to merge participants for ${event.title}.`,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
          return [];
        },
      ),
    })),
  );
  const normalizedContact = (value: string) => {
    const clean = value.trim().replace(/^'/, "").trim();

    if (clean.startsWith("@") || /[a-z._-]/i.test(clean)) {
      return clean.toLocaleLowerCase("en-US");
    }

    return clean.replace(/\D/g, "").replace(/^20/, "").replace(/^0+/, "");
  };
  const identityKey = (name: string, contact: string) => {
    const normalized = normalizedContact(contact);
    return normalized
      ? `contact:${normalized}`
      : `name:${name.trim().toLocaleLowerCase("en-US")}`;
  };
  const mergedByIdentity = new Map<string, GateRosterEntry>();

  for (const runner of attendanceRoster) {
    mergedByIdentity.set(identityKey(runner.name, runner.phone), {
      ...runner,
      source: "attendance",
      paymentStatus: runner.status,
      checkedIn: evaluateRunnerState(runner).isConfirmed,
    });
  }

  for (const [index, walkIn] of walkIns.entries()) {
    const runner: GateRosterEntry = {
      rowIndex: -1 - index,
      name: walkIn.name,
      phone: walkIn.phone,
      paymentType: walkIn.paymentMethod,
      status: "CONFIRMED",
      paymentStatus: "CONFIRMED",
      checkedIn: true,
      amountPaid: walkIn.amountPaidEgp,
      balanceOwed: 0,
      source: "walk-in",
    };
    const key = identityKey(runner.name, runner.phone);
    const existing = mergedByIdentity.get(key);

    mergedByIdentity.set(
      key,
      existing
        ? {
            ...existing,
            status: "CONFIRMED",
            paymentStatus: "CONFIRMED",
            checkedIn: true,
            amountPaid: Math.max(existing.amountPaid, runner.amountPaid),
            balanceOwed: 0,
          }
        : runner,
    );
  }

  let postRunIndex = -100_000;
  for (const { event, participants } of postRunParticipantGroups) {
    for (const participant of participants) {
      const paymentStatus =
        participant.settlementStatus === "Free"
          ? "FREE"
          : participant.settlementStatus === "Fully Cleared"
            ? "CLEARED"
            : participant.depositAmountPaidEgp > 0
              ? "DEPOSIT_PAID"
              : "UNPAID";
      const isParticipantConfirmed =
        participant.checkedIn === true ||
        participant.settlementStatus === "Free" ||
        participant.settlementStatus === "Fully Cleared";
      const runner: GateRosterEntry = {
        rowIndex: postRunIndex,
        name: participant.name,
        phone: participant.whatsappPhone,
        paymentType: `Post-Run · ${event.title}`,
        status: paymentStatus,
        paymentStatus,
        checkedIn: isParticipantConfirmed,
        amountPaid: participant.depositAmountPaidEgp,
        balanceOwed: participant.remainingBalanceEgp,
        source: "post-run",
        eventId: event.id,
        participantId: participant.id,
      };

      postRunIndex -= 1;
      const key = identityKey(runner.name, runner.phone);

      if (!mergedByIdentity.has(key)) {
        mergedByIdentity.set(key, runner);
      }
    }
  }

  const roster = [...mergedByIdentity.values()];
  const confirmedRows = new Set(
    roster
      .filter((runner) => evaluateRunnerState(runner).isConfirmed)
      .map((runner) => runner.rowIndex),
  );
  const rosterStateSummary = roster.reduce(
    (summary, runner) => {
      const state = evaluateRunnerState(runner);
      return {
        confirmed: summary.confirmed + Number(state.isConfirmed),
      };
    },
    { confirmed: 0 },
  );
  const seenPaymentRows = new Set<number>();
  const confirmedPayments = payments.filter((payment) => {
    if (
      !confirmedRows.has(payment.runnerRow) ||
      seenPaymentRows.has(payment.runnerRow)
    ) {
      return false;
    }

    seenPaymentRows.add(payment.runnerRow);
    return true;
  });
  const cashInHand = confirmedPayments.reduce(
    (sum, payment) =>
      sum +
      (isCashPayment(payment.paymentMethod)
        ? payment.amountReceivedEgp
        : 0),
    walkIns.reduce(
      (sum, walkIn) =>
        sum +
        (isCashPayment(walkIn.paymentMethod) ? walkIn.amountPaidEgp : 0),
      0,
    ),
  );
  const digitalRevenue = confirmedPayments.reduce(
    (sum, payment) =>
      sum +
      (isCashPayment(payment.paymentMethod)
        ? 0
        : payment.amountReceivedEgp),
    walkIns.reduce(
      (sum, walkIn) =>
        sum +
        (isCashPayment(walkIn.paymentMethod) ? 0 : walkIn.amountPaidEgp),
      0,
    ),
  );
  const changeOwed = confirmedPayments.reduce(
    (sum, payment) => sum + payment.changeOwedEgp,
    walkIns.reduce((sum, walkIn) => sum + walkIn.changeOwedEgp, 0),
  );
  const owedRunnerRows = [
    ...new Set(
      confirmedPayments
        .filter((payment) => payment.changeOwedEgp > 0)
        .map((payment) => payment.runnerRow),
    ),
  ];

  return {
    sheetName,
    isFallbackSheet: isFallback,
    walkInCount: walkIns.length,
    confirmed: rosterStateSummary.confirmed,
    pending: Math.max(0, roster.length - rosterStateSummary.confirmed),
    total: roster.length,
    cashInHand,
    digitalRevenue,
    changeOwed,
    owedRunnerRows,
    roster,
    eventSettings,
  };
}

export async function getGateDashboardData(): Promise<GateDashboardData> {
  const now = Date.now();

  if (
    dashboardCache &&
    now - dashboardCache.loadedAt < DASHBOARD_CACHE_TTL_MS
  ) {
    return dashboardCache.value;
  }

  if (!dashboardRequest) {
    dashboardRequest = loadGateDashboardData()
      .then((value) => {
        dashboardCache = { loadedAt: Date.now(), value };
        return value;
      })
      .catch((error: unknown) => {
        if (
          dashboardCache &&
          Date.now() - dashboardCache.loadedAt < DASHBOARD_STALE_TTL_MS &&
          isRateLimitedSheetsError(error)
        ) {
          return dashboardCache.value;
        }

        throw error;
      })
      .finally(() => {
        dashboardRequest = undefined;
      });
  }

  return dashboardRequest;
}
