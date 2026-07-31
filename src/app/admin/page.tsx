"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type { Html5Qrcode } from "html5-qrcode";

type Feedback = Readonly<{
  tone: "success" | "error" | "idle";
  message: string;
}>;

type DashboardState = Readonly<{
  confirmedCount: number;
  totalCount: number;
  cashInHand: number;
  digitalRevenue: number;
  totalChangeOwed: number;
  sheetName: string;
  isFallbackSheet: boolean;
}>;

type RosterEntry = Readonly<{
  rowIndex: number;
  name: string;
  phone: string;
  paymentType: string;
  status: string;
}>;

type DashboardPayload = Readonly<{
  confirmedCount: number;
  pendingCount?: number;
  totalCount?: number;
  cashInHand?: number;
  digitalRevenue?: number;
  totalChangeOwed?: number;
  sheetName: string;
  isFallbackSheet?: boolean;
  roster?: readonly RosterEntry[];
}>;

type PaymentMethod = "cash" | "instapay";
type PaymentFilter = "all" | PaymentMethod;

type WalkInRunner = Readonly<{
  id: string;
  name: string;
  phone: string;
  paymentMethod: PaymentMethod;
  feeAmount: number;
  amountReceived: number;
  changeOwed: number;
  createdAt: number;
}>;

type WalkInDraft = Readonly<{
  name: string;
  phone: string;
  paymentMethod: PaymentMethod;
  amountReceived: string;
}>;

type WalkInInput = Readonly<{
  name: string;
  phone: string;
  paymentMethod: PaymentMethod;
  amountReceived: unknown;
}>;

type WalkInMetrics = Readonly<{
  confirmedCount: number;
  cashInHand: number;
  digitalRevenue: number;
  totalChangeOwed: number;
}>;

type JsonObject = Record<string, unknown>;

const SCANNER_ELEMENT_ID = "glowrunners-qr-reader";
const WALK_INS_STORAGE_KEY = "glowrunners.admin.walk-ins.v1";
const REFRESH_INTERVAL_MS = 10_000;
const REQUEST_TIMEOUT_MS = 12_000;
const SCAN_COOLDOWN_MS = 1_800;
const MAX_STORED_WALK_INS = 5_000;
const ROSTER_RENDER_LIMIT = 100;

const EVENT_KICKOFF =
  readBoundedString(process.env.NEXT_PUBLIC_EVENT_KICKOFF, 40) ?? "6:00 AM";
const EVENT_LOCATION =
  readBoundedString(process.env.NEXT_PUBLIC_EVENT_LOCATION, 80) ??
  "Main Gate · Check-in Lane";
const WALK_IN_FEE_EGP =
  parseNonNegativeInteger(process.env.NEXT_PUBLIC_WALK_IN_FEE_EGP) ?? 250;

const INITIAL_DASHBOARD: DashboardState = {
  confirmedCount: 0,
  totalCount: 0,
  cashInHand: 0,
  digitalRevenue: 0,
  totalChangeOwed: 0,
  sheetName: "Loading active tab...",
  isFallbackSheet: false,
};

const INITIAL_FEEDBACK: Feedback = {
  tone: "idle",
  message: "Starting camera...",
};

const INITIAL_WALK_IN_DRAFT: WalkInDraft = {
  name: "",
  phone: "",
  paymentMethod: "cash",
  amountReceived: String(WALK_IN_FEE_EGP),
};

const PAYMENT_FILTERS = [
  { value: "all", label: "All" },
  { value: "cash", label: "Cash" },
  { value: "instapay", label: "InstaPay" },
] as const satisfies ReadonlyArray<{
  value: PaymentFilter;
  label: string;
}>;

function matchesPaymentFilter(
  paymentType: string,
  filter: PaymentFilter,
): boolean {
  if (filter === "all") {
    return true;
  }

  const normalized = paymentType.trim().toLocaleLowerCase();

  return filter === "cash"
    ? normalized.includes("cash")
    : normalized.includes("instapay") || normalized.includes("insta pay");
}

const COUNT_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

const CURRENCY_FORMATTER = new Intl.NumberFormat("en-EG", {
  style: "currency",
  currency: "EGP",
  currencyDisplay: "narrowSymbol",
  maximumFractionDigits: 0,
});

const TIME_FORMATTER = new Intl.DateTimeFormat("en-EG", {
  hour: "numeric",
  minute: "2-digit",
  timeZone: "Africa/Cairo",
});

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBoundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();

  if (!normalized || normalized.length > maxLength) {
    return null;
  }

  return normalized;
}

function parseNonNegativeInteger(value: unknown): number | null {
  let parsed: number;

  if (typeof value === "number") {
    parsed = value;
  } else if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    parsed = Number(value.trim());
  } else {
    return null;
  }

  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseOptionalNonNegativeInteger(
  value: unknown,
): number | null | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  return parseNonNegativeInteger(value);
}

function readOptionalBoundedString(
  value: unknown,
  maxLength: number,
): string | null {
  if (typeof value !== "string" || value.length > maxLength) {
    return null;
  }

  return value.trim();
}

function parseRosterEntry(value: unknown): RosterEntry | null {
  if (!isJsonObject(value)) {
    return null;
  }

  const rowIndex = parseNonNegativeInteger(value.rowIndex);
  const name = readBoundedString(value.name, 100);
  const rawPhone = readBoundedString(value.phone, 24);
  const paymentType = readBoundedString(value.paymentType, 40);
  const status = readOptionalBoundedString(value.status, 40);
  const phone = rawPhone?.replace(/\D/g, "") ?? "";

  if (
    rowIndex === null ||
    rowIndex < 1 ||
    name === null ||
    phone.length < 7 ||
    phone.length > 15 ||
    paymentType === null ||
    status === null
  ) {
    return null;
  }

  return {
    rowIndex,
    name,
    phone,
    paymentType,
    status,
  };
}

function parseRoster(value: unknown): RosterEntry[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const roster: RosterEntry[] = [];
  const seenRowIndices = new Set<number>();

  for (const candidate of value) {
    const runner = parseRosterEntry(candidate);

    if (runner !== null && !seenRowIndices.has(runner.rowIndex)) {
      seenRowIndices.add(runner.rowIndex);
      roster.push(runner);
    }
  }

  return roster;
}

function isRosterEntryConfirmed(runner: RosterEntry): boolean {
  return runner.status.toLocaleLowerCase().includes("confirmed");
}

function safeAddNonNegativeIntegers(...values: readonly number[]): number {
  let total = 0;

  for (const value of values) {
    const normalized = parseNonNegativeInteger(value) ?? 0;

    if (total > Number.MAX_SAFE_INTEGER - normalized) {
      return Number.MAX_SAFE_INTEGER;
    }

    total += normalized;
  }

  return total;
}

function safeSubtractNonNegativeIntegers(
  minuend: number,
  subtrahend: number,
): number {
  const safeMinuend = parseNonNegativeInteger(minuend) ?? 0;
  const safeSubtrahend = parseNonNegativeInteger(subtrahend) ?? 0;

  return Math.max(0, safeMinuend - safeSubtrahend);
}

