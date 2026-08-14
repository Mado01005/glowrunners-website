"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type { Html5Qrcode } from "html5-qrcode";
import { evaluateRunnerState } from "@/lib/gateRunnerStatus";
import { findRunnerFromQrPayload } from "@/lib/gateQrPayload";

type RosterEntry = Readonly<{
  rowIndex: number;
  name: string;
  phone: string;
  paymentType: string;
  status: string;
  amountPaid: number;
  balanceOwed: number;
  paymentStatus: string;
  checkedIn: boolean;
  source: "attendance" | "walk-in" | "post-run";
  eventId?: string;
  participantId?: string;
}>;

type CameraOption = Readonly<{ id: string; label: string }>;

type GateEventSettings = Readonly<{
  title: string;
  eventDate: string;
  eventTime: string;
  location: string;
}>;

type Dashboard = Readonly<{
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
  roster: readonly RosterEntry[];
  eventSettings: GateEventSettings | null;
}>;

type ActiveAdmin = Readonly<{
  id: string;
  displayName: string;
  phoneE164: string;
  role: string;
}>;

type RunnerLock = Readonly<{
  id: string;
  runnerKey: string;
  sheetName: string;
  runnerRow: number;
  runnerName: string;
  runnerPhone: string;
  adminName: string;
  adminPhone: string;
  expiresAt: string;
}>;

type Activity = Readonly<{
  id: string;
  adminName: string;
  adminPhone: string;
  actionType: string;
  description: string;
  timestamp: string;
}>;

type Expense = Readonly<{
  id: string;
  description: string;
  amountEgp: number;
  paymentMethod: string;
  adminName: string;
  timestamp: string;
}>;

type PaymentDraft = Readonly<{
  runner: RosterEntry;
  lockId: string | null;
  paymentMethod: "Cash" | "InstaPay";
  amountReceived: string;
}>;

type OfflineCheckIn = Readonly<{
  operationId: string;
  phone: string;
  runnerName: string;
  runnerRow: number;
  paymentMethod: string;
  amountDue: number;
  amountReceived: number;
  changeOwed: number;
  createdAt: string;
  lastError?: string;
}>;

type WalkIn = Readonly<{
  id: string;
  sheetName: string;
  name: string;
  phone: string;
  paymentMethod: "Cash" | "InstaPay";
  amountReceived: number;
  changeOwed: number;
  createdAt: string;
}>;

type RosterFilter = "total" | "confirmed" | "pending" | "owed";
type RunnerStatusDraft =
  | "CONFIRMED"
  | "DEPOSIT_PAID"
  | "PENDING"
  | "OWED"
  | "FREE";
type RunnerEditDraft = {
  rowIndex: number;
  expectedName: string;
  expectedPhone: string;
  name: string;
  phone: string;
  paymentType: string;
  status: RunnerStatusDraft;
  amountPaid: string;
  balanceOwed: string;
  amountReceived: string;
};

type Feedback = Readonly<{
  tone: "idle" | "success" | "error";
  message: string;
}>;

const INITIAL_DASHBOARD: Dashboard = {
  sheetName: "Loading attendance…",
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

const SCANNER_ID = "glowrunners-gate-scanner";
const SESSION_STORAGE_KEY = "glowrunners.admin.identity.v1";
const OFFLINE_QUEUE_KEY = "glowrunners.admin.offline-checkins.v1";
const GATE_ROSTER_SYNC_CHANNEL = "glowrunners-gate-roster-v1";
const ENTRY_FEE_EGP = 70;
const WALK_IN_FEE_EGP = ENTRY_FEE_EGP;

const moneyFormatter = new Intl.NumberFormat("en-EG", {
  maximumFractionDigits: 0,
});
const localTimeFormatter = new Intl.DateTimeFormat("en-EG", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Africa/Cairo",
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readError(value: unknown, fallback: string): string {
  return isRecord(value) && typeof value.error === "string"
    ? value.error
    : fallback;
}

function money(value: number): string {
  return `${moneyFormatter.format(Math.max(0, value))} EGP`;
}

function signedMoney(value: number): string {
  return `${moneyFormatter.format(value)} EGP`;
}

function normalizePhone(value: string): string {
  let digits = value.replace(/\D/g, "").replace(/^0+/, "");

  if (digits.startsWith("20")) {
    digits = digits.slice(2).replace(/^0+/, "");
  }

  return digits;
}

function isConfirmed(runner: RosterEntry): boolean {
  return evaluateRunnerState(runner).isConfirmed;
}

function summarizeRosterCounters(roster: readonly RosterEntry[]) {
  const total = roster.length;
  const confirmed = roster.filter(isConfirmed).length;

  return {
    total,
    confirmed,
    pending: Math.max(0, total - confirmed),
  };
}

function runnerStatusDraft(status: string): RunnerStatusDraft {
  const normalized = status.trim().toLocaleUpperCase("en-US");

  if (evaluateRunnerState({ status }).isConfirmed) {
    return "CONFIRMED";
  }

  if (normalized === "FREE") {
    return "FREE";
  }

  if (normalized === "OWED") {
    return "OWED";
  }

  if (normalized.includes("DEPOSIT")) {
    return "DEPOSIT_PAID";
  }

  return "PENDING";
}



function parseRoster(value: unknown): RosterEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((candidate) => {
    if (!isRecord(candidate)) {
      return [];
    }

    const rowIndex = Number(candidate.rowIndex);
    const name =
      typeof candidate.name === "string" ? candidate.name.trim() : "";
    const phone =
      typeof candidate.phone === "string" ? candidate.phone.trim() : "";

    if (!Number.isSafeInteger(rowIndex) || rowIndex < 1 || !name) {
      return [];
    }

    return [
      {
        rowIndex,
        name: name.slice(0, 100),
        phone: phone.slice(0, 80),
        paymentType:
          typeof candidate.paymentType === "string"
            ? candidate.paymentType.trim().slice(0, 40)
            : "Unknown",
        status:
          typeof candidate.status === "string"
            ? candidate.status.trim().slice(0, 40)
            : "",
        amountPaid: Math.max(0, Number(candidate.amountPaid) || 0),
        balanceOwed: Math.max(0, Number(candidate.balanceOwed) || 0),
        paymentStatus:
          typeof candidate.paymentStatus === "string"
            ? candidate.paymentStatus.trim().slice(0, 40)
            : typeof candidate.status === "string"
              ? candidate.status.trim().slice(0, 40)
              : "",
        checkedIn: candidate.checkedIn === true,
        source:
          candidate.source === "walk-in" || candidate.source === "post-run"
            ? candidate.source
            : "attendance",
        eventId:
          typeof candidate.eventId === "string" ? candidate.eventId : undefined,
        participantId:
          typeof candidate.participantId === "string"
            ? candidate.participantId
            : undefined,
      },
    ];
  });
}

function parseDashboard(value: unknown): Dashboard | null {
  if (!isRecord(value) || value.success !== true) {
    return null;
  }

  const number = (...keys: string[]) => {
    for (const key of keys) {
      const parsed = Number(value[key]);

      if (Number.isFinite(parsed)) {
        return Math.max(0, parsed);
      }
    }

    return 0;
  };

  return {
    sheetName:
      typeof value.sheetName === "string"
        ? value.sheetName
        : "Attendance",
    isFallbackSheet: value.isFallbackSheet === true,
    walkInCount: number("walk_in_count", "walkInCount"),
    confirmed: number("confirmed", "confirmedCount"),
    pending: number("pending", "pendingCount"),
    total: number("total", "totalCount"),
    cashInHand: number("cash_in_hand", "cashInHand"),
    digitalRevenue: number("digital_revenue", "digitalRevenue"),
    changeOwed: number("change_owed", "changeOwed"),
    owedRunnerRows: Array.isArray(value.owedRunnerRows)
      ? value.owedRunnerRows
          .map(Number)
          .filter(
            (rowIndex) =>
              Number.isSafeInteger(rowIndex) && rowIndex > 0,
          )
      : [],
    roster: parseRoster(value.roster),
    eventSettings:
      isRecord(value.eventSettings) &&
      typeof value.eventSettings.title === "string" &&
      typeof value.eventSettings.eventDate === "string" &&
      typeof value.eventSettings.eventTime === "string" &&
      typeof value.eventSettings.location === "string"
        ? {
            title: value.eventSettings.title,
            eventDate: value.eventSettings.eventDate,
            eventTime: value.eventSettings.eventTime,
            location: value.eventSettings.location,
          }
        : null,
  };
}

function parseStoredArray<T>(
  key: string,
  validator: (value: unknown) => T | null,
): T[] {
  try {
    const stored = window.localStorage.getItem(key);
    const parsed: unknown = stored ? JSON.parse(stored) : [];

    return Array.isArray(parsed)
      ? parsed
          .map(validator)
          .filter((value): value is T => value !== null)
          .slice(0, 5_000)
      : [];
  } catch {
    return [];
  }
}

function parseOfflineCheckIn(value: unknown): OfflineCheckIn | null {
  if (
    !isRecord(value) ||
    typeof value.operationId !== "string" ||
    typeof value.phone !== "string" ||
    typeof value.runnerName !== "string" ||
    !Number.isFinite(Number(value.runnerRow))
  ) {
    return null;
  }

  return {
    operationId: value.operationId.slice(0, 140),
    phone: normalizePhone(value.phone),
    runnerName: value.runnerName.slice(0, 100),
    runnerRow: Number(value.runnerRow),
    paymentMethod:
      typeof value.paymentMethod === "string" ? value.paymentMethod : "Cash",
    amountDue: Math.max(0, Number(value.amountDue) || 0),
    amountReceived: Math.max(0, Number(value.amountReceived) || 0),
    changeOwed: Math.max(0, Number(value.changeOwed) || 0),
    createdAt:
      typeof value.createdAt === "string"
        ? value.createdAt
        : new Date().toISOString(),
    lastError:
      typeof value.lastError === "string" ? value.lastError.slice(0, 200) : undefined,
  };
}

function parseWalkIn(value: unknown): WalkIn | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.sheetName !== "string" ||
    typeof value.name !== "string" ||
    typeof value.phone !== "string"
  ) {
    return null;
  }

  return {
    id: value.id.slice(0, 100),
    sheetName: value.sheetName.trim().slice(0, 120),
    name: value.name.trim().slice(0, 100),
    phone: normalizePhone(value.phone),
    paymentMethod: value.paymentMethod === "InstaPay" ? "InstaPay" : "Cash",
    amountReceived: Math.max(
      0,
      Number(value.amountReceived ?? value.amountPaidEgp) || 0,
    ),
    changeOwed: Math.max(
      0,
      Number(value.changeOwed ?? value.changeOwedEgp) || 0,
    ),
    createdAt:
      typeof value.createdAt === "string"
        ? value.createdAt
        : typeof value.timestamp === "string"
          ? value.timestamp
          : new Date().toISOString(),
  };
}

function ordinal(day: number): string {
  if (day >= 11 && day <= 13) {
    return `${day}TH`;
  }

  return `${day}${
    day % 10 === 1
      ? "ST"
      : day % 10 === 2
        ? "ND"
        : day % 10 === 3
          ? "RD"
          : "TH"
  }`;
}

