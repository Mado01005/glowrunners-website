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

type RosterEntry = Readonly<{
  rowIndex: number;
  name: string;
  phone: string;
  paymentType: string;
  status: string;
}>;

type Dashboard = Readonly<{
  sheetName: string;
  isFallbackSheet: boolean;
  confirmed: number;
  pending: number;
  total: number;
  cashInHand: number;
  digitalRevenue: number;
  changeOwed: number;
  owedRunnerRows: readonly number[];
  roster: readonly RosterEntry[];
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
  name: string;
  phone: string;
  paymentMethod: "Cash" | "InstaPay";
  amountReceived: number;
  changeOwed: number;
  createdAt: string;
}>;

type RosterFilter = "total" | "confirmed" | "pending" | "owed";
type Feedback = Readonly<{
  tone: "idle" | "success" | "error";
  message: string;
}>;

const INITIAL_DASHBOARD: Dashboard = {
  sheetName: "Loading attendance…",
  isFallbackSheet: false,
  confirmed: 0,
  pending: 0,
  total: 0,
  cashInHand: 0,
  digitalRevenue: 0,
  changeOwed: 0,
  owedRunnerRows: [],
  roster: [],
};

const SCANNER_ID = "glowrunners-gate-scanner";
const SESSION_STORAGE_KEY = "glowrunners.admin.identity.v1";
const OFFLINE_QUEUE_KEY = "glowrunners.admin.offline-checkins.v1";
const WALK_INS_KEY = "glowrunners.admin.walk-ins.v1";
const ENTRY_FEE_EGP = readPublicInteger(
  process.env.NEXT_PUBLIC_GATE_ENTRY_FEE_EGP,
  70,
);
const WALK_IN_FEE_EGP = readPublicInteger(
  process.env.NEXT_PUBLIC_WALK_IN_FEE_EGP,
  250,
);
const EVENT_KICKOFF =
  process.env.NEXT_PUBLIC_EVENT_KICKOFF?.trim().slice(0, 40) || "8:00 AM";
const EVENT_LOCATION =
  process.env.NEXT_PUBLIC_EVENT_LOCATION?.trim().slice(0, 80) ||
  "Alexandria Bibliotheca";

const moneyFormatter = new Intl.NumberFormat("en-EG", {
  maximumFractionDigits: 0,
});
const localTimeFormatter = new Intl.DateTimeFormat("en-EG", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Africa/Cairo",
});

function readPublicInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

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
  return runner.status.toLocaleLowerCase("en-US").includes("confirmed");
}