function parseDashboardPayload(payload: unknown): DashboardPayload | null {
  if (!isJsonObject(payload) || payload.success !== true) {
    return null;
  }

  const confirmedCount = parseNonNegativeInteger(payload.confirmedCount);
  const pendingCount = parseOptionalNonNegativeInteger(payload.pendingCount);
  const totalCount = parseOptionalNonNegativeInteger(payload.totalCount);
  const cashInHand = parseOptionalNonNegativeInteger(payload.cashInHand);
  const digitalRevenue = parseOptionalNonNegativeInteger(
    payload.digitalRevenue,
  );
  const totalChangeOwed = parseOptionalNonNegativeInteger(
    payload.totalChangeOwed,
  );
  const sheetName = readBoundedString(payload.sheetName, 120);
  const roster =
    payload.roster === undefined ? undefined : parseRoster(payload.roster);
  const isFallbackSheet =
    payload.isFallbackSheet === undefined
      ? undefined
      : payload.isFallbackSheet === true;

  if (
    confirmedCount === null ||
    pendingCount === null ||
    totalCount === null ||
    cashInHand === null ||
    digitalRevenue === null ||
    totalChangeOwed === null ||
    sheetName === null ||
    roster === null
  ) {
    return null;
  }

  return {
    confirmedCount,
    pendingCount,
    totalCount,
    cashInHand,
    digitalRevenue,
    totalChangeOwed,
    sheetName,
    roster,
    isFallbackSheet,
  };
}

function mergeDashboardPayload(
  current: DashboardState,
  payload: DashboardPayload,
): DashboardState {
  const isSameSheet = current.sheetName === payload.sheetName;
  const confirmedCount = isSameSheet
    ? Math.max(current.confirmedCount, payload.confirmedCount)
    : payload.confirmedCount;
  const impliedTotal =
    payload.pendingCount === undefined
      ? undefined
      : safeAddNonNegativeIntegers(
          payload.confirmedCount,
          payload.pendingCount,
        );
  const fallbackTotal = isSameSheet
    ? Math.max(current.totalCount, confirmedCount)
    : confirmedCount;
  const totalCount = Math.max(
    confirmedCount,
    payload.totalCount ?? impliedTotal ?? fallbackTotal,
  );

  return {
    confirmedCount,
    totalCount,
    cashInHand:
      payload.cashInHand ?? (isSameSheet ? current.cashInHand : 0),
    digitalRevenue:
      payload.digitalRevenue ?? (isSameSheet ? current.digitalRevenue : 0),
    totalChangeOwed:
      payload.totalChangeOwed ??
      (isSameSheet ? current.totalChangeOwed : 0),
    sheetName: payload.sheetName,
    isFallbackSheet: payload.isFallbackSheet ?? false,
  };
}