function eventDateLabels(sheetName: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "Africa/Cairo",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  });
  const parts = formatter.formatToParts(new Date());
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const monthIndex =
    Number(parts.find((part) => part.type === "month")?.value) - 1;
  const localDay = Number(parts.find((part) => part.type === "day")?.value);
  const localNoonUtc = new Date(Date.UTC(year, monthIndex, localDay, 12));
  const localWeekday = localNoonUtc.getUTCDay();
  const daysUntilTuesday = (2 - localWeekday + 7) % 7;
  const daysUntilFriday = (5 - localWeekday + 7) % 7;
  const eventDate = new Date(localNoonUtc);

  eventDate.setUTCDate(
    localNoonUtc.getUTCDate() + Math.min(daysUntilTuesday, daysUntilFriday),
  );

  const sheetMatch = sheetName.match(
    /^attendance\s*-\s*(tuesday|friday)\s*-\s*(\d{1,2})(?:st|nd|rd|th)?\s+of\s+([a-z]+)\s*$/i,
  );
  const fallbackWeekday = eventDate.toLocaleString("en-US", {
    weekday: "long",
    timeZone: "UTC",
  });
  const weekday = sheetMatch
    ? `${sheetMatch[1][0].toUpperCase()}${sheetMatch[1].slice(1).toLowerCase()}`
    : fallbackWeekday;
  const month = sheetMatch
    ? `${sheetMatch[3][0].toUpperCase()}${sheetMatch[3].slice(1).toLowerCase()}`
    : eventDate.toLocaleString("en-US", {
        month: "long",
        timeZone: "UTC",
      });
  const day = sheetMatch ? Number(sheetMatch[2]) : eventDate.getUTCDate();
  const ordinalSuffix = ordinal(day)
    .slice(String(day).length)
    .toLocaleLowerCase("en-US");

  const parsedEventDate = new Date(`${month} ${day}, ${year} 12:00:00 UTC`);
  const resolvedEventDate = Number.isNaN(parsedEventDate.getTime())
    ? localNoonUtc
    : parsedEventDate;

  return {
    badge: `${weekday.slice(0, 3).toUpperCase()} - ${ordinal(day)} OF ${month.toUpperCase()}`,
    day: weekday,
    kickoff: "",
    location: "",
    report: `${weekday} ${day}${ordinalSuffix} ${month}`,
    eventDate: resolvedEventDate.toISOString().slice(0, 10),
    title: `GlowRunners ${weekday.toUpperCase()}`,
  };
}


function formatEventTime(value: string): string {
  const match = value.match(/^(\d{2}):(\d{2})$/);

  if (!match) {
    return value;
  }

  const hour = Number(match[1]);
  const suffix = hour >= 12 ? "PM" : "AM";
  return `${hour % 12 || 12}:${match[2]} ${suffix}`;
}

function displayContact(value: string): string {
  if (!value.trim()) {
    return "No contact";
  }

  if (value.startsWith("@") || value.startsWith("+")) {
    return value;
  }

  return /^\d+$/.test(value) ? `0${value}` : value;
}

function playScanSuccessBeep() {
  navigator.vibrate?.(80);

  try {
    const AudioContextClass = window.AudioContext ||
      (window as typeof window & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioContextClass) return;
    const context = new AudioContextClass();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.08, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.12);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.12);
    oscillator.addEventListener("ended", () => void context.close(), { once: true });
  } catch {
    // Visual confirmation remains available when audio is blocked.
  }
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

async function stopScanner(scanner: Html5Qrcode): Promise<void> {
  try {
    if (scanner.isScanning) {
      await scanner.stop();
    }
  } catch {
    // Cleanup remains best effort when browser camera state changes.
  }

  try {
    scanner.clear();
  } catch {
    // The scanner DOM may already be gone during navigation.
  }
}