function isCash(method: string): boolean {
  return method.toLocaleLowerCase("en-US").includes("cash");
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

    if (!Number.isSafeInteger(rowIndex) || rowIndex < 1 || !name || !phone) {
      return [];
    }

    return [
      {
        rowIndex,
        name: name.slice(0, 100),
        phone: normalizePhone(phone),
        paymentType:
          typeof candidate.paymentType === "string"
            ? candidate.paymentType.trim().slice(0, 40)
            : "Unknown",
        status:
          typeof candidate.status === "string"
            ? candidate.status.trim().slice(0, 40)
            : "",
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
    typeof value.name !== "string" ||
    typeof value.phone !== "string"
  ) {
    return null;
  }

  return {
    id: value.id.slice(0, 100),
    name: value.name.trim().slice(0, 100),
    phone: normalizePhone(value.phone),
    paymentMethod: value.paymentMethod === "InstaPay" ? "InstaPay" : "Cash",
    amountReceived: Math.max(0, Number(value.amountReceived) || 0),
    changeOwed: Math.max(0, Number(value.changeOwed) || 0),
    createdAt:
      typeof value.createdAt === "string"
        ? value.createdAt
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

function eventDateLabels() {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "Africa/Cairo",
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  const parts = formatter.formatToParts(new Date());
  const weekday =
    parts.find((part) => part.type === "weekday")?.value || "Friday";
  const month = parts.find((part) => part.type === "month")?.value || "July";
  const day = Number(parts.find((part) => part.type === "day")?.value || 31);

  return {
    badge: `${weekday.slice(0, 3).toUpperCase()} - ${ordinal(day)} OF ${month.toUpperCase()}`,
    day: weekday,
    report: `${weekday} ${day}${ordinal(day).replace(String(day), "").toLocaleLowerCase("en-US")} ${month}`,
  };
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
  const [offlineQueue, setOfflineQueue] = useState<OfflineCheckIn[]>([]);
  const [walkIns, setWalkIns] = useState<WalkIn[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [isActivityOpen, setIsActivityOpen] = useState(false);
  const [isActivityLoading, setIsActivityLoading] = useState(false);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [postRunSignups, setPostRunSignups] = useState(0);
  const [walkInName, setWalkInName] = useState("");
  const [walkInPhone, setWalkInPhone] = useState("");
  const [walkInMethod, setWalkInMethod] =
    useState<"Cash" | "InstaPay">("Cash");
  const [expenseDescription, setExpenseDescription] = useState("");
  const [expenseAmount, setExpenseAmount] = useState("");
  const [expenseMethod, setExpenseMethod] =
    useState<"Cash" | "Digital">("Cash");
  const [isExpenseSaving, setIsExpenseSaving] = useState(false);
  const [isWalkInSaving, setIsWalkInSaving] = useState(false);
  const syncInFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const scanHandlerRef = useRef<(decoded: string) => void>(() => undefined);
  const lastScannedRef = useRef<{ value: string; at: number }>({
    value: "",
    at: 0,
  });
  const dateLabels = useMemo(eventDateLabels, []);

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

  const refreshDashboard = useCallback(async () => {
    setIsRefreshing(true);

    try {
      const response = await fetch("/api/admin/stats", { cache: "no-store" });
      const payload = await readJson(response);

      if (handleUnauthorized(response)) {
        return;
      }

      const parsed = parseDashboard(payload);

      if (!response.ok || parsed === null) {
        throw new Error(readError(payload, "Unable to load gate statistics."));
      }

      if (mountedRef.current) {
        setDashboard(parsed);
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
            { cache: "no-store" },
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
    setWalkIns(parseStoredArray(WALK_INS_KEY, parseWalkIn));

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

  useEffect(() => {
    try {
      window.localStorage.setItem(WALK_INS_KEY, JSON.stringify(walkIns));
    } catch {
      // The action remains logged remotely even if local history is full.
    }
  }, [walkIns]);

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

  const beginPayment = useCallback(
    async (runner: RosterEntry) => {
      if (isConfirmed(runner)) {
        setFeedback({
          tone: "idle",
          message: `${runner.name} is already confirmed.`,
        });
        return;
      }

      const existingLock = locks.find(
        (lock) =>
          lock.runnerRow === runner.rowIndex ||
          normalizePhone(lock.runnerPhone) === normalizePhone(runner.phone),
      );

      if (
        existingLock &&
        existingLock.adminPhone !== activeAdmin?.phoneE164
      ) {
        setFeedback({
          tone: "error",
          message: `⚡ ${existingLock.adminName} is already processing ${runner.name}.`,
        });
        return;
      }

      const method: "Cash" | "InstaPay" = isCash(runner.paymentType)
        ? "Cash"
        : "InstaPay";

      if (!navigator.onLine) {
        setPaymentDraft({
          runner,
          lockId: null,
          paymentMethod: method,
          amountReceived: String(ENTRY_FEE_EGP),
        });
        setFeedback({
          tone: "idle",
          message: "Offline mode: this check-in will be saved locally.",
        });
        return;
      }

      try {
        const response = await fetch("/api/admin/runner-locks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "acquire",
            sheetName: dashboard.sheetName,
            runnerRow: runner.rowIndex,
            runnerName: runner.name,
            runnerPhone: runner.phone,
          }),
        });
        const payload = await readJson(response);

        if (handleUnauthorized(response)) {
          return;
        }

        if (
          !response.ok ||
          !isRecord(payload) ||
          !isRecord(payload.lock) ||
          typeof payload.lock.id !== "string"
        ) {
          const owner =
            isRecord(payload) &&
            isRecord(payload.lock) &&
            typeof payload.lock.adminName === "string"
              ? payload.lock.adminName
              : "another admin";
          throw new Error(
            response.status === 409
              ? `⚡ ${owner} is already processing ${runner.name}.`
              : readError(payload, "Unable to reserve this runner."),
          );
        }

        setPaymentDraft({
          runner,
          lockId: payload.lock.id,
          paymentMethod: method,
          amountReceived: String(ENTRY_FEE_EGP),
        });
        void refreshLocks();
      } catch (error) {
        if (!navigator.onLine) {
          setPaymentDraft({
            runner,
            lockId: null,
            paymentMethod: method,
            amountReceived: String(ENTRY_FEE_EGP),
          });
          return;
        }

        setFeedback({
          tone: "error",
          message:
            error instanceof Error
              ? error.message
              : "Unable to reserve this runner.",
        });
      }
    },
    [
      activeAdmin?.phoneE164,
      dashboard.sheetName,
      handleUnauthorized,
      locks,
      refreshLocks,
    ],
  );

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
        headers: { "Content-Type": "application/json" },
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

  useEffect(() => {
    scanHandlerRef.current = (decoded: string) => {
      const phone = normalizePhone(decoded);
      const now = Date.now();

      if (
        !phone ||
        (lastScannedRef.current.value === phone &&
          now - lastScannedRef.current.at < 2_000)
      ) {
        return;
      }

      lastScannedRef.current = { value: phone, at: now };
      const runner = dashboard.roster.find(
        (candidate) => normalizePhone(candidate.phone) === phone,
      );

      if (!runner) {
        setFeedback({
          tone: "error",
          message: "No runner matches this ticket. Refresh the roster and retry.",
        });
        return;
      }

      void beginPayment(runner);
    };
  }, [beginPayment, dashboard.roster]);

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

        scanner = new qrLibrary.Html5Qrcode(SCANNER_ID);
        await scanner.start(
          { facingMode: "environment" },
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
              "Camera unavailable. Use the roster search or allow camera access and retry.",
          });
        }
      }
    })();

    return () => {
      cancelled = true;

      if (scanner) {
        void stopScanner(scanner);
      }
    };
  }, [isScannerEnabled, scannerKey]);

  const queuedPhones = useMemo(
    () => new Set(offlineQueue.map((item) => normalizePhone(item.phone))),
    [offlineQueue],
  );
  const queuedNewCount = useMemo(
    () =>
      dashboard.roster.filter(
        (runner) =>
          queuedPhones.has(normalizePhone(runner.phone)) &&
          !isConfirmed(runner),
      ).length,
    [dashboard.roster, queuedPhones],
  );
  const walkInCash = walkIns.reduce(
    (sum, runner) =>
      sum + (runner.paymentMethod === "Cash" ? runner.amountReceived : 0),
    0,
  );
  const walkInDigital = walkIns.reduce(
    (sum, runner) =>
      sum + (runner.paymentMethod === "InstaPay" ? runner.amountReceived : 0),
    0,
  );
  const walkInChange = walkIns.reduce(
    (sum, runner) => sum + runner.changeOwed,
    0,
  );
  const totalExpenses = expenses.reduce(
    (sum, expense) => sum + Number(expense.amountEgp || 0),
    0,
  );
  const displayedConfirmed =
    dashboard.confirmed + queuedNewCount + walkIns.length;
  const displayedTotal = dashboard.total + walkIns.length;
  const displayedPending = Math.max(
    0,
    dashboard.pending - queuedNewCount,
  );
  const displayedCash = dashboard.cashInHand + walkInCash;
  const displayedDigital = dashboard.digitalRevenue + walkInDigital;
  const displayedChange = dashboard.changeOwed + walkInChange;
  const owedRows = useMemo(
    () => {
      const rows = new Set(dashboard.owedRunnerRows);

      for (const item of offlineQueue) {
        if (item.changeOwed > 0) {
          rows.add(item.runnerRow);
        }
      }

      return rows;
    },
    [dashboard.owedRunnerRows, offlineQueue],
  );

  const filteredRoster = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("en-US");
    const phoneQuery = search.replace(/\D/g, "");

    return dashboard.roster
      .filter((runner) => {
        const confirmed =
          isConfirmed(runner) ||
          queuedPhones.has(normalizePhone(runner.phone));

        if (rosterFilter === "confirmed" && !confirmed) {
          return false;
        }

        if (rosterFilter === "pending" && confirmed) {
          return false;
        }

        if (rosterFilter === "owed" && !owedRows.has(runner.rowIndex)) {
          return false;
        }

        return (
          !query ||
          runner.name.toLocaleLowerCase("en-US").includes(query) ||
          (phoneQuery.length > 0 && runner.phone.includes(phoneQuery))
        );
      })
      .slice(0, 150);
  }, [
    dashboard.roster,
    owedRows,
    queuedPhones,
    rosterFilter,
    search,
  ]);

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

    if (!name || !/^(?:10|11|12|15)\d{8}$/.test(phone)) {
      setFeedback({
        tone: "error",
        message: "Enter the walk-in runner’s name and Egyptian mobile number.",
      });
      return;
    }

    const item: WalkIn = {
      id: crypto.randomUUID(),
      name,
      phone,
      paymentMethod: walkInMethod,
      amountReceived: WALK_IN_FEE_EGP,
      changeOwed: 0,
      createdAt: new Date().toISOString(),
    };
    setIsWalkInSaving(true);

    try {
      const response = await fetch("/api/admin/activity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actionType: "WALK_IN_ADDED",
          operationId: `walk-in:${item.id}`,
          description: `${activeAdmin?.displayName ?? "Admin"} added walk-in Runner: ${name}`,
        }),
      });
      const payload = await readJson(response);

      if (handleUnauthorized(response)) {
        return;
      }

      if (!response.ok) {
        throw new Error(readError(payload, "Unable to log this walk-in."));
      }

      setWalkIns((current) => [item, ...current].slice(0, 5_000));
      setWalkInName("");
      setWalkInPhone("");
      setFeedback({
        tone: "success",
        message: `${name} added as a walk-in.`,
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
    const report = [
      `📊 GlowRunners Meetup Report – ${dateLabels.report}`,
      `👥 Total Attendees: ${displayedConfirmed} (${dashboard.confirmed + queuedNewCount} Pre-registered, ${walkIns.length} Walk-ins)`,
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
            📅 {dateLabels.badge}
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
          {[
            ["KICKOFF", EVENT_KICKOFF],
            ["LOCATION", EVENT_LOCATION],
            ["DAY", dateLabels.day],
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
          <div className="relative flex min-h-[270px] w-full min-w-0 items-center justify-center overflow-hidden rounded-xl bg-black">
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
                      ? "Camera is inactive"
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
        </section>

        <section className="min-w-0 rounded-2xl border border-white/10 bg-[#151515] p-3">
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-lg font-black">Roster Explorer</h2>
              <p className="mt-1 truncate text-[11px] text-zinc-500">
                {dashboard.sheetName}
                {dashboard.isFallbackSheet ? " · fallback tab" : ""}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void refreshDashboard()}
              disabled={isRefreshing}
              className="min-h-11 shrink-0 rounded-lg border border-white/10 px-3 text-xs font-black text-zinc-300 disabled:opacity-60"
            >
              {isRefreshing ? "…" : "Refresh"}
            </button>
          </div>

          <div className="mt-3 grid min-w-0 grid-cols-4 gap-1.5">
            {[
              ["total", "👥 Total"],
              ["confirmed", "🟢 Confirmed"],
              ["pending", "🟡 Pending"],
              ["owed", "🔴 Owed"],
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setRosterFilter(value as RosterFilter)}
                className={`min-h-11 min-w-0 rounded-lg px-1 text-[9px] font-black ${
                  rosterFilter === value
                    ? "bg-white text-black"
                    : "border border-white/10 bg-black/30 text-zinc-400"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <label className="mt-2 block">
            <span className="sr-only">Search roster</span>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="🔍 Search by name or phone number..."
              className="min-h-12 w-full min-w-0 rounded-xl border border-white/10 bg-black px-4 text-sm text-white outline-none placeholder:text-zinc-600 focus:border-pink-400"
            />
          </label>

          <div className="mt-3 flex min-w-0 flex-col gap-2">
            {filteredRoster.length === 0 ? (
              <div className="rounded-xl border border-dashed border-white/10 px-4 py-8 text-center text-sm text-zinc-500">
                No runners match this view.
              </div>
            ) : (
              filteredRoster.map((runner) => {
                const confirmed =
                  isConfirmed(runner) ||
                  queuedPhones.has(normalizePhone(runner.phone));
                const lock = lockByRow.get(runner.rowIndex);
                const lockedByAnother =
                  lock && lock.adminPhone !== activeAdmin?.phoneE164;

                return (
                  <div
                    key={`${runner.rowIndex}:${runner.phone}`}
                    className="flex min-w-0 items-center gap-3 rounded-xl border border-white/10 bg-black/40 p-3"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-black">
                        {runner.name}
                      </p>
                      <p className="mt-1 truncate text-[11px] text-zinc-500">
                        0{runner.phone} · {runner.paymentType}
                      </p>
                      {lockedByAnother ? (
                        <p className="mt-1 truncate text-[10px] font-bold text-amber-300">
                          ⚡ {lock.adminName} is processing…
                        </p>
                      ) : queuedPhones.has(normalizePhone(runner.phone)) ? (
                        <p className="mt-1 text-[10px] font-bold text-sky-300">
                          Saved locally · awaiting sync
                        </p>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      onClick={() => void beginPayment(runner)}
                      disabled={confirmed || Boolean(lockedByAnother)}
                      className={`min-h-11 shrink-0 rounded-lg px-3 text-xs font-black ${
                        confirmed
                          ? "bg-emerald-500/15 text-emerald-300"
                          : "bg-gradient-to-r from-orange-500 to-pink-500 text-white"
                      } disabled:cursor-not-allowed`}
                    >
                      {confirmed ? "Confirmed" : "Process"}
                    </button>
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
            onClick={() => void syncOfflineQueue()}
            disabled={offlineQueue.length === 0}
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
              PHONE NUMBER
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
            <button
              type="submit"
              disabled={isWalkInSaving}
              className="min-h-12 w-full rounded-xl bg-orange-500 px-4 text-sm font-black text-black disabled:opacity-60"
            >
              {isWalkInSaving
                ? "Saving…"
                : `+ Confirm Walk-In · ${money(WALK_IN_FEE_EGP)}`}
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