function readApiError(payload: unknown, fallback: string): string {
  if (!isJsonObject(payload)) {
    return fallback;
  }

  return readBoundedString(payload.error, 240) ?? fallback;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    const payload: unknown = await response.json();
    return payload;
  } catch {
    return null;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isPaymentMethod(value: unknown): value is PaymentMethod {
  return value === "cash" || value === "instapay";
}

function parseWalkInRunner(value: unknown): WalkInRunner | null {
  if (!isJsonObject(value)) {
    return null;
  }

  const id = readBoundedString(value.id, 100);
  const name = readBoundedString(value.name, 80);
  const phone =
    typeof value.phone === "string" && value.phone.length <= 20
      ? value.phone.trim()
      : null;
  const feeAmount = parseNonNegativeInteger(value.feeAmount);
  const amountReceived = parseNonNegativeInteger(value.amountReceived);
  const changeOwed = parseNonNegativeInteger(value.changeOwed);
  const createdAt = parseNonNegativeInteger(value.createdAt);

  if (
    id === null ||
    name === null ||
    phone === null ||
    !isPaymentMethod(value.paymentMethod) ||
    feeAmount === null ||
    amountReceived === null ||
    changeOwed === null ||
    createdAt === null ||
    feeAmount > amountReceived ||
    changeOwed > amountReceived ||
    Number.isNaN(new Date(createdAt).getTime())
  ) {
    return null;
  }

  return {
    id,
    name,
    phone,
    paymentMethod: value.paymentMethod,
    feeAmount,
    amountReceived,
    changeOwed,
    createdAt,
  };
}

function parseStoredWalkIns(value: unknown): WalkInRunner[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const parsed: WalkInRunner[] = [];
  const seenIds = new Set<string>();

  for (const candidate of value.slice(0, MAX_STORED_WALK_INS)) {
    const walkIn = parseWalkInRunner(candidate);

    if (walkIn !== null && !seenIds.has(walkIn.id)) {
      seenIds.add(walkIn.id);
      parsed.push(walkIn);
    }
  }

  return parsed;
}

function createWalkInId(): string {
  if (typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }

  return `walk-in-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function formatCount(value: number): string {
  return COUNT_FORMATTER.format(parseNonNegativeInteger(value) ?? 0);
}

function formatCurrency(value: number): string {
  return CURRENCY_FORMATTER.format(parseNonNegativeInteger(value) ?? 0);
}

function getSummaryCountSizeClass(value: number): string {
  const formattedLength = formatCount(value).length;

  if (formattedLength > 6) {
    return "text-base";
  }

  if (formattedLength > 4) {
    return "text-xl";
  }

  if (formattedLength > 3) {
    return "text-2xl";
  }

  return "text-3xl";
}

async function stopAndClearScanner(scanner: Html5Qrcode): Promise<void> {
  try {
    const state = scanner.getState();

    if (state === 2 || state === 3) {
      await scanner.stop();
    }
  } catch {
    // A scanner that never reached the running state does not need stopping.
  }

  try {
    scanner.clear();
  } catch {
    // A failed scanner can already be clear by the time cleanup executes.
  }
}

export default function AdminPage() {
  const isMountedRef = useRef(false);
  const scanLockedRef = useRef(false);
  const refreshAbortControllerRef = useRef<AbortController | null>(null);
  const scanAbortControllerRef = useRef<AbortController | null>(null);
  const scanUnlockTimeoutRef = useRef<number | null>(null);
  const flashTimeoutRef = useRef<number | null>(null);
  const scannerShutdownRef = useRef<Promise<void>>(Promise.resolve());
  const rowCheckInControllersRef = useRef<Map<number, AbortController>>(
    new Map(),
  );

  const [dashboard, setDashboard] =
    useState<DashboardState>(INITIAL_DASHBOARD);
  const [feedback, setFeedback] = useState<Feedback>(INITIAL_FEEDBACK);
  // Route middleware has already verified the signed HttpOnly cookie before
  // this client component is rendered.
  const [adminToken] = useState<string>("cookie-session");
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [isCheckingInRow, setIsCheckingInRow] = useState<
    Record<number, boolean>
  >({});
  const [walkIns, setWalkIns] = useState<WalkInRunner[]>([]);
  const [walkInDraft, setWalkInDraft] = useState<WalkInDraft>(
    INITIAL_WALK_IN_DRAFT,
  );
  const [paymentFilter, setPaymentFilter] =
    useState<PaymentFilter>("all");
  const [hasHydratedWalkIns, setHasHydratedWalkIns] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isScanBusy, setIsScanBusy] = useState(false);
  const [isFlashActive, setIsFlashActive] = useState(false);
  const [scannerRestartKey, setScannerRestartKey] = useState(0);
  const [scannerStatus, setScannerStatus] = useState<
    "starting" | "live" | "offline"
  >("starting");
  const [dashboardStatus, setDashboardStatus] = useState<
    "loading" | "ready" | "error"
  >("loading");
  const [dashboardError, setDashboardError] = useState<string | null>(null);

  useEffect(() => {
    const rowCheckInControllers = rowCheckInControllersRef.current;
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
      scanLockedRef.current = false;

      refreshAbortControllerRef.current?.abort();
      scanAbortControllerRef.current?.abort();
      rowCheckInControllers.forEach((controller) => {
        controller.abort();
      });
      rowCheckInControllers.clear();

      if (scanUnlockTimeoutRef.current !== null) {
        window.clearTimeout(scanUnlockTimeoutRef.current);
      }

      if (flashTimeoutRef.current !== null) {
        window.clearTimeout(flashTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    try {
      const storedValue = window.localStorage.getItem(WALK_INS_STORAGE_KEY);
      const parsedValue: unknown = storedValue === null ? [] : JSON.parse(storedValue);
      setWalkIns(parseStoredWalkIns(parsedValue));
    } catch {
      setWalkIns([]);
      setFeedback({
        tone: "error",
        message: "Saved walk-ins could not be restored on this device.",
      });
    } finally {
      setHasHydratedWalkIns(true);
    }
  }, []);

  useEffect(() => {
    if (!hasHydratedWalkIns) {
      return;
    }

    try {
      window.localStorage.setItem(WALK_INS_STORAGE_KEY, JSON.stringify(walkIns));
    } catch {
      setFeedback({
        tone: "error",
        message: "Walk-in saved in memory, but device storage is unavailable.",
      });
    }
  }, [hasHydratedWalkIns, walkIns]);

  const scheduleScanUnlock = useCallback(() => {
    if (!isMountedRef.current) {
      scanLockedRef.current = false;
      return;
    }

    if (scanUnlockTimeoutRef.current !== null) {
      window.clearTimeout(scanUnlockTimeoutRef.current);
    }

    scanUnlockTimeoutRef.current = window.setTimeout(() => {
      scanLockedRef.current = false;
      scanUnlockTimeoutRef.current = null;

      if (isMountedRef.current) {
        setIsScanBusy(false);
      }
    }, SCAN_COOLDOWN_MS);
  }, []);

  const triggerSuccessFlash = useCallback(() => {
    if (!isMountedRef.current) {
      return;
    }

    if (flashTimeoutRef.current !== null) {
      window.clearTimeout(flashTimeoutRef.current);
    }

    setIsFlashActive(true);

    flashTimeoutRef.current = window.setTimeout(() => {
      flashTimeoutRef.current = null;

      if (isMountedRef.current) {
        setIsFlashActive(false);
      }
    }, 650);
  }, []);

  const playSuccessChime = useCallback(async () => {
    const AudioContextClass = window.AudioContext;

    if (typeof AudioContextClass !== "function") {
      return;
    }

    let audioContext: AudioContext | null = null;

    try {
      const context = new AudioContextClass();
      audioContext = context;

      if (context.state === "suspended") {
        await context.resume();
      }

      const gain = context.createGain();
      const firstTone = context.createOscillator();
      const secondTone = context.createOscillator();
      const now = context.currentTime;

      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.16, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.42);
      gain.connect(context.destination);

      firstTone.frequency.setValueAtTime(660, now);
      firstTone.connect(gain);
      firstTone.start(now);
      firstTone.stop(now + 0.18);

      secondTone.frequency.setValueAtTime(990, now + 0.16);
      secondTone.connect(gain);
      secondTone.addEventListener(
        "ended",
        () => {
          void context.close().catch(() => undefined);
        },
        { once: true },
      );
      secondTone.start(now + 0.16);
      secondTone.stop(now + 0.42);
    } catch {
      if (audioContext !== null) {
        void audioContext.close().catch(() => undefined);
      }
    }
  }, []);

  const handleUnauthorizedResponse = useCallback((response: Response) => {
    if (response.status !== 401 && response.status !== 403) {
      return false;
    }

    refreshAbortControllerRef.current?.abort();
    scanAbortControllerRef.current?.abort();
    rowCheckInControllersRef.current.forEach((controller) => {
      controller.abort();
    });
    rowCheckInControllersRef.current.clear();
    setIsCheckingInRow({});

    // Preserve the historical rule: browser session storage is only cleared
    // for an explicit 401, never for server failures or a middleware 403.
    if (response.status === 401) {
      try {
        window.sessionStorage.removeItem("glowrunners.admin.token.v1");
      } catch {
        // Redirecting to the cookie login remains sufficient.
      }
    }

    const next = `${window.location.pathname}${window.location.search}`;
    window.location.assign(`/admin/login?next=${encodeURIComponent(next)}`);

    return true;
  }, []);

  const refreshDashboard = useCallback(async () => {
    if (!isMountedRef.current || !adminToken || scanLockedRef.current) {
      return;
    }

    refreshAbortControllerRef.current?.abort();

    const controller = new AbortController();
    let didTimeout = false;
    let failureMessage =
      "Unable to load dashboard totals. Check the server connection.";

    refreshAbortControllerRef.current = controller;
    setIsRefreshing(true);

    const timeoutId = window.setTimeout(() => {
      didTimeout = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch("/api/scan-ticket", {
        cache: "no-store",
        signal: controller.signal,
      });
      const payload = await readJson(response);

      if (handleUnauthorizedResponse(response)) {
        return;
      }

      const parsedPayload = parseDashboardPayload(payload);

      if (!response.ok || parsedPayload === null) {
        failureMessage = readApiError(
          payload,
          "The server returned an invalid dashboard response.",
        );
        throw new Error(failureMessage);
      }

      if (isMountedRef.current) {
        setDashboard((current) =>
          mergeDashboardPayload(current, parsedPayload),
        );
        setDashboardStatus("ready");
        setDashboardError(null);

        if (parsedPayload.roster !== undefined) {
          setRoster([...parsedPayload.roster]);
        }
      }
    } catch (error) {
      if (!isMountedRef.current) {
        return;
      }

      if (isAbortError(error) && !didTimeout) {
        return;
      }

      const message = didTimeout
          ? "Dashboard refresh timed out. Check the connection and retry."
          : failureMessage;

      setDashboardStatus("error");
      setDashboardError(message);
    } finally {
      window.clearTimeout(timeoutId);

      if (refreshAbortControllerRef.current === controller) {
        refreshAbortControllerRef.current = null;

        if (isMountedRef.current) {
          setIsRefreshing(false);
        }
      }
    }
  }, [adminToken, handleUnauthorizedResponse]);

  const handleScan = useCallback(
    async (decodedText: string) => {
      if (!adminToken) {
        return;
      }

      if (!decodedText.trim() || scanLockedRef.current) {
        return;
      }

      scanLockedRef.current = true;
      setIsScanBusy(true);

      const phone = decodedText.replace(/\D/g, "");

      if (phone.length < 7 || phone.length > 15) {
        setFeedback({
          tone: "error",
          message: "This QR code does not contain a valid ticket phone.",
        });
        scheduleScanUnlock();
        return;
      }

      refreshAbortControllerRef.current?.abort();

      const controller = new AbortController();
      let didTimeout = false;
      let failureMessage = "Scan failed. Check the connection and try again.";

      scanAbortControllerRef.current = controller;

      const timeoutId = window.setTimeout(() => {
        didTimeout = true;
        controller.abort();
      }, REQUEST_TIMEOUT_MS);

      try {
        const response = await fetch("/api/scan-ticket", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ phone }),
          signal: controller.signal,
        });
        const payload = await readJson(response);

        if (handleUnauthorizedResponse(response)) {
          return;
        }

        const parsedPayload = parseDashboardPayload(payload);
        const runnerName = isJsonObject(payload)
          ? readBoundedString(payload.name, 100)
          : null;
        const checkedInRowIndex = isJsonObject(payload)
          ? parseNonNegativeInteger(payload.rowIndex)
          : null;

        if (!response.ok || parsedPayload === null || runnerName === null) {
          failureMessage = readApiError(
            payload,
            "Unable to check in this ticket.",
          );
          throw new Error(failureMessage);
        }

        if (!isMountedRef.current) {
          return;
        }

        setDashboard((current) =>
          mergeDashboardPayload(current, parsedPayload),
        );
        setRoster((current) =>
          current.map((runner) => {
            const matchesRow =
              checkedInRowIndex !== null &&
              runner.rowIndex === checkedInRowIndex;
            const matchesPhone = runner.phone === phone;

            return matchesRow || matchesPhone
              ? { ...runner, status: "✅ CONFIRMED" }
              : runner;
          }),
        );
        setFeedback({
          tone: "success",
          message: `${runnerName} is checked in.`,
        });
        triggerSuccessFlash();
        void playSuccessChime();
      } catch (error) {
        if (!isMountedRef.current) {
          return;
        }

        if (isAbortError(error) && !didTimeout) {
          return;
        }

        setFeedback({
          tone: "error",
          message: didTimeout
            ? "Check-in timed out. Keep the ticket visible and try again."
            : failureMessage,
        });
      } finally {
        window.clearTimeout(timeoutId);

        if (scanAbortControllerRef.current === controller) {
          scanAbortControllerRef.current = null;
        }

        scheduleScanUnlock();
      }
    },
    [
      adminToken,
      handleUnauthorizedResponse,
      playSuccessChime,
      scheduleScanUnlock,
      triggerSuccessFlash,
    ],
  );

  const handleRosterCheckIn = useCallback(
    async (runner: RosterEntry) => {
      if (isRosterEntryConfirmed(runner)) {
        return;
      }

      if (!adminToken) {
        return;
      }

      if (rowCheckInControllersRef.current.has(runner.rowIndex)) {
        return;
      }

      const controller = new AbortController();
      let didTimeout = false;
      let failureMessage = `Unable to check in ${runner.name}.`;

      rowCheckInControllersRef.current.set(runner.rowIndex, controller);
      setIsCheckingInRow((current) => ({
        ...current,
        [runner.rowIndex]: true,
      }));

      const timeoutId = window.setTimeout(() => {
        didTimeout = true;
        controller.abort();
      }, REQUEST_TIMEOUT_MS);

      try {
        const response = await fetch("/api/scan-ticket", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ phone: runner.phone }),
          signal: controller.signal,
        });
        const payload = await readJson(response);

        if (handleUnauthorizedResponse(response)) {
          return;
        }

        const parsedPayload = parseDashboardPayload(payload);
        const runnerName = isJsonObject(payload)
          ? readBoundedString(payload.name, 100)
          : null;

        if (!response.ok || parsedPayload === null || runnerName === null) {
          failureMessage = readApiError(payload, failureMessage);
          throw new Error(failureMessage);
        }

        if (!isMountedRef.current) {
          return;
        }

        setRoster((current) =>
          current.map((candidate) =>
            candidate.rowIndex === runner.rowIndex
              ? { ...candidate, status: "✅ CONFIRMED" }
              : candidate,
          ),
        );
        setDashboard((current) => {
          const merged = mergeDashboardPayload(current, parsedPayload);

          return {
            ...merged,
            totalCount: Math.max(
              merged.totalCount,
              merged.confirmedCount,
            ),
          };
        });
        setFeedback({
          tone: "success",
          message: `${runnerName} is checked in.`,
        });
        triggerSuccessFlash();
        void playSuccessChime();
      } catch (error) {
        if (!isMountedRef.current) {
          return;
        }

        if (isAbortError(error) && !didTimeout) {
          return;
        }

        setFeedback({
          tone: "error",
          message: didTimeout
            ? `Check-in for ${runner.name} timed out. Try again.`
            : failureMessage,
        });
      } finally {
        window.clearTimeout(timeoutId);

        if (
          rowCheckInControllersRef.current.get(runner.rowIndex) === controller
        ) {
          rowCheckInControllersRef.current.delete(runner.rowIndex);
        }

        if (isMountedRef.current) {
          setIsCheckingInRow((current) => {
            if (!current[runner.rowIndex]) {
              return current;
            }

            const next = { ...current };
            delete next[runner.rowIndex];
            return next;
          });
        }
      }
    },
    [
      adminToken,
      handleUnauthorizedResponse,
      playSuccessChime,
      triggerSuccessFlash,
    ],
  );

  const commitWalkIn = useCallback(
    (input: WalkInInput): boolean => {
      const name = readBoundedString(input.name, 80);
      const normalizedPhone = input.phone.replace(/\D/g, "");
      const hasInvalidPhone =
        input.phone.trim().length > 0 &&
        (normalizedPhone.length < 7 || normalizedPhone.length > 15);
      const amountReceived =
        input.paymentMethod === "instapay"
          ? WALK_IN_FEE_EGP
          : parseNonNegativeInteger(input.amountReceived);

      if (name === null) {
        setFeedback({
          tone: "error",
          message: "Enter a runner name before adding the walk-in.",
        });
        return false;
      }

      if (hasInvalidPhone) {
        setFeedback({
          tone: "error",
          message: "Walk-in phone must contain 7 to 15 digits or be left blank.",
        });
        return false;
      }

      if (amountReceived === null || amountReceived < WALK_IN_FEE_EGP) {
        setFeedback({
          tone: "error",
          message: `Cash received must be at least ${formatCurrency(
            WALK_IN_FEE_EGP,
          )}.`,
        });
        return false;
      }

      const changeOwed =
        input.paymentMethod === "cash"
          ? safeSubtractNonNegativeIntegers(
              amountReceived,
              WALK_IN_FEE_EGP,
            )
          : 0;
      const walkIn: WalkInRunner = {
        id: createWalkInId(),
        name,
        phone: normalizedPhone,
        paymentMethod: input.paymentMethod,
        feeAmount: WALK_IN_FEE_EGP,
        amountReceived,
        changeOwed,
        createdAt: Date.now(),
      };

      setWalkIns((current) => [walkIn, ...current]);
      setPaymentFilter("all");
      setFeedback({
        tone: "success",
        message: `${name} added · ${
          input.paymentMethod === "cash" ? "Cash" : "InstaPay"
        } · ${formatCurrency(WALK_IN_FEE_EGP)}.`,
      });
      triggerSuccessFlash();
      void playSuccessChime();

      return true;
    },
    [playSuccessChime, triggerSuccessFlash],
  );

  const handleManualWalkInSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (commitWalkIn(walkInDraft)) {
      setWalkInDraft(INITIAL_WALK_IN_DRAFT);
    }
  };

  useEffect(() => {
    if (!adminToken) {
      return;
    }

    void refreshDashboard();

    const intervalId = window.setInterval(() => {
      if (!scanLockedRef.current) {
        void refreshDashboard();
      }
    }, REFRESH_INTERVAL_MS);

    return () => window.clearInterval(intervalId);
  }, [adminToken, refreshDashboard]);

  useEffect(() => {
    if (!adminToken) {
      return;
    }

    let cancelled = false;
    let scanner: Html5Qrcode | null = null;
    setScannerStatus("starting");

    async function startScanner() {
      try {
        await scannerShutdownRef.current;

        const { Html5Qrcode } = await import("html5-qrcode");

        if (cancelled) {
          return;
        }

        scanner = new Html5Qrcode(SCANNER_ELEMENT_ID);

        await scanner.start(
          { facingMode: "environment" },
          {
            fps: 10,
            aspectRatio: 1,
            qrbox: (viewfinderWidth, viewfinderHeight) => {
              const edge = Math.max(
                50,
                Math.floor(
                  Math.min(viewfinderWidth, viewfinderHeight) * 0.78,
                ),
              );

              return {
                width: edge,
                height: edge,
              };
            },
          },
          (decodedText) => {
            void handleScan(decodedText);
          },
          undefined,
        );

        if (!cancelled && isMountedRef.current) {
          setScannerStatus("live");
          setFeedback({
            tone: "idle",
            message: "Point the camera at a GlowRunners ticket QR.",
          });
        }
      } catch {
        if (scanner !== null) {
          const failedScanner = scanner;
          scanner = null;
          await stopAndClearScanner(failedScanner);
        }

        if (!cancelled && isMountedRef.current) {
          setScannerStatus("offline");
          setFeedback({
            tone: "error",
            message:
              "Camera scanner could not start. Allow camera access, then retry.",
          });
        }
      }
    }

    void startScanner();

    return () => {
      cancelled = true;

      if (scanner !== null) {
        const activeScanner = scanner;
        scanner = null;
        scannerShutdownRef.current = stopAndClearScanner(activeScanner);
      }
    };
  }, [adminToken, handleScan, scannerRestartKey]);

  const walkInMetrics = useMemo<WalkInMetrics>(() => {
    return walkIns.reduce<WalkInMetrics>(
      (metrics, walkIn) => ({
        confirmedCount: safeAddNonNegativeIntegers(
          metrics.confirmedCount,
          1,
        ),
        cashInHand: safeAddNonNegativeIntegers(
          metrics.cashInHand,
          walkIn.paymentMethod === "cash" ? walkIn.amountReceived : 0,
        ),
        digitalRevenue: safeAddNonNegativeIntegers(
          metrics.digitalRevenue,
          walkIn.paymentMethod === "instapay" ? walkIn.feeAmount : 0,
        ),
        totalChangeOwed: safeAddNonNegativeIntegers(
          metrics.totalChangeOwed,
          walkIn.changeOwed,
        ),
      }),
      {
        confirmedCount: 0,
        cashInHand: 0,
        digitalRevenue: 0,
        totalChangeOwed: 0,
      },
    );
  }, [walkIns]);

  const rosterSearch = useMemo(() => {
    const textQuery = searchQuery.trim().toLocaleLowerCase();
    const phoneQuery = searchQuery.replace(/\D/g, "");
    const matchingRunners = roster.filter((runner) => {
      if (!matchesPaymentFilter(runner.paymentType, paymentFilter)) {
        return false;
      }

      if (!textQuery) {
        return true;
      }

      return (
        runner.name.toLocaleLowerCase().includes(textQuery) ||
        runner.paymentType.toLocaleLowerCase().includes(textQuery) ||
        (phoneQuery.length > 0 && runner.phone.includes(phoneQuery))
      );
    });

    return {
      runners: matchingRunners.slice(0, ROSTER_RENDER_LIMIT),
      totalMatches: matchingRunners.length,
    };
  }, [paymentFilter, roster, searchQuery]);

  const filteredWalkIns = useMemo(() => {
    const matchingWalkIns =
      paymentFilter === "all"
        ? walkIns
        : walkIns.filter(
            (walkIn) => walkIn.paymentMethod === paymentFilter,
          );

    return matchingWalkIns.slice(0, 12);
  }, [paymentFilter, walkIns]);

  const confirmedCount = safeAddNonNegativeIntegers(
    dashboard.confirmedCount,
    walkInMetrics.confirmedCount,
  );
  const totalCount = safeAddNonNegativeIntegers(
    Math.max(dashboard.totalCount, dashboard.confirmedCount),
    walkInMetrics.confirmedCount,
  );
  const pendingCount = safeSubtractNonNegativeIntegers(
    totalCount,
    confirmedCount,
  );
  const cashInHand = safeAddNonNegativeIntegers(
    dashboard.cashInHand,
    walkInMetrics.cashInHand,
  );
  const digitalRevenue = safeAddNonNegativeIntegers(
    dashboard.digitalRevenue,
    walkInMetrics.digitalRevenue,
  );
  const totalChangeOwed = safeAddNonNegativeIntegers(
    dashboard.totalChangeOwed,
    walkInMetrics.totalChangeOwed,
  );
  const parsedDraftAmount = parseNonNegativeInteger(
    walkInDraft.amountReceived,
  );
  const draftChangeOwed =
    walkInDraft.paymentMethod === "cash" &&
    parsedDraftAmount !== null &&
    parsedDraftAmount >= WALK_IN_FEE_EGP
      ? safeSubtractNonNegativeIntegers(
          parsedDraftAmount,
          WALK_IN_FEE_EGP,
        )
      : 0;

  const visibleFeedback: Feedback = dashboardError
    ? { tone: "error", message: dashboardError }
    : feedback;
  const feedbackToneClass =
    visibleFeedback.tone === "success"
      ? "border-emerald-400 bg-emerald-950 text-emerald-100"
      : visibleFeedback.tone === "error"
        ? "border-red-400 bg-red-950 text-red-100"
        : "border-zinc-700 bg-zinc-900 text-zinc-100";
  const operationalStatus =
    scannerStatus === "offline" || dashboardStatus === "error"
      ? "offline"
      : scannerStatus === "live" && dashboardStatus === "ready"
        ? "live"
        : "starting";
  const scannerBadgeClass =
    operationalStatus === "live"
      ? "border-emerald-500/50 bg-emerald-950 text-emerald-300"
      : operationalStatus === "offline"
        ? "border-red-500/50 bg-red-950 text-red-300"
        : "border-amber-500/50 bg-amber-950 text-amber-300";
  const scannerDotClass =
    operationalStatus === "live"
      ? "bg-emerald-400"
      : operationalStatus === "offline"
        ? "bg-red-400"
        : "bg-amber-400";

  return (
    <div
      className="w-full min-h-screen bg-black text-white flex flex-col items-center justify-start overflow-x-hidden px-4"
      role="main"
    >
      {isFlashActive ? (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed inset-0 z-50 bg-emerald-400/25 motion-safe:animate-pulse"
        />
      ) : null}

      <div className="w-full max-w-md flex flex-col gap-4 box-border py-4">
        <header className="w-full min-w-0 rounded-xl border border-zinc-800 bg-zinc-950 p-4">
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-black uppercase tracking-[0.18em] text-amber-300">
                Gate Control
              </p>
              <h1 className="mt-1 break-words text-2xl font-black leading-tight">
                GlowRunners Check-In
              </h1>
              <p className="mt-1 break-words text-xs font-semibold text-zinc-400">
                {dashboard.sheetName}
              </p>
              {dashboard.isFallbackSheet ? (
                <p className="mt-1 break-words text-[11px] font-black text-amber-300">
                  Latest available attendance tab
                </p>
              ) : null}
            </div>
            <span
              className={`inline-flex shrink-0 items-center gap-2 rounded-full border px-2.5 py-1 text-[11px] font-black uppercase tracking-wide ${scannerBadgeClass}`}
            >
              <span className={`h-2 w-2 rounded-full ${scannerDotClass}`} />
              {operationalStatus === "live"
                ? "Live"
                : operationalStatus === "offline"
                  ? "Offline"
                  : "Starting"}
            </span>
          </div>

          <dl className="mt-4 grid w-full min-w-0 grid-cols-2 gap-2 border-t border-zinc-800 pt-3">
            <div className="min-w-0">
              <dt className="text-[10px] font-black uppercase tracking-widest text-zinc-500">
                Kickoff
              </dt>
              <dd className="mt-1 break-words text-sm font-black text-white">
                {EVENT_KICKOFF}
              </dd>
            </div>
            <div className="min-w-0 border-l border-zinc-800 pl-3">
              <dt className="text-[10px] font-black uppercase tracking-widest text-zinc-500">
                Location
              </dt>
              <dd className="mt-1 break-words text-sm font-black text-white">
                {EVENT_LOCATION}
              </dd>
            </div>
          </dl>
        </header>

        <nav
          className="grid w-full min-w-0 grid-cols-2 gap-2"
          aria-label="Admin portal sections"
        >
          <a
            href="/admin/post-run-events"
            className="flex min-h-12 min-w-0 items-center justify-center rounded-xl bg-fuchsia-500 px-3 text-center text-xs font-black text-white"
          >
            Post-Run Events
          </a>
          <button
            type="button"
            className="min-h-12 min-w-0 rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-xs font-black text-zinc-200"
            onClick={() => {
              void fetch("/api/auth/session", {
                method: "DELETE",
                credentials: "same-origin",
              })
                .then((response) => {
                  if (!response.ok) {
                    throw new Error("Sign out failed.");
                  }

                  window.location.assign("/admin/login");
                })
                .catch(() => {
                  setFeedback({
                    tone: "error",
                    message:
                      "Could not sign out. Check the connection and retry.",
                  });
                });
            }}
          >
            Sign out
          </button>
        </nav>

        <section aria-label="Runner summary" className="w-full min-w-0">
          <dl className="grid w-full min-w-0 grid-cols-3 gap-2">
            <div className="min-w-0 rounded-xl border border-emerald-500/50 bg-emerald-950 p-2.5">
              <dt className="whitespace-nowrap text-[9px] font-black uppercase text-emerald-300">
                Confirmed
              </dt>
              <dd
                className={`mt-2 max-w-full break-all font-black leading-none tabular-nums text-white ${getSummaryCountSizeClass(
                  confirmedCount,
                )}`}
              >
                {formatCount(confirmedCount)}
              </dd>
            </div>
            <div className="min-w-0 rounded-xl border border-amber-500/50 bg-amber-950 p-2.5">
              <dt className="whitespace-nowrap text-[9px] font-black uppercase text-amber-300">
                Pending
              </dt>
              <dd
                className={`mt-2 max-w-full break-all font-black leading-none tabular-nums text-white ${getSummaryCountSizeClass(
                  pendingCount,
                )}`}
              >
                {formatCount(pendingCount)}
              </dd>
            </div>
            <div className="min-w-0 rounded-xl border border-zinc-700 bg-zinc-900 p-2.5">
              <dt className="whitespace-nowrap text-[9px] font-black uppercase text-zinc-400">
                Total
              </dt>
              <dd
                className={`mt-2 max-w-full break-all font-black leading-none tabular-nums text-white ${getSummaryCountSizeClass(
                  totalCount,
                )}`}
              >
                {formatCount(totalCount)}
              </dd>
            </div>
          </dl>
        </section>

        <section
          aria-label="Payment summary"
          className="w-full min-w-0 rounded-xl border border-zinc-800 bg-zinc-950 p-3"
        >
          <dl className="grid w-full min-w-0 grid-cols-3 divide-x divide-zinc-800">
            <div className="min-w-0 px-2 first:pl-0">
              <dt className="break-words text-[9px] font-black uppercase tracking-wide text-zinc-500">
                Cash in Hand
              </dt>
              <dd className="mt-1 break-words text-[10px] font-black tabular-nums text-emerald-300 sm:text-sm">
                {formatCurrency(cashInHand)}
              </dd>
            </div>
            <div className="min-w-0 px-2">
              <dt className="break-words text-[9px] font-black uppercase tracking-wide text-zinc-500">
                Digital Revenue
              </dt>
              <dd className="mt-1 break-words text-[10px] font-black tabular-nums text-sky-300 sm:text-sm">
                {formatCurrency(digitalRevenue)}
              </dd>
            </div>
            <div className="min-w-0 px-2 pr-0">
              <dt className="break-words text-[9px] font-black uppercase tracking-wide text-zinc-500">
                Change Owed
              </dt>
              <dd className="mt-1 break-words text-[10px] font-black tabular-nums text-amber-300 sm:text-sm">
                {formatCurrency(totalChangeOwed)}
              </dd>
            </div>
          </dl>
        </section>

        <section
          className="relative aspect-square w-full min-w-0 overflow-hidden rounded-xl border-2 border-zinc-700 bg-zinc-950"
          aria-label="QR scanner"
        >
          <div
            id={SCANNER_ELEMENT_ID}
            className="h-full w-full min-w-0 [&_canvas]:!max-w-full [&_img]:!max-w-full [&_video]:!h-full [&_video]:!w-full [&_video]:!object-cover"
          />
        </section>

        <section
          aria-labelledby="roster-explorer-heading"
          className="w-full min-w-0 rounded-xl border border-zinc-800 bg-zinc-950 p-4"
        >
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="min-w-0">
              <h2
                id="roster-explorer-heading"
                className="text-sm font-black uppercase tracking-wide text-white"
              >
                Roster Explorer
              </h2>
              <p className="mt-1 text-xs font-semibold text-zinc-500">
                Search name, phone, or payment type.
              </p>
            </div>
            <span className="flex-shrink-0 text-xs font-bold tabular-nums text-zinc-400">
              {formatCount(rosterSearch.totalMatches)} found
            </span>
          </div>

          <nav
            aria-label="Filter roster and walk-ins by payment method"
            className="mt-3 grid w-full min-w-0 grid-cols-3 gap-2"
          >
            {PAYMENT_FILTERS.map((filter) => {
              const isActive = paymentFilter === filter.value;

              return (
                <button
                  key={filter.value}
                  type="button"
                  aria-pressed={isActive}
                  onClick={() => setPaymentFilter(filter.value)}
                  className={`min-h-11 min-w-0 rounded-full border px-3 text-sm font-black transition ${
                    isActive
                      ? "border-white bg-white text-black"
                      : "border-zinc-700 bg-black text-zinc-300"
                  }`}
                >
                  {filter.label}
                </button>
              );
            })}
          </nav>

          <label className="sr-only" htmlFor="roster-search">
            Search runner roster
          </label>
          <input
            id="roster-search"
            name="rosterSearch"
            type="search"
            inputMode="search"
            autoComplete="off"
            enterKeyHint="search"
            maxLength={100}
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search runner, phone, or payment…"
            className="mt-3 w-full bg-zinc-950 border border-zinc-800 rounded-lg px-4 py-3 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-white"
          />

          <div className="w-full max-h-56 overflow-y-auto flex flex-col gap-2 mt-2">
            {rosterSearch.runners.length > 0 ? (
              rosterSearch.runners.map((runner) => {
                const isConfirmed = isRosterEntryConfirmed(runner);
                const isCheckingIn = Boolean(
                  isCheckingInRow[runner.rowIndex],
                );

                return (
                  <div
                    key={runner.rowIndex}
                    className="flex w-full min-w-0 items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-black p-3"
                  >
                    <div className="flex flex-col min-w-0 truncate">
                      <p className="truncate text-sm font-black text-white">
                        {runner.name}
                      </p>
                      <p className="truncate text-xs font-semibold tabular-nums text-zinc-400">
                        {runner.phone}
                      </p>
                      <p className="truncate text-[11px] font-bold text-zinc-500">
                        {runner.paymentType}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleRosterCheckIn(runner)}
                      disabled={isConfirmed || isCheckingIn}
                      aria-busy={isCheckingIn}
                      className={`min-h-11 flex-shrink-0 rounded-md px-3 text-xs font-black transition disabled:cursor-not-allowed ${
                        isConfirmed
                          ? "bg-emerald-950 text-emerald-300"
                          : "bg-white text-black disabled:opacity-60"
                      }`}
                    >
                      {isConfirmed
                        ? "✓ Confirmed"
                        : isCheckingIn
                          ? "Checking…"
                          : "Check In"}
                    </button>
                  </div>
                );
              })
            ) : (
              <p className="rounded-lg border border-zinc-800 bg-black p-3 text-sm font-semibold text-zinc-500">
                {roster.length === 0
                  ? "No roster entries are available."
                  : "No runners match this search."}
              </p>
            )}
          </div>

          {rosterSearch.totalMatches > ROSTER_RENDER_LIMIT ? (
            <p className="mt-2 text-xs font-semibold text-zinc-500">
              Showing the first {formatCount(ROSTER_RENDER_LIMIT)} matches.
              Refine the search to find a specific runner.
            </p>
          ) : null}
        </section>

        <div
          className={`min-h-[72px] w-full min-w-0 break-words rounded-xl border p-4 text-sm font-bold ${feedbackToneClass}`}
          role={visibleFeedback.tone === "error" ? "alert" : "status"}
          aria-live={
            visibleFeedback.tone === "error" ? "assertive" : "polite"
          }
          aria-atomic="true"
        >
          {visibleFeedback.message}
        </div>

        <div className="grid w-full min-w-0 grid-cols-2 gap-3">
          <button
            className="min-h-12 min-w-0 whitespace-normal rounded-xl bg-white px-3 py-2 font-black text-black transition disabled:cursor-not-allowed disabled:opacity-50"
            type="button"
            onClick={() => void refreshDashboard()}
            disabled={isRefreshing || isScanBusy}
            aria-busy={isRefreshing}
          >
            {isRefreshing ? "Refreshing…" : "Refresh totals"}
          </button>
          <button
            className="min-h-12 min-w-0 whitespace-normal rounded-xl border border-white bg-black px-3 py-2 font-black text-white transition disabled:cursor-not-allowed disabled:opacity-50"
            type="button"
            disabled={isScanBusy}
            onClick={() => {
              setFeedback({
                tone: "idle",
                message: "Restarting camera...",
              });
              setScannerStatus("starting");
              setScannerRestartKey((current) => current + 1);
            }}
          >
            Restart camera
          </button>
        </div>

        <section
          aria-labelledby="recent-walk-ins-heading"
          className="w-full min-w-0 rounded-xl border border-zinc-800 bg-zinc-950 p-4"
        >
          <div className="flex min-w-0 items-center justify-between gap-3">
            <h2
              id="recent-walk-ins-heading"
              className="min-w-0 text-sm font-black uppercase tracking-wide"
            >
              Recent Walk-Ins
            </h2>
            <span className="shrink-0 text-xs font-bold tabular-nums text-zinc-400">
              {formatCount(filteredWalkIns.length)} shown
            </span>
          </div>

          {filteredWalkIns.length > 0 ? (
            <ul className="mt-3 flex w-full min-w-0 flex-col divide-y divide-zinc-800">
              {filteredWalkIns.map((walkIn) => (
                <li
                  key={walkIn.id}
                  className="flex min-w-0 items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-black text-white">
                      {walkIn.name}
                    </p>
                    <p className="mt-0.5 truncate text-xs font-semibold text-zinc-500">
                      {TIME_FORMATTER.format(new Date(walkIn.createdAt))}
                      {walkIn.phone ? ` · ${walkIn.phone}` : " · Express entry"}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-xs font-black text-zinc-300">
                      {walkIn.paymentMethod === "cash" ? "Cash" : "InstaPay"}
                    </p>
                    <p className="mt-0.5 text-xs font-black tabular-nums text-emerald-300">
                      {formatCurrency(walkIn.feeAmount)}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 rounded-lg bg-black p-3 text-sm font-semibold text-zinc-500">
              No {paymentFilter === "all" ? "" : `${paymentFilter} `}walk-ins yet.
            </p>
          )}
        </section>

        <details className="group w-full min-w-0 overflow-hidden rounded-xl border border-amber-400 bg-amber-950/40">
          <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 font-black text-amber-200 [&::-webkit-details-marker]:hidden">
            <span className="min-w-0 break-words">+ ADD WALK-IN RUNNER</span>
            <span
              aria-hidden="true"
              className="shrink-0 text-xl transition-transform group-open:rotate-45"
            >
              +
            </span>
          </summary>

          <div className="flex w-full min-w-0 flex-col gap-4 border-t border-amber-500/30 p-4">
            <section aria-labelledby="express-cash-heading">
              <div className="flex min-w-0 items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2
                    id="express-cash-heading"
                    className="text-sm font-black uppercase tracking-wide text-amber-200"
                  >
                    Express Cash
                  </h2>
                  <p className="mt-1 text-xs font-semibold text-amber-100/70">
                    One tap: confirmed, cash paid exactly, no phone required.
                  </p>
                </div>
                <span className="shrink-0 rounded-full bg-black/40 px-2 py-1 text-xs font-black tabular-nums text-amber-200">
                  {formatCurrency(WALK_IN_FEE_EGP)}
                </span>
              </div>

              <button
                type="button"
                className="mt-3 min-h-14 w-full rounded-xl bg-amber-300 px-4 py-3 text-base font-black text-black transition active:scale-[0.99]"
                onClick={() => {
                  const entryTime = TIME_FORMATTER.format(new Date());
                  commitWalkIn({
                    name: `Express Cash · ${entryTime}`,
                    phone: "",
                    paymentMethod: "cash",
                    amountReceived: WALK_IN_FEE_EGP,
                  });
                }}
              >
                EXPRESS CASH · ADD NOW
              </button>
            </section>

            <div className="flex items-center gap-3" aria-hidden="true">
              <span className="h-px flex-1 bg-amber-500/30" />
              <span className="text-[10px] font-black uppercase tracking-widest text-amber-200/60">
                Manual details
              </span>
              <span className="h-px flex-1 bg-amber-500/30" />
            </div>

            <form
              className="flex w-full min-w-0 flex-col gap-3"
              onSubmit={handleManualWalkInSubmit}
            >
              <label className="flex min-w-0 flex-col gap-1.5 text-xs font-black uppercase tracking-wide text-zinc-300">
                Runner name
                <input
                  className="min-h-12 w-full min-w-0 rounded-xl border border-zinc-700 bg-black px-3 text-base font-bold normal-case tracking-normal text-white outline-none focus:border-amber-300"
                  name="walkInName"
                  type="text"
                  autoComplete="name"
                  maxLength={80}
                  required
                  value={walkInDraft.name}
                  onChange={(event) =>
                    setWalkInDraft((current) => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                />
              </label>

              <label className="flex min-w-0 flex-col gap-1.5 text-xs font-black uppercase tracking-wide text-zinc-300">
                Phone (optional)
                <input
                  className="min-h-12 w-full min-w-0 rounded-xl border border-zinc-700 bg-black px-3 text-base font-bold normal-case tracking-normal text-white outline-none focus:border-amber-300"
                  name="walkInPhone"
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  maxLength={24}
                  value={walkInDraft.phone}
                  onChange={(event) =>
                    setWalkInDraft((current) => ({
                      ...current,
                      phone: event.target.value,
                    }))
                  }
                />
              </label>

              <fieldset className="min-w-0">
                <legend className="text-xs font-black uppercase tracking-wide text-zinc-300">
                  Payment method
                </legend>
                <div className="mt-1.5 grid w-full min-w-0 grid-cols-2 gap-2">
                  {(["cash", "instapay"] as const).map((method) => {
                    const isActive = walkInDraft.paymentMethod === method;

                    return (
                      <button
                        key={method}
                        type="button"
                        aria-pressed={isActive}
                        className={`min-h-12 min-w-0 rounded-xl border px-3 font-black transition ${
                          isActive
                            ? "border-amber-300 bg-amber-300 text-black"
                            : "border-zinc-700 bg-black text-zinc-300"
                        }`}
                        onClick={() =>
                          setWalkInDraft((current) => ({
                            ...current,
                            paymentMethod: method,
                            amountReceived: String(WALK_IN_FEE_EGP),
                          }))
                        }
                      >
                        {method === "cash" ? "Cash" : "InstaPay"}
                      </button>
                    );
                  })}
                </div>
              </fieldset>

              <label className="flex min-w-0 flex-col gap-1.5 text-xs font-black uppercase tracking-wide text-zinc-300">
                {walkInDraft.paymentMethod === "cash"
                  ? "Cash received"
                  : "Digital amount"}
                <input
                  className="min-h-12 w-full min-w-0 rounded-xl border border-zinc-700 bg-black px-3 text-base font-black normal-case tracking-normal text-white outline-none focus:border-amber-300 disabled:cursor-not-allowed disabled:text-zinc-500"
                  name="amountReceived"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  disabled={walkInDraft.paymentMethod === "instapay"}
                  value={walkInDraft.amountReceived}
                  onChange={(event) =>
                    setWalkInDraft((current) => ({
                      ...current,
                      amountReceived: event.target.value.replace(/\D/g, ""),
                    }))
                  }
                />
              </label>

              <dl className="grid w-full min-w-0 grid-cols-2 gap-2 rounded-xl bg-black/50 p-3">
                <div className="min-w-0">
                  <dt className="text-[10px] font-black uppercase tracking-wide text-zinc-500">
                    Entry Fee
                  </dt>
                  <dd className="mt-1 break-words text-sm font-black tabular-nums text-white">
                    {formatCurrency(WALK_IN_FEE_EGP)}
                  </dd>
                </div>
                <div className="min-w-0 border-l border-zinc-800 pl-3">
                  <dt className="text-[10px] font-black uppercase tracking-wide text-zinc-500">
                    Change Owed
                  </dt>
                  <dd className="mt-1 break-words text-sm font-black tabular-nums text-amber-300">
                    {formatCurrency(draftChangeOwed)}
                  </dd>
                </div>
              </dl>

              <button
                type="submit"
                className="min-h-14 w-full rounded-xl bg-white px-4 py-3 text-base font-black text-black transition active:scale-[0.99]"
              >
                ADD &amp; CONFIRM WALK-IN
              </button>
            </form>
          </div>
        </details>
      </div>
    </div>
  );
}