export function GateControlDashboard() {
  const [dashboard, setDashboard] = useState<Dashboard>(INITIAL_DASHBOARD);
  const [activeAdmin, setActiveAdmin] = useState<ActiveAdmin | null>(null);
  const [feedback, setFeedback] = useState<Feedback>({
    tone: "idle",
    message: "Ready for gate operations.",
  });
  const [isRefreshing, setIsRefreshing] = useState(true);
  const [search, setSearch] = useState("");
  const [rosterFilter, setRosterFilter] =
    useState<RosterFilter>("total");
  const [locks, setLocks] = useState<RunnerLock[]>([]);
  const [paymentDraft, setPaymentDraft] = useState<PaymentDraft | null>(
    null,
  );
  const [isPaymentSubmitting, setIsPaymentSubmitting] = useState(false);
  const [isScannerEnabled, setIsScannerEnabled] = useState(false);
  const [scannerStatus, setScannerStatus] = useState<
    "idle" | "starting" | "live" | "error"
  >("idle");
  const [scannerKey, setScannerKey] = useState(0);
  const [cameraOptions, setCameraOptions] = useState<CameraOption[]>([]);
  const [selectedCameraId, setSelectedCameraId] = useState("");
  const [isScanSuccess, setIsScanSuccess] = useState(false);
  const [quickCheckIn, setQuickCheckIn] = useState("");
  const [offlineQueue, setOfflineQueue] = useState<OfflineCheckIn[]>([]);

  const [activities, setActivities] = useState<Activity[]>([]);
  const [isActivityOpen, setIsActivityOpen] = useState(false);
  const [isActivityLoading, setIsActivityLoading] = useState(false);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [postRunSignups, setPostRunSignups] = useState(0);
  const [walkInName, setWalkInName] = useState("");
  const [walkInPhone, setWalkInPhone] = useState("");
  const [walkInMethod, setWalkInMethod] =
    useState<"Cash" | "InstaPay">("Cash");
  const [walkInAmount, setWalkInAmount] = useState(
    String(WALK_IN_FEE_EGP),
  );
  const [expenseDescription, setExpenseDescription] = useState("");
  const [expenseAmount, setExpenseAmount] = useState("");
  const [expenseMethod, setExpenseMethod] =
    useState<"Cash" | "Digital">("Cash");
  const [isExpenseSaving, setIsExpenseSaving] = useState(false);
  const [isWalkInSaving, setIsWalkInSaving] = useState(false);
  const [isEventSettingsOpen, setIsEventSettingsOpen] = useState(false);
  const [eventSettingsDraft, setEventSettingsDraft] =
    useState<GateEventSettings>({
      title: "",
      eventDate: "",
      eventTime: "",
      location: "",
    });
  const [runnerEditDraft, setRunnerEditDraft] =
    useState<RunnerEditDraft | null>(null);
  const [isEventSettingsSaving, setIsEventSettingsSaving] = useState(false);
  const [isRunnerSaving, setIsRunnerSaving] = useState(false);
  const syncInFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const scanHandlerRef = useRef<(decoded: string) => void>(() => undefined);
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const scanResumeTimerRef = useRef<number | null>(null);
  const lastScannedRef = useRef<{ value: string; at: number }>({
    value: "",
    at: 0,
  });
  const dateLabels = useMemo(
    () => eventDateLabels(dashboard.sheetName),
    [dashboard.sheetName],
  );
  const eventSettings = dashboard.eventSettings ?? {
    title: dateLabels.title,
    eventDate: dateLabels.eventDate,
    eventTime: dateLabels.kickoff,
    location: dateLabels.location,
  };

  const eventDateDisplay = useMemo(() => {
    const parsed = new Date(`${eventSettings.eventDate}T12:00:00`);

    if (Number.isNaN(parsed.getTime())) {
      return { badge: dateLabels.badge, day: dateLabels.day };
    }

    return {
      badge: new Intl.DateTimeFormat("en-US", {
        weekday: "short",
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "Africa/Cairo",
      })
        .format(parsed)
        .toLocaleUpperCase("en-US"),
      day: new Intl.DateTimeFormat("en-US", {
        weekday: "long",
        timeZone: "Africa/Cairo",
      }).format(parsed),
    };
  }, [dateLabels.badge, dateLabels.day, eventSettings.eventDate]);

  const handleUnauthorized = useCallback((response: Response) => {
    if (response.status !== 401 && response.status !== 403) {
      return false;
    }

    if (response.status === 401) {
      try {
        window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
        window.sessionStorage.removeItem("glowrunners.admin.token.v1");
      } catch {
        // The signed cookie remains the source of truth.
      }
    }

    const next = `${window.location.pathname}${window.location.search}`;
    window.location.assign(`/admin/login?next=${encodeURIComponent(next)}`);
    return true;
  }, []);

  const refreshDashboard = useCallback(async (force = false) => {
    setIsRefreshing(true);

    try {
      const response = await fetch(
        force ? "/api/admin/stats?force=1" : "/api/admin/stats",
        {
          cache: "no-store",
          headers: {
            "Cache-Control": "no-cache, no-store, must-revalidate",
            Pragma: "no-cache",
          },
        },
      );

      const payload = await readJson(response);

      if (handleUnauthorized(response)) {
        return;
      }

      const parsed = parseDashboard(payload);

      if (!response.ok || parsed === null) {
        throw new Error(readError(payload, "Unable to load gate statistics."));
      }

      if (mountedRef.current) {
        if (parsed.sheetName && typeof window !== "undefined") {
          try {
            window.localStorage.setItem("glow_active_sheet_name", parsed.sheetName);
          } catch {
            // ignore localStorage quota errors
          }
        }

        setDashboard((current) => {
          if (parsed.roster.length === 0 && current.roster.length > 0) {
            console.warn("Incoming stats returned 0 roster; retaining active roster state.");
            return {
              ...current,
              eventSettings: parsed.eventSettings ?? current.eventSettings,
              sheetName: parsed.sheetName || current.sheetName,
            };
          }

          if (current.roster.length === 0) {
            return parsed;
          }


          const locallyConfirmedRows = new Set(
            current.roster
              .filter((r) => r.checkedIn || isConfirmed(r))
              .map((r) => r.rowIndex),
          );
          const locallyConfirmedKeys = new Set(
            current.roster
              .filter((r) => r.checkedIn || isConfirmed(r))
              .map(
                (r) =>
                  `${r.name.trim().toLowerCase()}:${normalizePhone(r.phone)}`,
              ),
          );

          const mergedRoster = parsed.roster.map((incoming) => {
            const key = `${incoming.name.trim().toLowerCase()}:${normalizePhone(
              incoming.phone,
            )}`;
            const wasConfirmedLocally =
              locallyConfirmedRows.has(incoming.rowIndex) ||
              locallyConfirmedKeys.has(key);

            if (
              wasConfirmedLocally &&
              !incoming.checkedIn &&
              !isConfirmed(incoming)
            ) {
              return {
                ...incoming,
                checkedIn: true,
                status: "CONFIRMED",
                paymentStatus: "CONFIRMED",
              };
            }
            return incoming;
          });

          const counters = summarizeRosterCounters(mergedRoster);

          return {
            ...parsed,
            roster: mergedRoster,
            confirmed: counters.confirmed,
            pending: counters.pending,
            total: counters.total,
          };
        });
        if (force) {
          const runnerByRow = new Map(
            parsed.roster.map((runner) => [runner.rowIndex, runner]),
          );
          setOfflineQueue((current) =>
            current.filter((item) => {
              const runner = runnerByRow.get(item.runnerRow);
              return runner !== undefined && !isConfirmed(runner);
            }),
          );
        }
        setFeedback((current) =>
          current.tone === "error" &&
          current.message.includes("gate statistics")
            ? {
                tone: "idle",
                message: "Live gate totals restored.",
              }
            : current,
        );
      }

    } catch (error) {
      if (mountedRef.current) {
        setFeedback({
          tone: "error",
          message:
            error instanceof Error
              ? error.message
              : "Unable to load gate statistics.",
        });
      }
    } finally {
      if (mountedRef.current) {
        setIsRefreshing(false);
      }
    }
  }, [handleUnauthorized]);

  const refreshLocks = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/runner-locks", {
        cache: "no-store",
      });
      const payload = await readJson(response);

      if (handleUnauthorized(response)) {
        return;
      }

      if (!response.ok || !isRecord(payload) || !Array.isArray(payload.locks)) {
        return;
      }

      setLocks(
        payload.locks.filter((lock): lock is RunnerLock => {
          return (
            isRecord(lock) &&
            typeof lock.id === "string" &&
            typeof lock.runnerKey === "string" &&
            typeof lock.runnerName === "string" &&
            typeof lock.adminName === "string"
          );
        }),
      );
    } catch {
      // Lock polling is advisory; acquisition still performs the hard check.
    }
  }, [handleUnauthorized]);

  const refreshExpenses = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/expenses", {
        cache: "no-store",
      });
      const payload = await readJson(response);

      if (handleUnauthorized(response)) {
        return;
      }

      if (response.ok && isRecord(payload) && Array.isArray(payload.expenses)) {
        setExpenses(payload.expenses as Expense[]);
      }
    } catch {
      // The financial cards can still render attendance revenue.
    }
  }, [handleUnauthorized]);

  const refreshPostRunSignups = useCallback(async () => {
    try {
      const response = await fetch("/api/events", { cache: "no-store" });
      const payload = await readJson(response);

      if (
        handleUnauthorized(response) ||
        !response.ok ||
        !isRecord(payload) ||
        !Array.isArray(payload.events)
      ) {
        return;
      }

      const eventIds = payload.events.flatMap((event) =>
        isRecord(event) && typeof event.id === "string" ? [event.id] : [],
      );
      const participantResponses = await Promise.all(
        eventIds.map(async (eventId) => {
          const participantResponse = await fetch(
            `/api/events/${encodeURIComponent(eventId)}/participants`,
            {
              cache: "no-store",
              headers: { "Cache-Control": "no-cache" },
            },
          );
          const participantPayload = await readJson(participantResponse);
          return participantResponse.ok &&
            isRecord(participantPayload) &&
            Array.isArray(participantPayload.participants)
            ? participantPayload.participants
            : [];
        }),
      );
      const verified = participantResponses.flat().filter(
        (participant) =>
          isRecord(participant) &&
          (participant.depositStatus === "VERIFIED" ||
            participant.settlementStatus === "FULLY_CLEARED"),
      ).length;

      setPostRunSignups(verified);
    } catch {
      // Report keeps a safe zero when post-run storage is unavailable.
    }
  }, [handleUnauthorized]);

  const loadActivity = useCallback(async () => {
    setIsActivityLoading(true);

    try {
      const response = await fetch("/api/admin/activity?limit=150", {
        cache: "no-store",
      });
      const payload = await readJson(response);

      if (handleUnauthorized(response)) {
        return;
      }

      if (
        !response.ok ||
        !isRecord(payload) ||
        !Array.isArray(payload.activities)
      ) {
        throw new Error(readError(payload, "Unable to load activity."));
      }

      setActivities(payload.activities as Activity[]);
    } catch (error) {
      setFeedback({
        tone: "error",
        message:
          error instanceof Error ? error.message : "Unable to load activity.",
      });
    } finally {
      setIsActivityLoading(false);
    }
  }, [handleUnauthorized]);

  useEffect(() => {
    mountedRef.current = true;
    setOfflineQueue(
      parseStoredArray(OFFLINE_QUEUE_KEY, parseOfflineCheckIn),
    );

    void (async () => {
      try {
        const response = await fetch("/api/auth/session", {
          cache: "no-store",
        });
        const payload = await readJson(response);

        if (handleUnauthorized(response)) {
          return;
        }

        if (
          response.ok &&
          isRecord(payload) &&
          isRecord(payload.admin) &&
          typeof payload.admin.displayName === "string" &&
          typeof payload.admin.phoneE164 === "string"
        ) {
          const admin = payload.admin as ActiveAdmin;
          setActiveAdmin(admin);

          try {
            window.sessionStorage.setItem(
              SESSION_STORAGE_KEY,
              JSON.stringify(admin),
            );
          } catch {
            // UI attribution still works from React state.
          }
        }
      } catch {
        setFeedback({
          tone: "error",
          message: "Unable to confirm the active admin session.",
        });
      }
    })();

    void refreshDashboard();
    void refreshLocks();
    void refreshExpenses();
    void refreshPostRunSignups();

    const dashboardTimer = window.setInterval(() => {
      void refreshDashboard();
    }, 12_000);
    const lockTimer = window.setInterval(() => {
      void refreshLocks();
    }, 15_000);

    return () => {
      mountedRef.current = false;
      window.clearInterval(dashboardTimer);
      window.clearInterval(lockTimer);
    };
  }, [
    handleUnauthorized,
    refreshDashboard,
    refreshExpenses,
    refreshLocks,
    refreshPostRunSignups,
  ]);

  useEffect(() => {
    const refreshMergedRoster = () => void refreshDashboard(true);
    window.addEventListener(
      "glowrunners:gate-roster-changed",
      refreshMergedRoster,
    );
    const channel =
      "BroadcastChannel" in window
        ? new BroadcastChannel(GATE_ROSTER_SYNC_CHANNEL)
        : null;
    channel?.addEventListener("message", refreshMergedRoster);

    return () => {
      window.removeEventListener(
        "glowrunners:gate-roster-changed",
        refreshMergedRoster,
      );
      channel?.close();
    };
  }, [refreshDashboard]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        OFFLINE_QUEUE_KEY,
        JSON.stringify(offlineQueue),
      );
    } catch {
      setFeedback({
        tone: "error",
        message: "This browser could not persist the local check-in queue.",
      });
    }
  }, [offlineQueue]);

  const syncOfflineQueue = useCallback(async () => {
    if (
      syncInFlightRef.current ||
      !navigator.onLine ||
      offlineQueue.length === 0
    ) {
      return;
    }

    syncInFlightRef.current = true;
    let remaining = [...offlineQueue];
    let synced = 0;

    for (const item of offlineQueue) {
      try {
        const response = await fetch("/api/scan-ticket", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(item),
        });
        const payload = await readJson(response);

        if (handleUnauthorized(response)) {
          break;
        }

        if (!response.ok) {
          const message = readError(payload, "Background sync failed.");
          remaining = remaining.map((candidate) =>
            candidate.operationId === item.operationId
              ? { ...candidate, lastError: message }
              : candidate,
          );
          break;
        }

        remaining = remaining.filter(
          (candidate) => candidate.operationId !== item.operationId,
        );
        synced += 1;
      } catch {
        break;
      }
    }

    setOfflineQueue(remaining);
    syncInFlightRef.current = false;

    if (synced > 0) {
      setFeedback({
        tone: "success",
        message: `${synced} locally saved check-in${
          synced === 1 ? "" : "s"
        } synced.`,
      });
      void refreshDashboard();
      void loadActivity();
    }
  }, [
    handleUnauthorized,
    loadActivity,
    offlineQueue,
    refreshDashboard,
  ]);

  useEffect(() => {
    const handleOnline = () => void syncOfflineQueue();
    window.addEventListener("online", handleOnline);
    const timer = window.setInterval(() => {
      void syncOfflineQueue();
    }, 20_000);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.clearInterval(timer);
    };
  }, [offlineQueue.length, syncOfflineQueue]);

  useEffect(() => {
    if (!isActivityOpen) {
      return;
    }

    void loadActivity();
    const timer = window.setInterval(() => void loadActivity(), 10_000);
    return () => window.clearInterval(timer);
  }, [isActivityOpen, loadActivity]);



  const releaseLock = useCallback(
    async (lockId: string | null) => {
      if (!lockId || !navigator.onLine) {
        return;
      }

      try {
        await fetch("/api/admin/runner-locks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "release", lockId }),
        });
      } finally {
        void refreshLocks();
      }
    },
    [refreshLocks],
  );

  const closePayment = useCallback(() => {
    const lockId = paymentDraft?.lockId ?? null;
    setPaymentDraft(null);
    void releaseLock(lockId);
  }, [paymentDraft?.lockId, releaseLock]);

  const confirmPayment = useCallback(async () => {
    if (!paymentDraft || isPaymentSubmitting) {
      return;
    }

    const amountReceived = Number(paymentDraft.amountReceived);

    if (
      !Number.isFinite(amountReceived) ||
      amountReceived < ENTRY_FEE_EGP ||
      amountReceived > 1_000_000
    ) {
      setFeedback({
        tone: "error",
        message: `Amount received must cover ${money(ENTRY_FEE_EGP)}.`,
      });
      return;
    }

    const changeOwed =
      paymentDraft.paymentMethod === "Cash"
        ? Math.max(0, amountReceived - ENTRY_FEE_EGP)
        : 0;
    const item: OfflineCheckIn = {
      operationId: crypto.randomUUID(),
      phone: paymentDraft.runner.phone,
      runnerName: paymentDraft.runner.name,
      runnerRow: paymentDraft.runner.rowIndex,
      paymentMethod: paymentDraft.paymentMethod,
      amountDue: ENTRY_FEE_EGP,
      amountReceived,
      changeOwed,
      createdAt: new Date().toISOString(),
    };
    const lockId = paymentDraft.lockId;
    setIsPaymentSubmitting(true);

    try {
      const response = await fetch("/api/scan-ticket", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache, no-store, must-revalidate",
          Pragma: "no-cache",
        },
        cache: "no-store",
        body: JSON.stringify(item),
      });
      const payload = await readJson(response);

      if (handleUnauthorized(response)) {
        return;
      }

      if (!response.ok) {
        if (response.status >= 500) {
          throw new TypeError(readError(payload, "Server unavailable."));
        }

        throw new Error(readError(payload, "Unable to check in this runner."));
      }

      setFeedback({
        tone: "success",
        message: `${paymentDraft.runner.name} is checked in.`,
      });
      setPaymentDraft(null);
      await releaseLock(lockId);
      await refreshDashboard();
      void loadActivity();
    } catch (error) {
      const retryable = !navigator.onLine || error instanceof TypeError;

      if (retryable) {
        setOfflineQueue((current) => {
          return current.some(
            (candidate) => candidate.operationId === item.operationId,
          )
            ? current
            : [...current, item];
        });
        setDashboard((current) => ({
          ...current,
          roster: current.roster.map((runner) =>
            runner.rowIndex === item.runnerRow
              ? { ...runner, status: "⏳ SAVED LOCALLY" }
              : runner,
          ),
        }));
        setPaymentDraft(null);
        setFeedback({
          tone: "success",
          message: `${item.runnerName} saved locally. Auto-sync will run when the connection returns.`,
        });
        await releaseLock(lockId);
      } else {
        setFeedback({
          tone: "error",
          message:
            error instanceof Error
              ? error.message
              : "Unable to check in this runner.",
        });
      }
    } finally {
      setIsPaymentSubmitting(false);
    }
  }, [
    handleUnauthorized,
    isPaymentSubmitting,
    loadActivity,
    paymentDraft,
    refreshDashboard,
    releaseLock,
  ]);

  const replaceRunnerInDashboard = useCallback((runner: RosterEntry) => {
    setDashboard((current) => {
      const roster = current.roster.map((candidate) =>
        candidate.rowIndex === runner.rowIndex ? runner : candidate,
      );
      const counters = summarizeRosterCounters(roster);

      return {
        ...current,
        roster,
        confirmed: counters.confirmed,
        pending: counters.pending,
        total: counters.total,
      };
    });
  }, []);

  const closeRunnerEditor = useCallback(() => {
    setRunnerEditDraft(null);
    try {
      scannerRef.current?.resume();
    } catch {
      // ignore
    }
  }, []);

  const openRunnerEditor = useCallback((runner: RosterEntry) => {
    if (runner.source !== "attendance") {
      setFeedback({
        tone: "idle",
        message:
          runner.source === "post-run"
            ? `${runner.name} is synced from Post-Run Events. Edit this runner from the Post-Run Events dashboard.`
            : `${runner.name} is stored in the walk-in ledger.`,
      });
      return;
    }

    try {
      scannerRef.current?.pause(true);
    } catch {
      // ignore
    }

    setRunnerEditDraft({
      rowIndex: runner.rowIndex,
      expectedName: runner.name,
      expectedPhone: runner.phone,
      name: runner.name,
      phone: runner.phone,
      paymentType: runner.paymentType,
      status: runnerStatusDraft(runner.status),
      amountPaid: String(runner.amountPaid),
      balanceOwed: String(runner.balanceOwed),
      amountReceived: runner.balanceOwed > 0 ? String(runner.balanceOwed) : "",
    });
  }, []);



  useEffect(() => {
    scanHandlerRef.current = (decoded: string) => {
      const normalizedPayload = decoded.trim();
      const now = Date.now();

      if (
        !normalizedPayload ||
        now - lastScannedRef.current.at < 1_500
      ) {
        return;
      }

      lastScannedRef.current = { value: normalizedPayload, at: now };
      const runner = findRunnerFromQrPayload(dashboard.roster, normalizedPayload);

      if (!runner) {
        setFeedback({
          tone: "error",
          message: "No runner matches this ticket. Refresh the roster and retry.",
        });
        return;
      }

      // Immediately pause camera scanning
      try {
        scannerRef.current?.pause(true);
      } catch {
        // Duplicate protection still applies if this browser cannot pause video.
      }

      playScanSuccessBeep();
      setIsScanSuccess(true);
      window.setTimeout(() => setIsScanSuccess(false), 800);

      // Open Runner Settlement & Edit Pop-Up Modal
      openRunnerEditor(runner);
    };
  }, [dashboard.roster, openRunnerEditor]);


  useEffect(() => {
    if (!isScannerEnabled) {
      setScannerStatus("idle");
      return;
    }

    let cancelled = false;
    let scanner: Html5Qrcode | null = null;

    void (async () => {
      setScannerStatus("starting");

      try {
        const qrLibrary = await import("html5-qrcode");

        if (cancelled) {
          return;
        }

        const cameras = await qrLibrary.Html5Qrcode.getCameras();
        if (cancelled) return;
        const options = cameras.map((camera, index) => ({
          id: camera.id,
          label: camera.label || `Camera ${index + 1}`,
        }));
        setCameraOptions(options);
        const rearCamera = options.find((camera) =>
          /back|rear|environment/i.test(camera.label),
        );
        const resolvedCameraId =
          options.find((camera) => camera.id === selectedCameraId)?.id ||
          rearCamera?.id ||
          options[0]?.id ||
          "";
        if (resolvedCameraId && resolvedCameraId !== selectedCameraId) {
          setSelectedCameraId(resolvedCameraId);
          return;
        }

        scanner = new qrLibrary.Html5Qrcode(SCANNER_ID);
        scannerRef.current = scanner;
        await scanner.start(
          resolvedCameraId || { facingMode: "environment" },
          {
            fps: 10,
            qrbox: (width, height) => {
              const size = Math.max(160, Math.min(width, height, 240));
              return { width: size, height: size };
            },
            aspectRatio: 1,
          },
          (decodedText) => scanHandlerRef.current(decodedText),
          () => undefined,
        );

        if (!cancelled) {
          setScannerStatus("live");
        }
      } catch {
        if (!cancelled) {
          setScannerStatus("error");
          setFeedback({
            tone: "error",
            message:
              "📷 Camera access blocked or unavailable. Please grant camera permission in browser settings, or use the manual search box below.",
          });
        }
      }
    })();

    return () => {
      cancelled = true;

      if (scanner) {
        void stopScanner(scanner);
      }
      if (scannerRef.current === scanner) scannerRef.current = null;
      if (scanResumeTimerRef.current) {
        window.clearTimeout(scanResumeTimerRef.current);
        scanResumeTimerRef.current = null;
      }
    };
  }, [isScannerEnabled, scannerKey, selectedCameraId]);

  const submitQuickCheckIn = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const lookup = quickCheckIn.trim();
    if (!lookup) return;


    const runner = findRunnerFromQrPayload(dashboard.roster, lookup);
    if (!runner) {
      setFeedback({
        tone: "error",
        message: `No runner matches “${lookup}”. Try a full phone number, @username, exact name, or ticket ID.`,
      });
      return;
    }

    setQuickCheckIn("");
    openRunnerEditor(runner);
  };


  const walkInReceivedAmount = Number(walkInAmount);
  const hasValidWalkInAmount =
    Number.isSafeInteger(walkInReceivedAmount) &&
    walkInReceivedAmount >= WALK_IN_FEE_EGP &&
    walkInReceivedAmount <= 1_000_000;
  const walkInChange = hasValidWalkInAmount
    ? walkInReceivedAmount - WALK_IN_FEE_EGP
    : 0;
  const queuedPendingItems = useMemo(() => {
    const confirmedRows = new Set(
      dashboard.roster
        .filter(isConfirmed)
        .map((runner) => runner.rowIndex),
    );
    const uniqueByRow = new Map<number, OfflineCheckIn>();

    for (const item of offlineQueue) {
      if (
        !confirmedRows.has(item.runnerRow) &&
        !uniqueByRow.has(item.runnerRow)
      ) {
        uniqueByRow.set(item.runnerRow, item);
      }
    }

    return [...uniqueByRow.values()];
  }, [dashboard.roster, offlineQueue]);
  const queuedPhones = useMemo(
    () =>
      new Set(
        queuedPendingItems
          .map((item) => normalizePhone(item.phone))
          .filter(Boolean),
      ),
    [queuedPendingItems],
  );
  const effectiveRoster = useMemo(
    () =>
      dashboard.roster.map((runner) =>
        queuedPhones.has(normalizePhone(runner.phone))
          ? {
              ...runner,
              status: "CONFIRMED",
              paymentStatus: "CONFIRMED",
              checkedIn: true,
            }
          : runner,
      ),
    [dashboard.roster, queuedPhones],
  );
  const queuedCash = queuedPendingItems.reduce(
    (sum, item) =>
      sum + (item.paymentMethod === "Cash" ? item.amountReceived : 0),
    0,
  );
  const queuedDigital = queuedPendingItems.reduce(
    (sum, item) =>
      sum + (item.paymentMethod === "Cash" ? 0 : item.amountReceived),
    0,
  );
  const queuedChange = queuedPendingItems.reduce(
    (sum, item) => sum + item.changeOwed,
    0,
  );
  const totalExpenses = expenses.reduce(
    (sum, expense) => sum + Number(expense.amountEgp || 0),
    0,
  );
  const runnerStateSummary = useMemo(
    () =>
      effectiveRoster.reduce(
        (summary, runner) => {
          const state = evaluateRunnerState(runner);
          return {
            owed: summary.owed + Number(state.isOwed),
            free: summary.free + Number(state.isFree),
            paid: summary.paid + (state.isFree ? 0 : state.paid),
            balanceOwed:
              summary.balanceOwed + (state.isOwed ? state.owed : 0),
          };
        },
        {
          owed: 0,
          free: 0,
          paid: 0,
          balanceOwed: 0,
        },
      ),
    [effectiveRoster],
  );
  const rosterCounters = useMemo(
    () => summarizeRosterCounters(effectiveRoster),
    [effectiveRoster],
  );
  const displayedConfirmed = rosterCounters.confirmed;
  const displayedTotal = rosterCounters.total;
  const displayedPending = rosterCounters.pending;
  const displayedCash = dashboard.cashInHand + queuedCash;
  const displayedDigital = dashboard.digitalRevenue + queuedDigital;
  const displayedChange = dashboard.changeOwed + queuedChange + walkInChange;

  const tabFilteredRoster = useMemo(
    () =>
      effectiveRoster.filter((runner) => {
        const state = evaluateRunnerState(runner);

        if (rosterFilter === "confirmed" && !state.isConfirmed) {
          return false;
        }

        if (rosterFilter === "pending" && state.isConfirmed) {
          return false;
        }

        if (rosterFilter === "owed" && !state.isOwed) {
          return false;
        }

        return true;
      }),
    [effectiveRoster, rosterFilter],
  );

  const filteredRoster = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("en-US");
    const phoneQuery = normalizePhone(search);

    return tabFilteredRoster
      .filter(
        (runner) =>
          !query ||
          runner.name.toLocaleLowerCase("en-US").includes(query) ||
          runner.phone.toLocaleLowerCase("en-US").includes(query) ||
          (phoneQuery.length > 0 && runner.phone.includes(phoneQuery)),
      )
      .slice(0, 150);
  }, [search, tabFilteredRoster]);

  const lockByRow = useMemo(() => {
    const map = new Map<number, RunnerLock>();

    for (const lock of locks) {
      map.set(Number(lock.runnerRow), lock);
    }

    return map;
  }, [locks]);

  const handleWalkIn = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = walkInName.trim().slice(0, 100);
    const phone = normalizePhone(walkInPhone);
    const amountReceived = Number(walkInAmount);

    if (!name) {
      setFeedback({
        tone: "error",
        message: "Enter the walk-in runner’s full name.",
      });
      return;
    }

    if (phone && !/^(?:10|11|12|15)\d{8}$/.test(phone)) {
      setFeedback({
        tone: "error",
        message: "Enter a valid Egyptian mobile number or leave it blank.",
      });
      return;
    }

    if (
      !Number.isSafeInteger(amountReceived) ||
      amountReceived < WALK_IN_FEE_EGP ||
      amountReceived > 1_000_000
    ) {
      setFeedback({
        tone: "error",
        message: `Amount received must be a whole number of at least ${money(WALK_IN_FEE_EGP)}.`,
      });
      return;
    }

    const operationId = crypto.randomUUID();
    setIsWalkInSaving(true);

    try {
      const response = await fetch("/api/admin/walk-ins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operationId,
          name,
          phone,
          paymentMethod: walkInMethod,
          amountReceived,
        }),
      });
      const payload = await readJson(response);

      if (handleUnauthorized(response)) {
        return;
      }

      const savedWalkIn =
        isRecord(payload) && isRecord(payload.walkIn)
          ? parseWalkIn(payload.walkIn)
          : null;

      if (!response.ok || savedWalkIn === null) {
        throw new Error(readError(payload, "Unable to save this walk-in."));
      }

      if (savedWalkIn.sheetName === dashboard.sheetName) {
        setDashboard((current) => {
          const nextRowIndex = Math.min(
            -1,
            ...current.roster.map((runner) => runner.rowIndex - 1),
          );
          const roster = [
            ...current.roster,
            {
              rowIndex: nextRowIndex,
              name: savedWalkIn.name,
              phone: savedWalkIn.phone,
              paymentType: savedWalkIn.paymentMethod,
              status: "CONFIRMED",
              paymentStatus: "CONFIRMED",
              checkedIn: true,
              amountPaid: savedWalkIn.amountReceived,
              balanceOwed: 0,
              source: "walk-in" as const,
            },
          ];
          const counters = summarizeRosterCounters(roster);

          return {
            ...current,
            roster,
            walkInCount: current.walkInCount + 1,
            confirmed: counters.confirmed,
            pending: counters.pending,
            total: counters.total,
            cashInHand:
              current.cashInHand +
              (savedWalkIn.paymentMethod === "Cash"
                ? savedWalkIn.amountReceived
                : 0),
            digitalRevenue:
              current.digitalRevenue +
              (savedWalkIn.paymentMethod === "InstaPay"
                ? savedWalkIn.amountReceived
                : 0),
            changeOwed: current.changeOwed + savedWalkIn.changeOwed,
          };
        });
      }

      setWalkInName("");
      setWalkInPhone("");
      setWalkInAmount(String(WALK_IN_FEE_EGP));
      const warning =
        isRecord(payload) && typeof payload.warning === "string"
          ? ` ${payload.warning}`
          : "";
      setFeedback({
        tone: warning ? "error" : "success",
        message: `${name} added as a walk-in. Change owed: ${money(savedWalkIn.changeOwed)}.${warning}`,
      });
      void loadActivity();
    } catch (error) {
      setFeedback({
        tone: "error",
        message:
          error instanceof Error ? error.message : "Unable to add walk-in.",
      });
    } finally {
      setIsWalkInSaving(false);
    }
  };

  const handleExpense = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const description = expenseDescription.trim().slice(0, 240);
    const amountEgp = Number(expenseAmount);

    if (
      !description ||
      !Number.isFinite(amountEgp) ||
      amountEgp <= 0
    ) {
      setFeedback({
        tone: "error",
        message: "Enter an expense description and valid amount.",
      });
      return;
    }

    setIsExpenseSaving(true);

    try {
      const response = await fetch("/api/admin/expenses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description,
          amountEgp,
          paymentMethod: expenseMethod,
          operationId: `expense:${crypto.randomUUID()}`,
        }),
      });
      const payload = await readJson(response);

      if (handleUnauthorized(response)) {
        return;
      }

      if (!response.ok || !isRecord(payload) || !isRecord(payload.expense)) {
        throw new Error(readError(payload, "Unable to save the expense."));
      }

      setExpenses((current) => [payload.expense as Expense, ...current]);
      setExpenseDescription("");
      setExpenseAmount("");
      setFeedback({
        tone: "success",
        message: `${description} logged as ${money(amountEgp)}.`,
      });
      void loadActivity();
    } catch (error) {
      setFeedback({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "Unable to save the expense.",
      });
    } finally {
      setIsExpenseSaving(false);
    }
  };

  const openEventSettings = () => {
    setEventSettingsDraft(eventSettings);
    setIsEventSettingsOpen(true);
  };

  const saveEventSettings = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (isEventSettingsSaving) {
      return;
    }

    setIsEventSettingsSaving(true);

    try {
      const response = await fetch("/api/admin/event-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(eventSettingsDraft),
      });
      const payload = await readJson(response);

      if (handleUnauthorized(response)) {
        return;
      }

      if (!response.ok || !isRecord(payload) || !isRecord(payload.settings)) {
        throw new Error(readError(payload, "Unable to save event settings."));
      }

      const saved: GateEventSettings = {
        title: String(payload.settings.title ?? ""),
        eventDate: String(payload.settings.eventDate ?? ""),
        eventTime: String(payload.settings.eventTime ?? ""),
        location: String(payload.settings.location ?? ""),
      };
      setDashboard((current) => ({ ...current, eventSettings: saved }));
      setIsEventSettingsOpen(false);
      setFeedback({ tone: "success", message: "Event details updated." });
    } catch (error) {
      setFeedback({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "Unable to save event settings.",
      });
    } finally {
      setIsEventSettingsSaving(false);
    }
  };

  const saveRunner = async (event: FormEvent<HTMLFormElement>) => {

    event.preventDefault();

    if (!runnerEditDraft || isRunnerSaving) {
      return;
    }

    setIsRunnerSaving(true);
    const draft = runnerEditDraft;
    const previous = dashboard.roster.find(
      (runner) => runner.rowIndex === draft.rowIndex,
    );

    if (!previous) {
      setIsRunnerSaving(false);
      setFeedback({
        tone: "error",
        message: "This runner is no longer in the active roster. Refresh and retry.",
      });
      return;
    }

    const isFree = draft.status === "FREE";
    const draftedPaid = Number(draft.amountPaid) || 0;
    const draftedOwed = Number(draft.balanceOwed) || 0;
    const receivedCash = Number(draft.amountReceived) || 0;

    // Settle balance if cash received >= balance owed or if status is set to CONFIRMED
    const settlingCash = !isFree && receivedCash >= draftedOwed && draftedOwed > 0;
    const finalPaid = isFree ? 0 : settlingCash ? draftedPaid + draftedOwed : draftedPaid;
    const finalOwed = isFree ? 0 : settlingCash ? 0 : draftedOwed;
    const isConf = draft.status === "CONFIRMED" || settlingCash || isFree;
    const finalStatus: RunnerStatusDraft = isFree ? "FREE" : isConf ? "CONFIRMED" : draft.status;

    const optimistic: RosterEntry = {
      ...previous,
      name: draft.name.trim(),
      phone: draft.phone.trim(),
      paymentType: draft.paymentType.trim(),
      status: finalStatus,
      paymentStatus: finalStatus,
      checkedIn: isConf,
      amountPaid: Math.max(0, finalPaid),
      balanceOwed: Math.max(0, finalOwed),
    };

    // 1. Instantly update local state
    replaceRunnerInDashboard(optimistic);
    // 2. Close modal immediately and resume camera scanning
    closeRunnerEditor();

    try {
      const response = await fetch("/api/admin/roster", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache, no-store, must-revalidate",
          Pragma: "no-cache",
        },
        cache: "no-store",
        body: JSON.stringify({
          ...draft,
          status: finalStatus,
          amountPaid: Math.max(0, finalPaid),
          balanceOwed: Math.max(0, finalOwed),
        }),
      });
      const payload = await readJson(response);

      if (handleUnauthorized(response)) {
        return;
      }

      const updated =
        response.ok && isRecord(payload)
          ? parseRoster([payload.runner])[0]
          : undefined;

      if (!updated) {
        throw new Error(readError(payload, "Unable to update runner."));
      }

      replaceRunnerInDashboard(updated);
      setFeedback({
        tone: "success",
        message: `${updated.name} was confirmed & updated.`,
      });
      void loadActivity();
      // 3. Silently re-sync with sheets in background
      void refreshDashboard();
    } catch (error) {
      replaceRunnerInDashboard(previous);
      setFeedback({
        tone: "error",
        message:
          error instanceof Error ? error.message : "Unable to update runner.",
      });
    } finally {
      setIsRunnerSaving(false);
    }
  };

  const deleteRunner = async () => {
    if (!runnerEditDraft || isRunnerSaving) {
      return;
    }

    const draft = runnerEditDraft;
    const confirmed = window.confirm(
      `Are you sure you want to permanently remove ${draft.name} from this event?`,
    );

    if (!confirmed) {
      return;
    }

    setIsRunnerSaving(true);
    closeRunnerEditor();

    try {
      const response = await fetch("/api/admin/roster", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache, no-store, must-revalidate",
          Pragma: "no-cache",
        },
        cache: "no-store",
        body: JSON.stringify({
          rowIndex: draft.rowIndex,
          expectedName: draft.name,
          expectedPhone: draft.phone,
        }),
      });
      const payload = await readJson(response);

      if (handleUnauthorized(response)) {
        return;
      }

      if (!response.ok) {
        throw new Error(readError(payload, "Unable to delete runner."));
      }

      const deletedRow = draft.rowIndex;

      setDashboard((current) => {
        const roster = current.roster
          .filter((runner) => runner.rowIndex !== deletedRow)
          .map((runner) =>
            runner.rowIndex > deletedRow
              ? { ...runner, rowIndex: runner.rowIndex - 1 }
              : runner,
          );
        const counters = summarizeRosterCounters(roster);

        return {
          ...current,
          roster,
          confirmed: counters.confirmed,
          pending: counters.pending,
          total: counters.total,
        };
      });
      setOfflineQueue((current) =>
        current.filter((item) => item.runnerRow !== deletedRow),
      );
      setRunnerEditDraft(null);
      setFeedback({
        tone: "success",
        message: `${runnerEditDraft.name} was permanently removed.`,
      });
      void refreshDashboard(true);
    } catch (error) {
      setFeedback({
        tone: "error",
        message:
          error instanceof Error ? error.message : "Unable to delete runner.",
      });
    } finally {
      setIsRunnerSaving(false);
    }
  };

  const copyGateReport = async () => {
    const cashExpenses = expenses.reduce(
      (sum, expense) =>
        sum +
        (expense.paymentMethod
          .toLocaleLowerCase("en-US")
          .includes("cash")
          ? Number(expense.amountEgp || 0)
          : 0),
      0,
    );
    const netCash =
      displayedCash - displayedChange - cashExpenses;
    const registeredConfirmed = Math.max(
      0,
      displayedConfirmed - dashboard.walkInCount,
    );
    const report = [
      `📊 GlowRunners Meetup Report – ${eventSettings.title}`,
      `📅 ${eventSettings.eventDate}`,
      `🕒 ${formatEventTime(eventSettings.eventTime)}`,
      `📍 ${eventSettings.location}`,
      `👥 Total Attendees: ${displayedConfirmed} (${registeredConfirmed} Pre-registered, ${dashboard.walkInCount} Walk-ins)`,
      `💵 Total Cash Collected: ${money(displayedCash)}`,
      `💳 Digital Revenue: ${money(displayedDigital)}`,
      `📉 Total Expenses: ${money(totalExpenses)}`,
      `💰 Net Cash Handover: ${signedMoney(netCash)}`,
      `🚣 Post-Run Activity Signups: ${postRunSignups} confirmed`,
    ].join("\n");

    try {
      await navigator.clipboard.writeText(report);
      setFeedback({
        tone: "success",
        message: "Gate report copied. It is ready to paste into WhatsApp.",
      });
      void fetch("/api/admin/activity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actionType: "CLOSE_GATE_REPORT",
          operationId: `close-gate:${crypto.randomUUID()}`,
          description: `${activeAdmin?.displayName ?? "Admin"} generated the gate close report`,
        }),
      });
    } catch {
      setFeedback({
        tone: "error",
        message: "Clipboard access was blocked. Allow clipboard access and retry.",
      });
    }
  };

  const signOut = async () => {
    try {
      await fetch("/api/auth/session", { method: "DELETE" });
    } finally {
      try {
        window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
        window.sessionStorage.removeItem("glowrunners.admin.token.v1");
      } catch {
        // Navigation completes the explicit sign-out.
      }
      window.location.assign("/admin/login");
    }
  };

  const receivedAmount = Number(paymentDraft?.amountReceived ?? "");
  const hasValidReceivedAmount =
    Number.isFinite(receivedAmount) && receivedAmount >= 0;
  const paymentDifference = hasValidReceivedAmount
    ? Math.round((receivedAmount - ENTRY_FEE_EGP) * 100) / 100
    : 0;
  const isExactPayment =
    hasValidReceivedAmount && Math.abs(paymentDifference) < 0.01;
  const isShortPayment =
    hasValidReceivedAmount && paymentDifference < -0.01;
  const modalChange =
    paymentDraft?.paymentMethod === "Cash" && paymentDifference > 0
      ? paymentDifference
      : 0;
  return (
    <div className="flex min-h-screen w-full flex-col items-center justify-start overflow-x-hidden bg-[#0d0d0d] px-4 text-white">
      <main className="flex w-full max-w-md min-w-0 flex-col gap-4 py-4 pb-10">
        <header className="flex min-w-0 flex-col items-center gap-3 text-center">
          <div className="self-end rounded-full border border-white/15 bg-white/[0.06] px-3 py-2 text-[10px] font-black tracking-[0.14em] text-zinc-200">
            📅 {eventDateDisplay.badge}
          </div>
          <div className="min-w-0">
            <p className="bg-gradient-to-r from-[#ff5f8f] to-[#ffc865] bg-clip-text text-3xl font-black tracking-tight text-transparent">
              GlowRunners
            </p>
            <h1 className="mt-1 text-xs font-black tracking-[0.24em] text-zinc-300">
              GATE CONTROL DASHBOARD
            </h1>
            {activeAdmin ? (
              <p className="mt-2 text-xs font-bold text-zinc-500">
                Signed in as {activeAdmin.displayName}
              </p>
            ) : null}
          </div>
          <div className="grid w-full min-w-0 grid-cols-3 gap-2">
            <Link
              href="/admin/post-run-events"
              className="flex min-h-12 min-w-0 items-center justify-center rounded-xl bg-gradient-to-r from-fuchsia-600 to-pink-500 px-2 text-center text-[11px] font-black shadow-[0_8px_24px_rgba(236,72,153,0.22)]"
            >
              Post-Run Events
            </Link>
            <button
              type="button"
              onClick={() => setIsActivityOpen(true)}
              className="min-h-12 min-w-0 rounded-xl border border-white/15 bg-white/[0.06] px-2 text-[11px] font-black"
            >
              📜 Activity Log
            </button>
            <button
              type="button"
              onClick={signOut}
              className="min-h-12 min-w-0 rounded-xl border border-white/15 bg-white/[0.04] px-2 text-[11px] font-black text-zinc-300"
            >
              Sign out
            </button>
          </div>
          <button
            type="button"
            onClick={copyGateReport}
            className="min-h-12 w-full rounded-xl border border-amber-300/25 bg-amber-300/[0.08] px-4 text-sm font-black text-amber-200"
          >
            Close Gate &amp; Copy Report
          </button>
        </header>

        <section
          aria-label="Event information"
          className="grid min-w-0 grid-cols-3 gap-2"
        >
          <button
            type="button"
            onClick={openEventSettings}
            className="col-span-3 flex min-h-12 min-w-0 items-center justify-between gap-3 rounded-xl border border-white/10 bg-[#151515] px-3 text-left"
          >
            <span className="min-w-0 truncate text-sm font-black">
              {eventSettings.title}
            </span>
            <span className="shrink-0 text-[10px] font-black text-pink-300">
              Edit event
            </span>
          </button>
          {[
            ["KICKOFF", formatEventTime(eventSettings.eventTime)],
            ["LOCATION", eventSettings.location],
            ["DAY", eventDateDisplay.day],
          ].map(([label, value]) => (
            <div
              key={label}
              className="min-w-0 rounded-xl border border-white/10 bg-[#151515] px-2 py-3 text-center"
            >
              <p className="text-[9px] font-black tracking-[0.16em] text-zinc-500">
                {label}
              </p>
              <p
                className="mt-1 truncate text-[11px] font-extrabold text-zinc-100"
                title={value}
              >
                {value}
              </p>
            </div>
          ))}
        </section>

        <section
          aria-label="Attendance counters"
          className="grid min-w-0 grid-cols-3 gap-2"
        >
          {[
            ["✅", "CONFIRMED", displayedConfirmed, "text-emerald-400"],
            ["⏳", "PENDING", displayedPending, "text-orange-400"],
            ["👥", "TOTAL", displayedTotal, "text-sky-400"],
          ].map(([icon, label, value, color]) => (
            <div
              key={String(label)}
              className="min-w-0 rounded-xl border border-white/10 bg-[#151515] px-2 py-4 text-center"
            >
              <p className="text-base">{icon}</p>
              <p className={`mt-1 text-3xl font-black ${color}`}>{value}</p>
              <p className="mt-1 text-[9px] font-black tracking-[0.1em] text-zinc-500">
                {label}
              </p>
            </div>
          ))}
        </section>

        <section
          aria-label="Financial summary"
          className="grid min-w-0 grid-cols-3 overflow-hidden rounded-xl border border-white/10 bg-[#151515]"
        >
          {[
            ["💵", "CASH IN HAND", displayedCash, "text-emerald-300"],
            ["💳", "DIGITAL REVENUE", displayedDigital, "text-sky-300"],
            ["🔴", "CHANGE OWED", displayedChange, "text-rose-300"],
          ].map(([icon, label, value, color], index) => (
            <div
              key={String(label)}
              className={`min-w-0 px-2 py-3 text-center ${
                index > 0 ? "border-l border-white/10" : ""
              }`}
            >
              <p className="text-sm">{icon}</p>
              <p className={`mt-1 truncate text-xs font-black ${color}`}>
                {money(Number(value))}
              </p>
              <p className="mt-1 text-[8px] font-black leading-tight tracking-[0.08em] text-zinc-500">
                {label}
              </p>
            </div>
          ))}
        </section>

        <section className="min-w-0 overflow-hidden rounded-2xl border border-white/10 bg-[#151515] p-3">
          {cameraOptions.length > 1 ? (
            <label className="mb-3 block min-w-0">
              <span className="mb-1 block text-[10px] font-black uppercase tracking-[0.08em] text-zinc-500">
                Camera
              </span>
              <select
                value={selectedCameraId}
                onChange={(event) => setSelectedCameraId(event.target.value)}
                className="min-h-11 w-full min-w-0 rounded-xl border border-white/10 bg-black px-3 text-sm text-white outline-none focus:border-pink-400"
              >
                {cameraOptions.map((camera) => (
                  <option key={camera.id} value={camera.id}>
                    {camera.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <div
            className={`relative flex min-h-[270px] w-full min-w-0 items-center justify-center overflow-hidden rounded-xl border-2 bg-black transition-colors duration-150 ${
              isScanSuccess
                ? "border-emerald-400 shadow-[0_0_22px_rgba(52,211,153,0.55)]"
                : "border-transparent"
            }`}
          >
            <div
              id={SCANNER_ID}
              className="h-full min-h-[270px] w-full overflow-hidden"
            />
            {scannerStatus !== "live" ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-gradient-to-b from-zinc-900 to-black p-5 text-center">
                <span className="text-5xl" aria-hidden="true">
                  📷
                </span>
                <p className="text-sm font-bold text-zinc-300">
                  {scannerStatus === "starting"
                    ? "Starting rear camera…"
                    : scannerStatus === "error"
                      ? "📷 Camera access blocked or unavailable. Please grant camera permission in browser settings, or use the manual search box below."
                      : "QR viewfinder is inactive"}
                </p>
              </div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => {
              setIsScannerEnabled(true);
              setScannerKey((current) => current + 1);
            }}
            disabled={scannerStatus === "starting"}
            className="mt-3 min-h-12 w-full rounded-xl bg-gradient-to-r from-orange-500 via-pink-500 to-fuchsia-600 px-4 text-sm font-black disabled:opacity-60"
          >
            {scannerStatus === "live"
              ? "📷 Restart Scanner"
              : scannerStatus === "starting"
                ? "Starting Scanner…"
                : "📷 Start Scanner"}
          </button>

          <form onSubmit={submitQuickCheckIn} className="mt-3 min-w-0">
            <label className="block min-w-0">
              <span className="mb-1 block text-[10px] font-black uppercase tracking-[0.08em] text-zinc-500">
                ⚡ Quick Check-In Input
              </span>
              <input
                value={quickCheckIn}
                onChange={(event) => setQuickCheckIn(event.target.value)}
                placeholder="Phone, @username, exact name, or ticket ID"
                autoComplete="off"
                className="min-h-12 w-full min-w-0 rounded-xl border border-white/10 bg-black px-4 text-sm text-white outline-none placeholder:text-zinc-600 focus:border-emerald-400"
              />
            </label>
            <button
              type="submit"
              disabled={!quickCheckIn.trim()}
              className="mt-2 min-h-11 w-full rounded-xl border border-emerald-400/30 bg-emerald-500/10 px-4 text-sm font-black text-emerald-300 disabled:opacity-40 hover:bg-emerald-500/20 active:scale-95 transition-all"
            >
              ⚡ Review & Confirm
            </button>
          </form>

        </section>

        <section className="min-w-0 rounded-2xl border border-white/10 bg-[#151515] p-3">
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-lg font-black">Roster Explorer</h2>
              <p className="mt-1 truncate text-[11px] text-zinc-500">
                {formatEventTime(eventSettings.eventTime)} · {eventSettings.location}
                {dashboard.isFallbackSheet ? " · fallback tab" : ""}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void refreshDashboard(true)}
              disabled={isRefreshing}
              className="min-h-11 shrink-0 rounded-lg border border-white/10 px-3 text-xs font-black text-zinc-300 disabled:opacity-60"
            >
              {isRefreshing ? "…" : "Refresh"}
            </button>
          </div>

          <div className="mt-3 grid min-w-0 grid-cols-4 gap-1.5">
            {[
              ["total", "👥 Total", displayedTotal],
              ["confirmed", "🟢 Confirmed", displayedConfirmed],
              ["pending", "🟡 Pending", displayedPending],
              ["owed", "🔴 Owed", runnerStateSummary.owed],
            ].map(([value, label, count]) => (
              <button
                key={String(value)}
                type="button"
                onClick={() => setRosterFilter(value as RosterFilter)}
                className={`min-h-11 min-w-0 rounded-lg px-1 text-[9px] font-black ${
                  rosterFilter === value
                    ? "bg-white text-black"
                    : "border border-white/10 bg-black/30 text-zinc-400"
                }`}
              >
                {label} · {count}
              </button>
            ))}
          </div>

          <div
            aria-label="Roster financial state"
            className="mt-2 grid min-w-0 grid-cols-3 overflow-hidden rounded-xl border border-white/10 bg-black/30"
          >
            {[
              ["🎁", "FREE", runnerStateSummary.free, "text-fuchsia-300"],
              ["💰", "PAID", money(runnerStateSummary.paid), "text-emerald-300"],
              [
                "🔴",
                "BALANCE OWED",
                money(runnerStateSummary.balanceOwed),
                "text-rose-300",
              ],
            ].map(([icon, label, value, color], index) => (
              <div
                key={String(label)}
                className={`min-w-0 px-2 py-2 text-center ${
                  index > 0 ? "border-l border-white/10" : ""
                }`}
              >
                <p className="text-xs" aria-hidden="true">{icon}</p>
                <p className={`truncate text-[11px] font-black ${color}`}>
                  {value}
                </p>
                <p className="mt-0.5 truncate text-[7px] font-black tracking-[0.06em] text-zinc-500">
                  {label}
                </p>
              </div>
            ))}
          </div>

          <label className="mt-2 block">
            <span className="sr-only">Search roster</span>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="🔍 Search by name, phone, or @username..."
              className="min-h-12 w-full min-w-0 rounded-xl border border-white/10 bg-black px-4 text-sm text-white outline-none placeholder:text-zinc-600 focus:border-pink-400"
            />
          </label>

          <div className="mt-3 flex min-w-0 flex-col gap-1.5">
            {filteredRoster.length === 0 ? (
              <div className="rounded-xl border border-dashed border-white/10 px-4 py-8 text-center text-sm text-zinc-500">
                No runners match this view.
              </div>
            ) : (
              filteredRoster.map((runner) => {
                const confirmed = evaluateRunnerState(runner).isConfirmed;
                const isFree = runner.status === "FREE";
                const lock = lockByRow.get(runner.rowIndex);
                const lockedByAnother =
                  lock && lock.adminPhone !== activeAdmin?.phoneE164;

                return (
                  <div
                    key={`${runner.rowIndex}:${runner.phone}`}
                    className="flex h-12 min-w-0 items-center justify-between gap-2 rounded-xl border border-white/10 bg-black/40 px-3 py-1 hover:bg-white/[0.04] transition-colors"
                  >
                    <button
                      type="button"
                      onClick={() => openRunnerEditor(runner)}
                      className="flex min-w-0 flex-1 flex-col text-left outline-none"
                      aria-label={`Edit ${runner.name}`}
                    >
                      <span className="truncate text-xs font-black text-white leading-tight">
                        {runner.name}
                      </span>
                      <span className="truncate text-[10px] font-bold text-zinc-400">
                        {displayContact(runner.phone)} · {runner.paymentType}
                        {runner.source === "post-run" ? " · Post-Run" : runner.source === "walk-in" ? " · Walk-In" : ""}
                      </span>
                    </button>

                    <div className="flex shrink-0 items-center gap-1.5">
                      <span
                        className={`rounded-full px-2 py-0.5 text-[9px] font-black whitespace-nowrap ${
                          confirmed
                            ? "bg-emerald-950/90 text-emerald-300 border border-emerald-800/50"
                            : isFree
                              ? "bg-sky-950/90 text-sky-300 border border-sky-800/50"
                              : runner.balanceOwed > 0
                                ? "bg-amber-950/90 text-amber-300 border border-amber-800/50"
                                : "bg-zinc-900 text-zinc-400 border border-white/10"
                        }`}
                      >
                        {confirmed
                          ? "🟢 Cleared"
                          : isFree
                            ? "🎁 Free"
                            : runner.balanceOwed > 0
                              ? `🟡 Owed ${runner.balanceOwed} EGP`
                              : "⚪ Unpaid"}
                      </span>

                      <button
                        type="button"
                        onClick={() => openRunnerEditor(runner)}
                        disabled={Boolean(lockedByAnother)}
                        className={`h-8 min-w-12 shrink-0 rounded-lg px-2 text-[10px] font-black active:scale-95 transition-all ${
                          confirmed
                            ? "border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20"
                            : "bg-pink-500 text-white hover:bg-pink-400 shadow-md"
                        } disabled:cursor-not-allowed disabled:opacity-50`}
                      >
                        {confirmed ? "Edit" : "Clear"}
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>


        <div
          role="status"
          className={`rounded-xl border px-4 py-3 text-sm font-bold ${
            feedback.tone === "success"
              ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-200"
              : feedback.tone === "error"
                ? "border-rose-400/20 bg-rose-400/10 text-rose-200"
                : "border-white/10 bg-white/[0.04] text-zinc-400"
          }`}
        >
          {feedback.message}
        </div>

        <div className="flex min-w-0 items-center justify-between rounded-xl border border-sky-400/20 bg-sky-400/[0.07] px-4 py-3">
          <div className="min-w-0">
            <p className="text-xs font-black text-sky-200">
              Local Queue: {offlineQueue.length} saved
            </p>
            <p className="mt-1 text-[10px] text-zinc-500">
              Auto-resync runs when the connection returns.
            </p>
          </div>
          <button
            type="button"
            onClick={() =>
              void (async () => {
                await syncOfflineQueue();
                await refreshDashboard(true);
              })()
            }
            disabled={isRefreshing}
            className="min-h-11 shrink-0 rounded-lg border border-sky-300/20 px-3 text-[11px] font-black text-sky-200 disabled:opacity-40"
          >
            Sync now
          </button>
        </div>

        <details className="group min-w-0 rounded-2xl border border-white/10 bg-[#151515] p-4">
          <summary className="cursor-pointer list-none text-sm font-black text-orange-300">
            + ADD WALK-IN RUNNER
          </summary>
          <form
            onSubmit={handleWalkIn}
            className="mt-4 flex min-w-0 flex-col gap-3"
          >
            <label className="text-[10px] font-black tracking-[0.12em] text-zinc-500">
              FULL NAME
              <input
                value={walkInName}
                onChange={(event) => setWalkInName(event.target.value)}
                maxLength={100}
                className="mt-1 min-h-12 w-full min-w-0 rounded-xl border border-white/10 bg-black px-4 text-sm text-white outline-none focus:border-orange-400"
              />
            </label>
            <label className="text-[10px] font-black tracking-[0.12em] text-zinc-500">
              PHONE NUMBER <span className="text-zinc-600">(OPTIONAL)</span>
              <input
                value={walkInPhone}
                onChange={(event) => setWalkInPhone(event.target.value)}
                inputMode="tel"
                maxLength={24}
                className="mt-1 min-h-12 w-full min-w-0 rounded-xl border border-white/10 bg-black px-4 text-sm text-white outline-none focus:border-orange-400"
              />
            </label>
            <label className="text-[10px] font-black tracking-[0.12em] text-zinc-500">
              PAYMENT METHOD
              <select
                value={walkInMethod}
                onChange={(event) =>
                  setWalkInMethod(
                    event.target.value === "InstaPay" ? "InstaPay" : "Cash",
                  )
                }
                className="mt-1 min-h-12 w-full min-w-0 rounded-xl border border-white/10 bg-black px-4 text-sm text-white"
              >
                <option>Cash</option>
                <option>InstaPay</option>
              </select>
            </label>
            <label className="text-[10px] font-black tracking-[0.12em] text-zinc-500">
              AMOUNT RECEIVED (EGP)
              <input
                value={walkInAmount}
                onChange={(event) => setWalkInAmount(event.target.value)}
                type="number"
                inputMode="numeric"
                min={WALK_IN_FEE_EGP}
                max={1_000_000}
                step={1}
                className="mt-1 min-h-12 w-full min-w-0 rounded-xl border border-white/10 bg-black px-4 text-sm text-white outline-none focus:border-orange-400"
              />
            </label>
            <div
              aria-label="Quick walk-in cash amounts"
              className="grid min-w-0 grid-cols-3 gap-2"
            >
              {[70, 100, 200].map((amount) => (
                <button
                  key={amount}
                  type="button"
                  onClick={() => setWalkInAmount(String(amount))}
                  className={`min-h-11 min-w-0 rounded-xl border px-2 text-xs font-black ${
                    walkInReceivedAmount === amount
                      ? "border-orange-300 bg-orange-400 text-black"
                      : "border-white/10 bg-black text-zinc-300"
                  }`}
                >
                  {amount} EGP
                </button>
              ))}
            </div>
            <p
              role="status"
              className={`rounded-xl border px-3 py-2 text-center text-xs font-black ${
                !hasValidWalkInAmount
                  ? "border-amber-400/20 bg-amber-400/[0.08] text-amber-200"
                  : walkInChange > 0
                    ? "border-red-400/20 bg-red-400/[0.08] text-red-300"
                    : "border-emerald-400/20 bg-emerald-400/[0.08] text-emerald-300"
              }`}
            >
              {!hasValidWalkInAmount
                ? `Enter at least ${money(WALK_IN_FEE_EGP)}`
                : walkInChange > 0
                  ? `🔴 RETURN CHANGE TO RUNNER: ${money(walkInChange)}`
                  : "🟢 EXACT AMOUNT"}
            </p>
            <button
              type="submit"
              disabled={isWalkInSaving || !hasValidWalkInAmount}
              className="min-h-12 w-full rounded-xl bg-orange-500 px-4 text-sm font-black text-black disabled:opacity-60"
            >
              {isWalkInSaving
                ? "Saving…"
                : walkInChange > 0
                  ? `+ Confirm Walk-In · Return ${money(walkInChange)} Change`
                  : `+ Confirm Walk-In · Exact ${money(WALK_IN_FEE_EGP)}`}
            </button>
          </form>
        </details>

        <details className="group min-w-0 rounded-2xl border border-white/10 bg-[#151515] p-4">
          <summary className="cursor-pointer list-none text-sm font-black text-rose-300">
            💸 LOG EVENT EXPENSE
          </summary>
          <form
            onSubmit={handleExpense}
            className="mt-4 flex min-w-0 flex-col gap-3"
          >
            <label className="text-[10px] font-black tracking-[0.12em] text-zinc-500">
              DESCRIPTION
              <input
                value={expenseDescription}
                onChange={(event) =>
                  setExpenseDescription(event.target.value)
                }
                maxLength={240}
                placeholder="Water bottles"
                className="mt-1 min-h-12 w-full min-w-0 rounded-xl border border-white/10 bg-black px-4 text-sm text-white outline-none focus:border-rose-400"
              />
            </label>
            <div className="grid min-w-0 grid-cols-2 gap-2">
              <label className="min-w-0 text-[10px] font-black tracking-[0.12em] text-zinc-500">
                AMOUNT (EGP)
                <input
                  value={expenseAmount}
                  onChange={(event) => setExpenseAmount(event.target.value)}
                  inputMode="decimal"
                  className="mt-1 min-h-12 w-full min-w-0 rounded-xl border border-white/10 bg-black px-3 text-sm text-white outline-none focus:border-rose-400"
                />
              </label>
              <label className="min-w-0 text-[10px] font-black tracking-[0.12em] text-zinc-500">
                METHOD
                <select
                  value={expenseMethod}
                  onChange={(event) =>
                    setExpenseMethod(
                      event.target.value === "Digital"
                        ? "Digital"
                        : "Cash",
                    )
                  }
                  className="mt-1 min-h-12 w-full min-w-0 rounded-xl border border-white/10 bg-black px-3 text-sm text-white"
                >
                  <option>Cash</option>
                  <option>Digital</option>
                </select>
              </label>
            </div>
            <button
              type="submit"
              disabled={isExpenseSaving}
              className="min-h-12 w-full rounded-xl bg-rose-500 px-4 text-sm font-black text-white disabled:opacity-60"
            >
              {isExpenseSaving ? "Saving…" : "Log Expense"}
            </button>
            <p className="text-center text-xs font-bold text-zinc-500">
              Total logged expenses: {money(totalExpenses)}
            </p>
          </form>
        </details>

        <footer className="pt-4 text-center text-[9px] font-black tracking-[0.18em] text-zinc-600">
          GLOWRUNNERS GATE CONTROL · ORGANISER ONLY
        </footer>
      </main>

      {isEventSettingsOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="event-settings-title"
          className="fixed inset-0 z-50 flex items-end justify-center overflow-x-hidden bg-black/85 p-3 backdrop-blur-sm sm:items-center"
        >
          <form
            onSubmit={saveEventSettings}
            className="w-full max-w-md min-w-0 rounded-2xl border border-white/15 bg-[#141414] p-4 shadow-2xl"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <h2 id="event-settings-title" className="text-xl font-black">
                  Edit Event Settings
                </h2>
                <p className="mt-1 truncate text-xs text-zinc-500">
                  {dashboard.sheetName}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsEventSettingsOpen(false)}
                className="min-h-11 min-w-11 rounded-xl border border-white/10 text-lg"
                aria-label="Close event settings"
              >
                ×
              </button>
            </div>
            <div className="mt-4 flex min-w-0 flex-col gap-3">
              <label className="text-[10px] font-black tracking-[0.12em] text-zinc-500">
                EVENT TITLE
                <input
                  required
                  maxLength={120}
                  value={eventSettingsDraft.title}
                  onChange={(event) =>
                    setEventSettingsDraft((current) => ({
                      ...current,
                      title: event.target.value,
                    }))
                  }
                  className="mt-1 min-h-12 w-full min-w-0 rounded-xl border border-white/10 bg-black px-4 text-sm text-white outline-none focus:border-pink-400"
                />
              </label>
              <div className="grid min-w-0 grid-cols-2 gap-2">
                <label className="min-w-0 text-[10px] font-black tracking-[0.12em] text-zinc-500">
                  EVENT DATE
                  <input
                    required
                    type="date"
                    value={eventSettingsDraft.eventDate}
                    onChange={(event) =>
                      setEventSettingsDraft((current) => ({
                        ...current,
                        eventDate: event.target.value,
                      }))
                    }
                    className="mt-1 min-h-12 w-full min-w-0 rounded-xl border border-white/10 bg-black px-3 text-sm text-white"
                  />
                </label>
                <label className="min-w-0 text-[10px] font-black tracking-[0.12em] text-zinc-500">
                  EVENT TIME
                  <input
                    required
                    type="time"
                    value={eventSettingsDraft.eventTime}
                    onChange={(event) =>
                      setEventSettingsDraft((current) => ({
                        ...current,
                        eventTime: event.target.value,
                      }))
                    }
                    className="mt-1 min-h-12 w-full min-w-0 rounded-xl border border-white/10 bg-black px-3 text-sm text-white"
                  />
                </label>
              </div>
              <label className="text-[10px] font-black tracking-[0.12em] text-zinc-500">
                EVENT LOCATION / MEETING POINT
                <input
                  required
                  maxLength={180}
                  value={eventSettingsDraft.location}
                  onChange={(event) =>
                    setEventSettingsDraft((current) => ({
                      ...current,
                      location: event.target.value,
                    }))
                  }
                  className="mt-1 min-h-12 w-full min-w-0 rounded-xl border border-white/10 bg-black px-4 text-sm text-white outline-none focus:border-pink-400"
                />
              </label>
            </div>
            <div className="mt-4 grid min-w-0 grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setIsEventSettingsOpen(false)}
                disabled={isEventSettingsSaving}
                className="min-h-12 rounded-xl border border-white/15 text-sm font-black text-zinc-300"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isEventSettingsSaving}
                className="min-h-12 rounded-xl bg-pink-500 px-3 text-sm font-black text-white disabled:opacity-60"
              >
                {isEventSettingsSaving ? "Saving…" : "Save Event"}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {runnerEditDraft ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="runner-edit-title"
          className="fixed inset-0 z-50 flex items-end justify-center overflow-x-hidden bg-black/85 p-3 backdrop-blur-sm sm:items-center"
        >
          <form
            onSubmit={saveRunner}
            className="max-h-[calc(100dvh-1.5rem)] w-full max-w-md min-w-0 overflow-y-auto rounded-2xl border border-white/15 bg-[#141414] p-4 shadow-2xl"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <h2 id="runner-edit-title" className="text-xl font-black text-white flex items-center gap-2">
                  <span>💸</span> Runner Settlement & Edit
                </h2>
                <p className="mt-1 text-xs font-semibold text-zinc-400">
                  Attendance Row {runnerEditDraft.rowIndex} · {runnerEditDraft.paymentType || "Regular"}
                </p>
              </div>
              <button
                type="button"
                onClick={closeRunnerEditor}
                className="min-h-11 min-w-11 rounded-xl border border-white/10 text-lg hover:bg-white/10 active:scale-95 transition-all text-zinc-400 hover:text-white"
                aria-label="Close runner settlement"
              >
                ×
              </button>
            </div>

            <div className="mt-3 rounded-xl border border-white/10 bg-black/60 p-3">
              <p className="truncate text-base font-black text-white">{runnerEditDraft.name}</p>
              <p className="mt-0.5 text-xs text-zinc-400">{runnerEditDraft.phone || "No contact recorded"}</p>
            </div>

            <div className="mt-4 flex min-w-0 flex-col gap-3">
              <label className="text-[10px] font-black tracking-[0.12em] text-zinc-400">
                FULL NAME
                <input
                  required
                  maxLength={100}
                  value={runnerEditDraft.name}
                  onChange={(event) =>
                    setRunnerEditDraft((current) =>
                      current ? { ...current, name: event.target.value } : null,
                    )
                  }
                  className="mt-1 min-h-12 w-full min-w-0 rounded-xl border border-white/10 bg-black px-4 text-sm text-white outline-none focus:border-pink-400"
                />
              </label>
              <label className="text-[10px] font-black tracking-[0.12em] text-zinc-400">
                WHATSAPP PHONE OR @HANDLE
                <input
                  maxLength={80}
                  value={runnerEditDraft.phone}
                  onChange={(event) =>
                    setRunnerEditDraft((current) =>
                      current ? { ...current, phone: event.target.value } : null,
                    )
                  }
                  className="mt-1 min-h-12 w-full min-w-0 rounded-xl border border-white/10 bg-black px-4 text-sm text-white outline-none focus:border-pink-400"
                />
              </label>
              <label className="text-[10px] font-black tracking-[0.12em] text-zinc-400">
                PAYMENT / GATE STATUS
                <select
                  value={runnerEditDraft.status}
                  onChange={(event) => {
                    const status = event.target.value as RunnerStatusDraft;
                    setRunnerEditDraft((current) =>
                      current
                        ? {
                            ...current,
                            status,
                            ...(status === "FREE"
                              ? { amountPaid: "0", balanceOwed: "0", amountReceived: "" }
                              : status === "CONFIRMED"
                                ? { balanceOwed: "0" }
                                : {}),
                          }
                        : null,
                    );
                  }}
                  className="mt-1 min-h-12 w-full min-w-0 rounded-xl border border-white/10 bg-black px-4 text-sm text-white focus:border-pink-400"
                >
                  <option value="CONFIRMED">✅ Confirmed / Cleared</option>
                  <option value="DEPOSIT_PAID">⏳ Pending / Deposit Paid</option>
                  <option value="PENDING">⏳ Pending / Unpaid</option>
                  <option value="OWED">⚠️ Owed</option>
                  <option value="FREE">🎁 Free Attendee</option>
                </select>
              </label>
              <div className="grid min-w-0 grid-cols-2 gap-2">
                <label className="min-w-0 text-[10px] font-black tracking-[0.12em] text-zinc-400">
                  AMOUNT PAID (EGP)
                  <input
                    type="number"
                    min={0}
                    max={1_000_000}
                    step="0.01"
                    disabled={runnerEditDraft.status === "FREE"}
                    value={runnerEditDraft.amountPaid}
                    onChange={(event) =>
                      setRunnerEditDraft((current) =>
                        current
                          ? { ...current, amountPaid: event.target.value }
                          : null,
                      )
                    }
                    className="mt-1 min-h-12 w-full min-w-0 rounded-xl border border-white/10 bg-black px-3 text-sm text-white disabled:opacity-50 focus:border-pink-400"
                  />
                </label>
                <label className="min-w-0 text-[10px] font-black tracking-[0.12em] text-zinc-400">
                  BALANCE OWED (EGP)
                  <input
                    type="number"
                    min={0}
                    max={1_000_000}
                    step="0.01"
                    disabled={runnerEditDraft.status === "FREE"}
                    value={runnerEditDraft.balanceOwed}
                    onChange={(event) =>
                      setRunnerEditDraft((current) =>
                        current
                          ? { ...current, balanceOwed: event.target.value }
                          : null,
                      )
                    }
                    className="mt-1 min-h-12 w-full min-w-0 rounded-xl border border-white/10 bg-black px-3 text-sm text-white disabled:opacity-50 focus:border-pink-400"
                  />
                </label>
              </div>
            </div>

            {runnerEditDraft.status !== "FREE" ? (
              <div className="mt-4 rounded-xl border border-white/15 bg-white/[0.03] p-3">
                <p className="text-[10px] font-black tracking-[0.12em] text-zinc-400">
                  ON-SITE CASH RECEIVED (EGP)
                </p>
                <input
                  type="number"
                  min={0}
                  max={1_000_000}
                  step="1"
                  placeholder="0"
                  value={runnerEditDraft.amountReceived}
                  onChange={(event) =>
                    setRunnerEditDraft((current) =>
                      current ? { ...current, amountReceived: event.target.value } : null,
                    )
                  }
                  className="mt-1.5 min-h-12 w-full min-w-0 rounded-xl border border-white/10 bg-black px-4 text-base font-black text-white outline-none focus:border-emerald-400"
                />
                <div className="mt-2 grid grid-cols-4 gap-1.5">
                  {[70, 100, 200].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() =>
                        setRunnerEditDraft((current) =>
                          current ? { ...current, amountReceived: String(preset) } : null,
                        )
                      }
                      className="min-h-10 rounded-lg border border-white/10 bg-white/5 text-xs font-black text-zinc-200 hover:bg-white/10 active:scale-95 transition-all"
                    >
                      {preset} EGP
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() =>
                      setRunnerEditDraft((current) =>
                        current
                          ? { ...current, amountReceived: String(Math.max(0, Number(current.balanceOwed) || 0)) }
                          : null,
                      )
                    }
                    className="min-h-10 rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-xs font-black text-emerald-300 hover:bg-emerald-500/20 active:scale-95 transition-all"
                  >
                    EXACT
                  </button>
                </div>
                {(() => {
                  const owed = Number(runnerEditDraft.balanceOwed) || 0;
                  const received = Number(runnerEditDraft.amountReceived) || 0;
                  const change = Math.max(0, received - owed);
                  if (received > 0 && change > 0) {
                    return (
                      <div className="mt-3 rounded-xl border border-emerald-500/40 bg-emerald-500/15 p-3 text-center">
                        <p className="text-[10px] font-black uppercase tracking-wide text-emerald-400">
                          💵 Change to return
                        </p>
                        <p className="mt-0.5 text-xl font-black text-emerald-300">
                          Give {change} EGP change to runner
                        </p>
                      </div>
                    );
                  }
                  if (received > 0 && owed > 0 && received >= owed) {
                    return (
                      <p className="mt-2 text-center text-xs font-bold text-emerald-400">
                        ✓ Balance will be settled to 0 EGP upon confirmation
                      </p>
                    );
                  }
                  return null;
                })()}
              </div>
            ) : null}

            {(() => {
              const owed = Number(runnerEditDraft.balanceOwed) || 0;
              const received = Number(runnerEditDraft.amountReceived) || 0;
              const change = Math.max(0, received - owed);

              return (
                <div className="mt-4 flex flex-col gap-2">
                  {change > 0 ? (
                    <button
                      type="submit"
                      disabled={isRunnerSaving}
                      className="min-h-12 w-full rounded-xl bg-gradient-to-r from-emerald-500 to-green-600 px-4 text-sm font-black text-white shadow-lg hover:from-emerald-400 hover:to-green-500 active:scale-95 transition-all disabled:opacity-60"
                    >
                      {isRunnerSaving
                        ? "Returning Change & Clearing…"
                        : `💸 Return ${change} EGP Change & Mark Cleared`}
                    </button>
                  ) : (
                    <button
                      type="submit"
                      disabled={isRunnerSaving}
                      className="min-h-12 w-full rounded-xl bg-pink-500 px-4 text-sm font-black text-white shadow-lg hover:bg-pink-400 active:scale-95 transition-all disabled:opacity-60"
                    >
                      {isRunnerSaving
                        ? "Saving & Confirming…"
                        : "✓ Save & Confirm Runner"}
                    </button>
                  )}
                  <div className="grid min-w-0 grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={closeRunnerEditor}
                      disabled={isRunnerSaving}
                      className="min-h-11 rounded-xl border border-white/15 text-xs font-black text-zinc-300 hover:bg-white/5 active:scale-95 transition-all"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => void deleteRunner()}
                      disabled={isRunnerSaving}
                      className="min-h-11 rounded-xl border border-red-400/30 bg-red-500/10 px-3 text-xs font-black text-red-300 hover:bg-red-500/20 active:scale-95 transition-all disabled:opacity-60"
                    >
                      🗑️ Delete Runner
                    </button>
                  </div>
                </div>
              );
            })()}
          </form>
        </div>
      ) : null}



      {paymentDraft ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="payment-title"
          className="fixed inset-0 z-50 flex items-end justify-center overflow-x-hidden bg-black/80 p-3 backdrop-blur-sm sm:items-center"
        >
          <div className="w-full max-w-md min-w-0 rounded-2xl border border-white/15 bg-[#141414] p-4 shadow-2xl">
            <h2 id="payment-title" className="text-xl font-black">
              💸 Process Payment
            </h2>
            <div className="mt-3 rounded-xl border border-white/10 bg-black p-3">
              <p className="truncate text-base font-black">
                {paymentDraft.runner.name}
              </p>
              <p className="mt-1 text-xs text-zinc-500">
                0{paymentDraft.runner.phone} ·{" "}
                {paymentDraft.paymentMethod}
              </p>
            </div>
            <p className="mt-4 text-[10px] font-black tracking-[0.12em] text-zinc-500">
              QUICK AMOUNT
            </p>
            <div className="mt-2 grid min-w-0 grid-cols-3 gap-2">
              {[70, 100, 200].map((amount) => (
                <button
                  key={amount}
                  type="button"
                  onClick={() =>
                    setPaymentDraft((current) =>
                      current
                        ? { ...current, amountReceived: String(amount) }
                        : current,
                    )
                  }
                  className="min-h-12 rounded-xl border border-white/10 bg-white/[0.05] text-sm font-black"
                >
                  {amount} EGP
                </button>
              ))}
            </div>
            <label className="mt-4 block text-[10px] font-black tracking-[0.12em] text-zinc-500">
              AMOUNT RECEIVED (EGP)
              <input
                value={paymentDraft.amountReceived}
                onChange={(event) =>
                  setPaymentDraft((current) =>
                    current
                      ? { ...current, amountReceived: event.target.value }
                      : current,
                  )
                }
                inputMode="decimal"
                className="mt-1 min-h-12 w-full rounded-xl border border-white/10 bg-black px-4 text-lg font-black text-white outline-none focus:border-pink-400"
              />
            </label>
            {isExactPayment ? (
              <div className="mt-3 rounded-xl border border-emerald-400/20 bg-emerald-400/[0.08] px-4 py-3 text-center text-sm font-black text-emerald-200">
                🟢 EXACT AMOUNT
              </div>
            ) : modalChange > 0 ? (
              <div className="mt-3 rounded-xl border border-rose-400/20 bg-rose-400/[0.08] px-4 py-3 text-center text-sm font-black text-rose-200">
                🔴 RETURN CHANGE: {money(modalChange)}
              </div>
            ) : isShortPayment ? (
              <div className="mt-3 rounded-xl border border-amber-400/20 bg-amber-400/[0.08] px-4 py-3 text-center text-sm font-black text-amber-200">
                🟡 AMOUNT SHORT: {money(Math.abs(paymentDifference))}
              </div>
            ) : (
              <div className="mt-3 rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-3 text-center text-sm font-black text-zinc-400">
                ENTER AMOUNT RECEIVED
              </div>
            )}
            <div className="mt-4 grid min-w-0 grid-cols-2 gap-2">
              <button
                type="button"
                onClick={closePayment}
                disabled={isPaymentSubmitting}
                className="min-h-12 rounded-xl border border-white/15 bg-white/[0.04] text-sm font-black text-zinc-300"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void confirmPayment()}
                disabled={isPaymentSubmitting}
                className="min-h-12 rounded-xl bg-gradient-to-r from-orange-500 to-pink-500 px-3 text-sm font-black disabled:opacity-60"
              >
                {isPaymentSubmitting ? "Confirming…" : "Confirm Check-In"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {isActivityOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="activity-title"
          className="fixed inset-0 z-50 flex justify-center overflow-x-hidden bg-black/85 p-3 backdrop-blur-sm"
        >
          <section className="flex h-full w-full max-w-md min-w-0 flex-col overflow-hidden rounded-2xl border border-white/15 bg-[#141414]">
            <header className="flex items-center justify-between gap-3 border-b border-white/10 p-4">
              <div className="min-w-0">
                <h2 id="activity-title" className="text-xl font-black">
                  📜 Admin Activity Log
                </h2>
                <p className="mt-1 text-xs text-zinc-500">
                  Who did what · live shared timeline
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsActivityOpen(false)}
                className="min-h-11 min-w-11 rounded-xl border border-white/10 text-lg"
                aria-label="Close activity log"
              >
                ×
              </button>
            </header>
            <div className="min-w-0 flex-1 overflow-y-auto p-4">
              {isActivityLoading && activities.length === 0 ? (
                <p className="py-12 text-center text-sm text-zinc-500">
                  Loading activity…
                </p>
              ) : activities.length === 0 ? (
                <p className="py-12 text-center text-sm text-zinc-500">
                  No administrative write actions have been recorded yet.
                </p>
              ) : (
                <ol className="flex min-w-0 flex-col gap-3">
                  {activities.map((activity) => (
                    <li
                      key={activity.id}
                      className="relative min-w-0 rounded-xl border border-white/10 bg-black/40 p-3 pl-4"
                    >
                      <span className="absolute -left-1 top-5 h-2.5 w-2.5 rounded-full bg-pink-400" />
                      <div className="flex min-w-0 items-center justify-between gap-2">
                        <span className="truncate rounded-full bg-pink-400/10 px-2 py-1 text-[10px] font-black text-pink-200">
                          {activity.adminName}
                        </span>
                        <time className="shrink-0 text-[9px] text-zinc-600">
                          {Number.isFinite(Date.parse(activity.timestamp))
                            ? localTimeFormatter.format(
                                new Date(activity.timestamp),
                              )
                            : activity.timestamp}
                        </time>
                      </div>
                      <p className="mt-2 break-words text-sm font-bold leading-relaxed text-zinc-200">
                        {activity.description}
                      </p>
                      <p className="mt-2 text-[9px] font-black tracking-[0.1em] text-zinc-600">
                        {activity.actionType.replaceAll("_", " ")}
                      </p>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
