"use client";

import Image from "next/image";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

type DepositStatus = "PENDING" | "VERIFIED";
type SettlementStatus = "UNPAID" | "FULLY_CLEARED";
type PaymentStatus =
  | "UNPAID"
  | "DEPOSIT_PAID"
  | "FULLY_CLEARED"
  | "FREE";
type PaymentFilter = "all" | "unpaid" | "deposit" | "cleared" | "free";
type EventModal = "create" | "edit" | null;

type ActiveAdmin = Readonly<{
  id: string;
  displayName: string;
  phoneE164: string;
  role: "super-admin" | "admin";
}>;

type PostRunEvent = Readonly<{
  id: string;
  title: string;
  runDate: string;
  totalCost: number;
  eventTicketPrice: number;
  depositAmount: number;
  standardDeposit: number;
  paymentInstructions: string;
  capacity: number | null;
  createdAt: string;
  updatedAt: string;
  createdByAdmin?: string;
  isArchived: boolean;
  archivedAt: string | null;
  archivedByAdmin?: string | null;
}>;

type Participant = Readonly<{
  id: string;
  eventId: string;
  fullName: string;
  phoneNumber: string;
  depositStatus: DepositStatus;
  depositPaid: number;
  amountPaid: number;
  paymentMethod?: string;
  changeOwed?: number;
  paymentProofUrl: string;
  remainingBalance: number;
  paymentStatus: PaymentStatus;
  settlementStatus: SettlementStatus;
  updatedByAdmin: string;
  internalNotes: string;
  createdAt: string;
  updatedAt: string;
}>;

type ParticipantPatch = Readonly<{
  fullName?: string;
  phoneNumber?: string;
  amountPaid?: number;
  paymentStatus?: PaymentStatus;
  paymentMethod?: string;
  changeOwed?: number;
  paymentProofUrl?: string;
  internalNotes?: string;
}>;


type ApiObject = Record<string, unknown>;

type EventFormState = {
  title: string;
  runDate: string;
  totalCost: string;
  depositAmount: string;
  capacity: string;
  paymentInstructions: string;
};

type ParticipantFormState = {
  fullName: string;
  phoneNumber: string;
  paymentStatus: PaymentStatus;
};

type DuplicateContactWarning = Readonly<{
  existingParticipant: Participant;
  candidate: ParticipantFormState;
  normalizedContact: string;
}>;

const EMPTY_EVENT_FORM: EventFormState = {
  title: "",
  runDate: "",
  totalCost: "",
  depositAmount: "",
  capacity: "",
  paymentInstructions: "",
};

const EMPTY_PARTICIPANT_FORM: ParticipantFormState = {
  fullName: "",
  phoneNumber: "",
  paymentStatus: "UNPAID" as PaymentStatus,
};

const SESSION_STORAGE_KEY = "glowrunners.admin.identity.v1";
const POST_RUN_EVENTS_API = "/api/post-run-events";
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const GATE_ROSTER_SYNC_CHANNEL = "glowrunners-gate-roster-v1";

const MONEY_FORMATTER = new Intl.NumberFormat("en-EG", {
  maximumFractionDigits: 2,
});

const DATE_FORMATTER = new Intl.DateTimeFormat("en-EG", {
  dateStyle: "medium",
  timeZone: "Africa/Cairo",
});

function isObject(value: unknown): value is ApiObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readError(payload: unknown, fallback: string) {
  return isObject(payload) && typeof payload.error === "string"
    ? payload.error
    : fallback;
}

function formatMoney(value: number) {
  const safeValue = Number.isFinite(value) ? value : 0;
  return `${MONEY_FORMATTER.format(safeValue)} EGP`;
}

function formatCompactMoney(value: number) {
  const safeValue = Number.isFinite(value) ? Math.max(0, value) : 0;
  return MONEY_FORMATTER.format(safeValue);
}

function safeNonNegativeNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function notifyGateRosterChanged() {
  window.dispatchEvent(new Event("glowrunners:gate-roster-changed"));

  if ("BroadcastChannel" in window) {
    const channel = new BroadcastChannel(GATE_ROSTER_SYNC_CHANNEL);
    channel.postMessage({ type: "participants-changed" });
    channel.close();
  }
}

function normalizeContactForComparison(value: string) {
  const trimmed = value.trim().replace(/^'/, "").trim();

  if (!trimmed || trimmed === "-") {
    return "";
  }

  const isHandle = trimmed.startsWith("@") || /[a-z._-]/i.test(trimmed);

  if (isHandle) {
    return (trimmed.startsWith("@") ? trimmed : `@${trimmed}`)
      .toLocaleLowerCase("en-US");
  }

  const hasLeadingPlus = trimmed.startsWith("+");
  const digitsOnly = trimmed.replace(/\D/g, "");

  if (!digitsOnly) {
    return "";
  }

  if (hasLeadingPlus) {
    return `+${digitsOnly}`;
  }

  if (digitsOnly.startsWith("01") && digitsOnly.length === 11) {
    return `+20${digitsOnly.slice(1)}`;
  }

  return digitsOnly.length >= 8 ? `+${digitsOnly}` : digitsOnly;
}

function formatDuplicateContact(value: string) {
  const digits = value.replace(/\D/g, "");

  if (digits.startsWith("20") && digits.length === 12) {
    const local = digits.slice(2);
    return `+20 ${local.slice(0, 3)} ${local.slice(3, 6)} ${local.slice(6)}`;
  }

  return value;
}

function formatEventDate(value: string) {
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : DATE_FORMATTER.format(date);
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE_PATTERN.test(value)) {
    return false;
  }

  const [year, month, day] = value.split("-").map(Number);
  const candidate = new Date(Date.UTC(year, month - 1, day, 12));

  return (
    candidate.getUTCFullYear() === year &&
    candidate.getUTCMonth() === month - 1 &&
    candidate.getUTCDate() === day
  );
}

function whatsappPhone(value: string) {
  if (!value.trim() || value.trim().startsWith("@")) {
    return "";
  }

  const digits = value.replace(/\D/g, "");

  if (digits.startsWith("20")) {
    return digits;
  }

  if (value.trim().startsWith("+")) {
    return digits;
  }

  const localEgyptianPhone = digits.replace(/^0+/, "");
  return localEgyptianPhone ? `20${localEgyptianPhone}` : "";
}

function whatsappLink(phone: string, message: string) {
  return `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
}

function paymentState(participant: Participant, event: PostRunEvent) {
  const normalizedStatus = String(participant.paymentStatus ?? "")
    .trim()
    .toUpperCase();

  if (normalizedStatus === "FREE" || normalizedStatus === "FREE ATTENDEE") {
    return {
      kind: "free" as const,
      amountPaid: 0,
      remaining: 0,
      label: "🎁 Free",
      longLabel: "Free Attendee",
    };
  }

  const amountPaid = Number.isFinite(participant.amountPaid)
    ? Math.max(0, participant.amountPaid)
    : 0;
  const remaining = Math.max(
    0,
    Math.round((event.totalCost - amountPaid) * 100) / 100,
  );

  if (amountPaid <= 0) {
    return {
      kind: "unpaid" as const,
      amountPaid,
      remaining,
      label: "🔴 Unpaid",
      longLabel: "Unpaid (Cash on Friday)",
    };
  }

  if (amountPaid >= event.totalCost) {
    return {
      kind: "cleared" as const,
      amountPaid,
      remaining: 0,
      label: "🟢 Cleared",
      longLabel: "Fully Cleared",
    };
  }

  return {
    kind: "deposit" as const,
    amountPaid,
    remaining,
    label: `🟡 Deposit ${formatCompactMoney(amountPaid)} EGP`,
    longLabel: "Deposit Verified",
  };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

async function apiRequest(
  input: string,
  init?: RequestInit,
): Promise<{ response: Response; payload: unknown }> {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-cache, no-store, must-revalidate");
  headers.set("Pragma", "no-cache");
  headers.set("Expires", "0");

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12_000);

  try {
    const response = await fetch(input, {
      credentials: "same-origin",
      signal: init?.signal || controller.signal,
      ...init,
      cache: "no-store",
      headers,
    });
    const payload = await readJson(response);

    if (typeof window !== "undefined") {
      if (response.status === 401) {
        window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
        const next = `${window.location.pathname}${window.location.search}`;
        window.location.assign(`/admin/login?next=${encodeURIComponent(next)}`);
      } else if (
        response.status === 403 &&
        readError(payload, "") === "Forbidden."
      ) {
        const next = `${window.location.pathname}${window.location.search}`;
        window.location.assign(`/admin/login?next=${encodeURIComponent(next)}`);
      }
    }

    return { response, payload };
  } finally {
    clearTimeout(timeoutId);
  }
}


async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();

  if (!copied) {
    throw new Error("Clipboard access is unavailable on this device.");
  }
}

async function compressProofImage(file: File): Promise<File> {
  if (!file.type.startsWith("image/")) {
    throw new Error("Choose an image file.");
  }

  if (file.size > 5 * 1024 * 1024) {
    throw new Error("Payment proof must be 5 MB or smaller.");
  }

  const sourceUrl = URL.createObjectURL(file);

  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const candidate = new window.Image();
      candidate.onload = () => resolve(candidate);
      candidate.onerror = () =>
        reject(new Error("This image could not be opened on this device."));
      candidate.src = sourceUrl;
    });
    let maxEdge = 1800;
    let quality = 0.86;

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const scale = Math.min(1, maxEdge / Math.max(image.width, image.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      const context = canvas.getContext("2d");

      if (!context) {
        throw new Error("Image processing is unavailable in this browser.");
      }

      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, "image/jpeg", quality);
      });

      if (blob && (blob.size <= 1_500_000 || attempt === 7)) {
        if (blob.size > 4_500_000) {
          throw new Error(
            "This screenshot is too large after compression. Crop it and try again.",
          );
        }

        return new File([blob], `${file.name.replace(/\.[^.]+$/, "")}.jpg`, {
          type: "image/jpeg",
          lastModified: Date.now(),
        });
      }

      if (quality > 0.58) {
        quality -= 0.07;
      } else {
        maxEdge = Math.max(720, Math.round(maxEdge * 0.82));
      }
    }

    throw new Error("The payment proof could not be compressed.");
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}

function ModalShell({
  title,
  children,
  onClose,
  layer = "normal",
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  layer?: "normal" | "lightbox";
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const previousOverflow = document.body.style.overflow;
    const dialog = dialogRef.current;
    const focusableSelector =
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';
    document.body.style.overflow = "hidden";

    const firstControl =
      dialog?.querySelector<HTMLElement>("[data-modal-autofocus]") ??
      dialog?.querySelector<HTMLElement>(focusableSelector) ??
      dialog;
    firstControl?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }

      if (event.key !== "Tab" || !dialog) {
        return;
      }

      const controls = Array.from(
        dialog.querySelectorAll<HTMLElement>(focusableSelector),
      );

      if (controls.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = controls[0];
      const last = controls[controls.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, []);

  return (
    <div
      className={`fixed inset-0 ${
        layer === "lightbox" ? "z-[70]" : "z-50"
      } flex items-end justify-center overflow-y-auto bg-black/85 sm:items-center sm:p-3`}
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) {
          onClose();
        }
      }}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="max-h-[92svh] w-full max-w-md overflow-y-auto rounded-t-3xl border border-zinc-700 bg-zinc-950 p-4 text-white shadow-2xl outline-none sm:rounded-3xl"
      >
        <div className="flex items-center justify-between gap-3">
          <h2 id={titleId} className="min-w-0 truncate text-lg font-black">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="min-h-11 shrink-0 rounded-xl border border-zinc-700 px-4 text-sm font-black"
            aria-label={`Close ${title}`}
          >
            Close
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

function EventFormFields({
  form,
  onChange,
  submitLabel,
  isBusy,
  canOverrideRunDate,
  runDateMessage,
  runDateMessageIsError = false,
  submitDisabled = false,
}: {
  form: EventFormState;
  onChange: (next: EventFormState) => void;
  submitLabel: string;
  isBusy: boolean;
  canOverrideRunDate: boolean;
  runDateMessage?: string;
  runDateMessageIsError?: boolean;
  submitDisabled?: boolean;
}) {
  return (
    <div className="mt-4 flex flex-col gap-3">
      <label className="text-xs font-black uppercase tracking-wide text-zinc-400">
        Event title
        <input
          type="text"
          required
          maxLength={120}
          data-modal-autofocus
          value={form.title}
          onChange={(event) => onChange({ ...form, title: event.target.value })}
          placeholder="Post-Run Kayaking"
          className="mt-1.5 min-h-12 w-full min-w-0 rounded-xl border border-zinc-700 bg-black px-3 text-base font-bold normal-case tracking-normal text-white outline-none focus:border-fuchsia-400"
        />
      </label>
      <label className="text-xs font-black uppercase tracking-wide text-zinc-400">
        Associated date
        <input
          type="date"
          required
          disabled={isBusy || !canOverrideRunDate}
          value={form.runDate}
          onChange={(event) =>
            onChange({ ...form, runDate: event.target.value })
          }
          className="mt-1.5 min-h-12 w-full min-w-0 rounded-xl border border-zinc-700 bg-black px-3 text-base font-bold normal-case tracking-normal text-white outline-none focus:border-fuchsia-400 disabled:cursor-not-allowed disabled:text-zinc-400"
        />
        {runDateMessage ? (
          <span
            className={`mt-1.5 block min-w-0 break-words text-[11px] font-semibold normal-case tracking-normal ${
              runDateMessageIsError ? "text-amber-300" : "text-zinc-500"
            }`}
          >
            {runDateMessage}
          </span>
        ) : null}
      </label>
      <div className="grid min-w-0 grid-cols-2 gap-2">
        <label className="min-w-0 text-xs font-black uppercase tracking-wide text-zinc-400">
          Ticket price
          <input
            type="number"
            required
            min="0"
            step="0.01"
            inputMode="decimal"
            value={form.totalCost}
            onChange={(event) =>
              onChange({ ...form, totalCost: event.target.value })
            }
            className="mt-1.5 min-h-12 w-full min-w-0 rounded-xl border border-zinc-700 bg-black px-3 text-base font-black normal-case tracking-normal text-white outline-none focus:border-fuchsia-400"
          />
        </label>
        <label className="min-w-0 text-xs font-black uppercase tracking-wide text-zinc-400">
          Standard deposit
          <input
            type="number"
            required
            min="0"
            step="0.01"
            inputMode="decimal"
            value={form.depositAmount}
            onChange={(event) =>
              onChange({ ...form, depositAmount: event.target.value })
            }
            className="mt-1.5 min-h-12 w-full min-w-0 rounded-xl border border-zinc-700 bg-black px-3 text-base font-black normal-case tracking-normal text-white outline-none focus:border-fuchsia-400"
          />
        </label>
      </div>
      <p className="rounded-xl bg-zinc-900 p-3 text-sm font-bold text-zinc-300">
        Standard balance after deposit:{" "}
        <span className="text-amber-300">
          {formatMoney(
            Math.max(
              0,
              Number(form.totalCost || 0) - Number(form.depositAmount || 0),
            ),
          )}
        </span>
      </p>
      <label className="text-xs font-black uppercase tracking-wide text-zinc-400">
        Max capacity (optional)
        <input
          type="number"
          min="1"
          step="1"
          inputMode="numeric"
          value={form.capacity}
          onChange={(event) =>
            onChange({ ...form, capacity: event.target.value })
          }
          className="mt-1.5 min-h-12 w-full min-w-0 rounded-xl border border-zinc-700 bg-black px-3 text-base font-black normal-case tracking-normal text-white outline-none focus:border-fuchsia-400"
        />
      </label>
      <label className="text-xs font-black uppercase tracking-wide text-zinc-400">
        Payment instructions
        <textarea
          required
          maxLength={2000}
          rows={3}
          value={form.paymentInstructions}
          onChange={(event) =>
            onChange({ ...form, paymentInstructions: event.target.value })
          }
          placeholder="InstaPay link or Vodafone Cash number"
          className="mt-1.5 w-full min-w-0 resize-y rounded-xl border border-zinc-700 bg-black p-3 text-base font-bold normal-case tracking-normal text-white outline-none focus:border-fuchsia-400"
        />
      </label>
      <button
        type="submit"
        disabled={isBusy || submitDisabled}
        className="min-h-14 w-full rounded-xl bg-fuchsia-500 px-4 text-base font-black text-white disabled:opacity-50"
      >
        {submitLabel}
      </button>
    </div>
  );
}

export function PostRunEventsDashboard() {
  const [admin, setAdmin] = useState<ActiveAdmin | null>(null);
  const [events, setEvents] = useState<PostRunEvent[]>([]);
  const activeEventIdRef = useRef<string>("");
  const [selectedEventId, setSelectedEventId] = useState<string>(() => {
    if (typeof window !== "undefined") {
      try {
        const stored = window.localStorage.getItem("glow_active_event_id");
        if (stored) return stored;
      } catch {
        // ignore
      }
    }
    return "";
  });

  const [showArchivedEvents, setShowArchivedEvents] = useState(false);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [eventModal, setEventModal] = useState<EventModal>(null);
  const [eventForm, setEventForm] =
    useState<EventFormState>(EMPTY_EVENT_FORM);
  const [participantForm, setParticipantForm] = useState(
    EMPTY_PARTICIPANT_FORM,
  );
  const [selectedParticipantId, setSelectedParticipantId] = useState("");
  const [participantNameDraft, setParticipantNameDraft] = useState("");
  const [participantContactDraft, setParticipantContactDraft] = useState("");
  const [paymentDraft, setPaymentDraft] = useState("");
  const [paymentStatusDraft, setPaymentStatusDraft] =
    useState<PaymentStatus>("UNPAID");
  const [paymentMethodDraft, setPaymentMethodDraft] = useState("Cash");
  const [amountReceivedDraft, setAmountReceivedDraft] = useState("");
  const [notesDraft, setNotesDraft] = useState("");

  const [paymentFilter, setPaymentFilter] =
    useState<PaymentFilter>("all");
  const [search, setSearch] = useState("");
  const [lightboxUrl, setLightboxUrl] = useState("");
  const [deleteEventCandidate, setDeleteEventCandidate] =
    useState<PostRunEvent | null>(null);
  const [duplicateContactWarning, setDuplicateContactWarning] =
    useState<DuplicateContactWarning | null>(null);
  const [draggingParticipantId, setDraggingParticipantId] = useState("");
  const [busyKey, setBusyKey] = useState("");
  const [isLoadingEvents, setIsLoadingEvents] = useState(true);
  const [isLoadingParticipants, setIsLoadingParticipants] = useState(false);
  const [eventsServiceError, setEventsServiceError] = useState<string | null>(
    null,
  );
  const [eventsConnectionMessage, setEventsConnectionMessage] = useState<
    string | null
  >(null);
  const [isLoadingRunDate, setIsLoadingRunDate] = useState(false);
  const [activeRunSheetName, setActiveRunSheetName] = useState("");
  const [activeRunDateError, setActiveRunDateError] = useState("");
  const [notice, setNotice] = useState<{
    tone: "success" | "error" | "idle";
    message: string;
  }>({ tone: "idle", message: "" });
  const participantsRequestIdRef = useRef(0);
  const activeDateRequestIdRef = useRef(0);
  const activeOperationRef = useRef(false);
  const touchReorderIdRef = useRef("");

  const selectedEvent =
    events.find((event) => event.id === selectedEventId) ?? null;
  const selectedParticipant =
    participants.find(
      (participant) => participant.id === selectedParticipantId,
    ) ?? null;
  const isSuperAdmin = admin?.role === "super-admin";
  const isSelectedEventArchived = selectedEvent?.isArchived ?? false;
  const isAnyBusy = busyKey.length > 0;
  const activeEvents = useMemo(
    () => events.filter((event) => !event.isArchived),
    [events],
  );
  const archivedEvents = useMemo(
    () => events.filter((event) => event.isArchived),
    [events],
  );

  const loadSession = useCallback(async () => {
    const { response, payload } = await apiRequest("/api/auth/session");

    if (
      !response.ok ||
      !isObject(payload) ||
      !isObject(payload.admin)
    ) {
      throw new Error(readError(payload, "Admin session could not be loaded."));
    }

    const nextAdmin = payload.admin as ActiveAdmin;
    setAdmin(nextAdmin);
    window.sessionStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify(nextAdmin),
    );
  }, []);

  const loadEvents = useCallback(async (includeArchived = false) => {
    setIsLoadingEvents(true);
    setEventsServiceError(null);
    setEventsConnectionMessage(null);

    const maxRetries = 3;
    const baseDelay = 1500;

    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
      try {
        let result: Awaited<ReturnType<typeof apiRequest>>;

        try {
          result = await apiRequest(
            includeArchived
              ? `${POST_RUN_EVENTS_API}?includeArchived=true`
              : POST_RUN_EVENTS_API,
          );
        } catch {
          if (attempt < maxRetries) {
            await new Promise((r) =>
              setTimeout(r, baseDelay * 2 ** (attempt - 1)),
            );
            continue;
          }

          setEventsConnectionMessage(
            "\u26A0\uFE0F Connection slow. Retrying sync with Google Sheets...",
          );
          setIsLoadingEvents(false);
          return false;
        }

        const { response, payload } = result;

        if (response.status === 500 || response.status === 503) {
          if (attempt < maxRetries) {
            await new Promise((r) =>
              setTimeout(r, baseDelay * 2 ** (attempt - 1)),
            );
            continue;
          }

          setEventsServiceError(
            readError(
              payload,
              "\u26A0\uFE0F Connection slow. Retrying sync with Google Sheets...",
            ),
          );
          setIsLoadingEvents(false);
          return false;
        }

        if (!response.ok) {
          setIsLoadingEvents(false);
          return false;
        }

        const eventPayload = Array.isArray(payload)
          ? payload
          : isObject(payload) && Array.isArray(payload.events)
            ? payload.events
            : null;

        if (!eventPayload) {
          setIsLoadingEvents(false);
          return false;
        }

        const nextEvents = eventPayload as PostRunEvent[];
        setEventsServiceError(null);
        setNotice((current) =>
          current.tone === "error" ? { tone: "idle", message: "" } : current,
        );
        const dataSource = response.headers.get("X-Data-Source");
        if (dataSource === "cache") {
          setEventsConnectionMessage(
            "⚠️ Showing cached data. Google Sheets sync is recovering...",
          );
        } else {
          setEventsConnectionMessage(null);
        }

        setEvents(nextEvents);
        const stored =
          typeof window !== "undefined"
            ? window.localStorage.getItem("glow_active_event_id")
            : null;
        setSelectedEventId((current) => {
          let resolved = "";
          if (current && nextEvents.some((event) => event.id === current)) {
            resolved = current;
          } else if (
            activeEventIdRef.current &&
            nextEvents.some((event) => event.id === activeEventIdRef.current)
          ) {
            resolved = activeEventIdRef.current;
          } else if (
            stored &&
            nextEvents.some((event) => event.id === stored)
          ) {
            resolved = stored;
          } else {
            resolved = nextEvents[0]?.id ?? "";
          }

          activeEventIdRef.current = resolved;
          if (typeof window !== "undefined" && resolved) {
            try {
              window.localStorage.setItem("glow_active_event_id", resolved);
            } catch {
              // ignore
            }
          }
          return resolved;
        });

        setIsLoadingEvents(false);
        return true;
      } catch {
        if (attempt >= maxRetries) {
          setEventsConnectionMessage(
            "⚠️ Connection slow. Retrying sync with Google Sheets...",
          );
          setIsLoadingEvents(false);
          return false;
        }

        await new Promise((r) =>
          setTimeout(r, baseDelay * 2 ** (attempt - 1)),
        );
      }
    }

    setIsLoadingEvents(false);
    return false;
  }, []);

  const loadParticipants = useCallback(async (
    eventId?: string,
  ) => {
    const effectiveEventId =
      eventId ||
      activeEventIdRef.current ||
      (typeof window !== "undefined"
        ? window.localStorage.getItem("glow_active_event_id") || ""
        : "");

    if (!effectiveEventId) {
      setIsLoadingParticipants(false);
      return;
    }

    const requestId = participantsRequestIdRef.current + 1;
    participantsRequestIdRef.current = requestId;

    setIsLoadingParticipants(true);

    const maxRetries = 3;
    const retryDelay = 1000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (participantsRequestIdRef.current !== requestId) return;

      try {
        const { response, payload } = await apiRequest(
          `/api/events/${encodeURIComponent(effectiveEventId)}/participants`,
          {
            headers: {
              "Cache-Control": "no-cache, no-store, must-revalidate",
            },
          },
        );

        if (
          !response.ok ||
          !isObject(payload) ||
          !Array.isArray(payload.participants)
        ) {
          throw new Error(readError(payload, "Participants could not be loaded."));
        }

        if (participantsRequestIdRef.current === requestId) {
          // Auto-clear recovered error banners on HTTP 200 OK
          setEventsServiceError(null);
          setEventsConnectionMessage(null);
          setNotice((current) =>
            current.tone === "error" ? { tone: "idle", message: "" } : current,
          );

          const incoming = payload.participants as Participant[];
          setParticipants((current) => {
            if (incoming.length === 0 && current.length > 0) {
              console.warn(
                "Incoming participants empty; retaining current participant state.",
              );
              return current;
            }
            if (current.length === 0) {
              return incoming;
            }
            const locallyCleared = new Map(
              current
                .filter(
                  (p) =>
                    p.paymentStatus === "FULLY_CLEARED" ||
                    p.settlementStatus === "FULLY_CLEARED" ||
                    p.paymentStatus === "FREE",
                )
                .map((p) => [p.id, p]),
            );

            return incoming.map((p) => {
              const existing = locallyCleared.get(p.id);
              if (
                existing &&
                p.paymentStatus !== "FULLY_CLEARED" &&
                p.paymentStatus !== "FREE"
              ) {
                return {
                  ...p,
                  paymentStatus: existing.paymentStatus,
                  settlementStatus: existing.settlementStatus,
                  amountPaid: Math.max(p.amountPaid, existing.amountPaid),
                  depositPaid: Math.max(p.depositPaid, existing.depositPaid),
                  remainingBalance: 0,
                };
              }
              return p;
            });
          });

          setIsLoadingParticipants(false);
          return;
        }
      } catch (error) {
        console.warn(
          `Participant fetch attempt ${attempt}/${maxRetries} failed:`,
          error,
        );

        if (attempt < maxRetries) {
          // Keep skeleton loader active during silent retry
          await new Promise((resolve) => setTimeout(resolve, retryDelay));
        } else {
          // All retries failed: retain existing participant state
          console.error(
            "All participant fetch retries failed, preserving current roster in state",
            error,
          );
          if (participantsRequestIdRef.current === requestId) {
            setParticipants((current) => {
              if (current.length === 0) {
                setNotice({
                  tone: "error",
                  message:
                    error instanceof Error
                      ? error.message
                      : "Participants could not be loaded.",
                });
              } else {
                setEventsConnectionMessage(
                  "⚠️ Showing cached data. Google Sheets sync is recovering...",
                );
              }
              return current;
            });
          }
        }
      }
    }

    if (participantsRequestIdRef.current === requestId) {
      setIsLoadingParticipants(false);
    }
  }, []);



  useEffect(() => {
    setEventsServiceError(null);
    setEventsConnectionMessage(null);
    void Promise.all([loadSession(), loadEvents(false)]).catch(
      (error: unknown) => {
        setNotice({
          tone: "error",
          message:
            error instanceof Error
              ? error.message
              : "The event manager could not be loaded.",
        });
      },
    );
  }, [loadEvents, loadSession]);

  useEffect(() => {
    if (selectedEventId) {
      activeEventIdRef.current = selectedEventId;
      if (typeof window !== "undefined") {
        try {
          window.localStorage.setItem("glow_active_event_id", selectedEventId);
        } catch {
          // ignore
        }
      }
    }
  }, [selectedEventId]);

  useEffect(() => {
    setSelectedParticipantId("");
    setSearch("");
    setPaymentFilter("all");
    void loadParticipants(selectedEventId);
  }, [loadParticipants, selectedEventId]);


  const totals = useMemo(() => {
    if (!selectedEvent) {
      return {
        totalRegistered: 0,
        freeCount: 0,
        payingCount: 0,
        expected: 0,
        collected: 0,
        remaining: 0,
        cashCollected: 0,
        digitalCollected: 0,
        totalChangeOwed: 0,
      };
    }

    const totalRegistered = participants.length;
    const freeCount = participants.filter(
      (participant) =>
        String(participant.paymentStatus ?? "").trim().toUpperCase() ===
        "FREE",
    ).length;
    const payingCount = Math.max(0, totalRegistered - freeCount);
    const ticketPrice = safeNonNegativeNumber(selectedEvent.eventTicketPrice);
    const expected = safeNonNegativeNumber(payingCount * ticketPrice);

    let cashCollected = 0;
    let digitalCollected = 0;
    let totalChangeOwed = 0;

    participants.forEach((p) => {
      const paid = safeNonNegativeNumber(p.amountPaid);
      const change = safeNonNegativeNumber(p.changeOwed);
      const method = (p.paymentMethod || "").toLowerCase();

      if (
        method.includes("instapay") ||
        method.includes("vodafone") ||
        method.includes("digital") ||
        method.includes("online")
      ) {
        digitalCollected += paid;
      } else {
        cashCollected += paid;
      }

      totalChangeOwed += change;
    });

    const collected = safeNonNegativeNumber(cashCollected + digitalCollected);

    return {
      totalRegistered,
      freeCount,
      payingCount,
      expected,
      collected,
      remaining: Math.max(0, expected - collected),
      cashCollected,
      digitalCollected,
      totalChangeOwed,
    };
  }, [participants, selectedEvent]);


  const visibleParticipants = useMemo(() => {
    if (!selectedEvent) {
      return [];
    }

    const normalizedSearch = search.trim().toLocaleLowerCase("en-US");

    const filteredByPayment = participants.filter((participant) => {
      const state = paymentState(participant, selectedEvent);
      return paymentFilter === "all" || state.kind === paymentFilter;
    });

    return filteredByPayment.filter(
      (participant) =>
        !normalizedSearch ||
        `${participant.fullName} ${participant.phoneNumber}`
          .toLocaleLowerCase("en-US")
          .includes(normalizedSearch),
    );
  }, [participants, paymentFilter, search, selectedEvent]);

  const refreshActiveRunDate = useCallback(async (requestId: number) => {
    setIsLoadingRunDate(true);
    setActiveRunDateError("");
    setActiveRunSheetName("");

    try {
      const { response, payload } = await apiRequest("/api/sheets/active-date");

      if (activeDateRequestIdRef.current !== requestId) {
        return;
      }

      if (!response.ok) {
        setActiveRunDateError(
          readError(payload, "The active run date could not be loaded."),
        );
        return;
      }

      if (!isObject(payload) || !isIsoDate(payload.date)) {
        setActiveRunDateError(
          "No dated Attendance tab was found. A Super Admin can choose a custom date.",
        );
        return;
      }

      const activeDate = payload.date;
      setActiveRunSheetName(
        typeof payload.sheetName === "string" ? payload.sheetName : "",
      );
      setEventForm((current) =>
        current.runDate ? current : { ...current, runDate: activeDate },
      );
    } catch {
      if (activeDateRequestIdRef.current === requestId) {
        setActiveRunDateError(
          "The active run date service could not be reached. A Super Admin can choose a custom date.",
        );
      }
    } finally {
      if (activeDateRequestIdRef.current === requestId) {
        setIsLoadingRunDate(false);
      }
    }
  }, []);

  const openCreateEvent = () => {
    const requestId = activeDateRequestIdRef.current + 1;
    activeDateRequestIdRef.current = requestId;
    setEventForm(EMPTY_EVENT_FORM);
    setEventModal("create");
    void refreshActiveRunDate(requestId);
  };

  const openEditEvent = () => {
    if (!selectedEvent || !isSuperAdmin || selectedEvent.isArchived) {
      return;
    }

    activeDateRequestIdRef.current += 1;
    setIsLoadingRunDate(false);
    setActiveRunDateError("");
    setActiveRunSheetName("");

    setEventForm({
      title: selectedEvent.title,
      runDate: selectedEvent.runDate,
      totalCost: String(selectedEvent.totalCost),
      depositAmount: String(selectedEvent.depositAmount),
      capacity:
        selectedEvent.capacity === null ? "" : String(selectedEvent.capacity),
      paymentInstructions: selectedEvent.paymentInstructions,
    });
    setEventModal("edit");
  };

  const closeEventModal = () => {
    activeDateRequestIdRef.current += 1;
    setIsLoadingRunDate(false);
    setEventModal(null);
  };

  const createEvent = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (activeOperationRef.current || isLoadingEvents) {
      return;
    }

    activeOperationRef.current = true;
    setBusyKey("create-event");

    try {
      const { response, payload } = await apiRequest(POST_RUN_EVENTS_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: eventForm.title,
          runDate: eventForm.runDate,
          eventTicketPrice: Number(eventForm.totalCost),
          standardDeposit: Number(eventForm.depositAmount),
          totalCost: Number(eventForm.totalCost),
          depositAmount: Number(eventForm.depositAmount),
          capacity: eventForm.capacity ? Number(eventForm.capacity) : null,
          paymentInstructions: eventForm.paymentInstructions,
        }),
      });

      if (!response.ok || !isObject(payload) || !isObject(payload.event)) {
        throw new Error(readError(payload, "The event could not be created."));
      }

      const created = payload.event as PostRunEvent;
      setEvents((current) => [created, ...current]);
      setSelectedEventId(created.id);
      closeEventModal();
      setNotice({
        tone: "success",
        message: `${created.title} was created.`,
      });
    } catch (error) {
      setNotice({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "The event could not be created.",
      });
    } finally {
      activeOperationRef.current = false;
      setBusyKey("");
    }
  };

  const editEvent = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!selectedEvent || !isSuperAdmin || activeOperationRef.current) {
      return;
    }

    activeOperationRef.current = true;
    setBusyKey("edit-event");

    try {
      const { response, payload } = await apiRequest(
        `/api/events/${encodeURIComponent(selectedEvent.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: eventForm.title,
            runDate: eventForm.runDate,
            eventTicketPrice: Number(eventForm.totalCost),
            standardDeposit: Number(eventForm.depositAmount),
            capacity: eventForm.capacity ? Number(eventForm.capacity) : null,
            paymentInstructions: eventForm.paymentInstructions,
          }),
        },
      );

      if (!response.ok || !isObject(payload) || !isObject(payload.event)) {
        throw new Error(readError(payload, "Event settings could not be saved."));
      }

      const updated = payload.event as PostRunEvent;
      setEvents((current) =>
        current.map((candidate) =>
          candidate.id === updated.id ? updated : candidate,
        ),
      );
      closeEventModal();
      setNotice({
        tone: "success",
        message: `${updated.title} settings were updated.`,
      });
    } catch (error) {
      setNotice({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "Event settings could not be saved.",
      });
    } finally {
      activeOperationRef.current = false;
      setBusyKey("");
    }
  };

  const setEventArchived = async (shouldArchive: boolean) => {
    if (
      !selectedEvent ||
      !isSuperAdmin ||
      activeOperationRef.current ||
      selectedEvent.isArchived === shouldArchive
    ) {
      return;
    }

    activeOperationRef.current = true;
    setBusyKey(shouldArchive ? "archive-event" : "unarchive-event");

    try {
      const { response, payload } = await apiRequest(
        `/api/events/${encodeURIComponent(selectedEvent.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isArchived: shouldArchive }),
        },
      );

      if (!response.ok || !isObject(payload) || !isObject(payload.event)) {
        throw new Error(
          readError(
            payload,
            shouldArchive
              ? "The event could not be archived."
              : "The event could not be unarchived.",
          ),
        );
      }

      const updated = payload.event as PostRunEvent;
      const nextEvents = shouldArchive
        ? showArchivedEvents
          ? events.map((candidate) =>
              candidate.id === updated.id ? updated : candidate,
            )
          : events.filter((candidate) => candidate.id !== updated.id)
        : events.map((candidate) =>
            candidate.id === updated.id ? updated : candidate,
          );
      const nextActiveEvent = nextEvents.find(
        (candidate) => !candidate.isArchived && candidate.id !== updated.id,
      );
      setEvents(nextEvents);
      setSelectedEventId(
        shouldArchive
          ? (nextActiveEvent?.id ??
              (showArchivedEvents ? updated.id : ""))
          : updated.id,
      );
      setNotice({
        tone: "success",
        message: `${selectedEvent.title} was ${
          shouldArchive ? "archived" : "unarchived"
        }.`,
      });
    } catch (error) {
      setNotice({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : shouldArchive
              ? "The event could not be archived."
              : "The event could not be unarchived.",
      });
    } finally {
      activeOperationRef.current = false;
      setBusyKey("");
    }
  };

  const toggleArchivedEvents = async (nextValue: boolean) => {
    if (!isSuperAdmin || activeOperationRef.current) {
      return;
    }

    setShowArchivedEvents(nextValue);

    try {
      const loaded = await loadEvents(nextValue);

      if (!loaded) {
        setShowArchivedEvents(!nextValue);
      }
    } catch (error) {
      setShowArchivedEvents(!nextValue);
      setNotice({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "Archived events could not be loaded.",
      });
    }
  };

  const permanentlyDeleteEvent = async () => {
    const candidate = deleteEventCandidate;

    if (!candidate || !isSuperAdmin || activeOperationRef.current) {
      return;
    }

    activeOperationRef.current = true;
    setBusyKey("delete-event");

    try {
      const { response, payload } = await apiRequest(
        `/api/events/${encodeURIComponent(candidate.id)}`,
        { method: "DELETE" },
      );

      if (!response.ok) {
        throw new Error(
          readError(payload, "The event could not be permanently deleted."),
        );
      }

      const remainingEvents = events.filter(
        (event) => event.id !== candidate.id,
      );
      const nextEvent =
        remainingEvents.find((event) => !event.isArchived) ??
        (showArchivedEvents ? remainingEvents[0] : undefined);
      setEvents(remainingEvents);
      setSelectedEventId(nextEvent?.id ?? "");
      setDeleteEventCandidate(null);
      setNotice({
        tone: "success",
        message: `${candidate.title} and its participant ledger were permanently deleted.`,
      });
    } catch (error) {
      setNotice({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "The event could not be permanently deleted.",
      });
    } finally {
      activeOperationRef.current = false;
      setBusyKey("");
    }
  };

  const handleAddParticipant = async ({
    candidate,
    force,
  }: {
    candidate: ParticipantFormState;
    force: boolean;
  }) => {
    setEventsServiceError(null);
    setEventsConnectionMessage(null);

    if (
      !selectedEvent ||
      selectedEvent.isArchived ||
      activeOperationRef.current
    ) {
      return;
    }

    activeOperationRef.current = true;
    setBusyKey("add-participant");

    try {
      const { response, payload } = await apiRequest(
        `/api/events/${encodeURIComponent(selectedEvent.id)}/participants`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...candidate, force }),
        },
      );

      if (
        !response.ok ||
        !isObject(payload) ||
        !isObject(payload.participant)
      ) {
        throw new Error(
          readError(payload, "The participant could not be added."),
        );
      }

      const created = payload.participant as Participant;
      setParticipants((current) => [...current, created]);
      setParticipantForm(EMPTY_PARTICIPANT_FORM);
      setDuplicateContactWarning(null);
      setNotice({
        tone: "success",
        message: `${created.fullName} was added.`,
      });
      notifyGateRosterChanged();
      void loadParticipants(selectedEvent.id);
    } catch (error) {

      setNotice({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "The participant could not be added.",
      });
    } finally {
      activeOperationRef.current = false;
      setBusyKey("");
    }
  };

  const addParticipant = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedContact = normalizeContactForComparison(
      participantForm.phoneNumber,
    );
    const existingParticipant = normalizedContact
      ? participants.find(
          (participant) =>
            normalizeContactForComparison(participant.phoneNumber) ===
            normalizedContact,
        )
      : undefined;

    if (existingParticipant) {
      setDuplicateContactWarning({
        existingParticipant,
        candidate: { ...participantForm },
        normalizedContact,
      });
      return;
    }

    void handleAddParticipant({
      candidate: { ...participantForm },
      force: false,
    });
  };

  const updateParticipant = useCallback(
    async (
      participant: Participant,
      patch: ParticipantPatch,
      action: string,
    ): Promise<Participant | null> => {
      if (
        !selectedEvent ||
        selectedEvent.isArchived ||
        activeOperationRef.current
      ) {
        return null;
      }

      activeOperationRef.current = true;
      setBusyKey(`${action}:${participant.id}`);
      const previous = participant;
      const nextStatus = patch.paymentStatus ?? participant.paymentStatus;
      const nextAmount = nextStatus === "FREE"
        ? 0
        : patch.amountPaid ?? participant.amountPaid;
      const optimisticState = paymentState(
        {
          ...participant,
          amountPaid: nextAmount,
          paymentStatus: nextStatus,
        },
        selectedEvent,
      );
      const optimistic: Participant = {
        ...participant,
        fullName: patch.fullName ?? participant.fullName,
        phoneNumber: patch.phoneNumber ?? participant.phoneNumber,
        paymentStatus: nextStatus,
        amountPaid: nextAmount,
        depositPaid: nextAmount,
        remainingBalance: optimisticState.remaining,
        depositStatus:
          optimisticState.kind === "unpaid" || optimisticState.kind === "free"
            ? "PENDING"
            : "VERIFIED",
        settlementStatus:
          optimisticState.kind === "cleared"
            ? "FULLY_CLEARED"
            : "UNPAID",
        updatedAt: new Date().toISOString(),
      };
      setParticipants((current) =>
        current.map((candidate) =>
          candidate.id === participant.id ? optimistic : candidate,
        ),
      );

      try {
        const { response, payload } = await apiRequest(
          `/api/events/${encodeURIComponent(selectedEvent.id)}/participants`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ participantId: participant.id, ...patch }),
          },
        );

        if (
          !response.ok ||
          !isObject(payload) ||
          !isObject(payload.participant)
        ) {
          throw new Error(
            readError(payload, "The participant could not be updated."),
          );
        }

        const updated = payload.participant as Participant;
        setParticipants((current) =>
          current.map((candidate) =>
            candidate.id === participant.id ? updated : candidate,
          ),
        );
        setNotice({
          tone: "success",
          message:
            action === "clear"
              ? `${updated.fullName} is fully cleared.`
              : `${updated.fullName}'s ledger was updated.`,
        });
        notifyGateRosterChanged();
        return updated;
      } catch (error) {
        setParticipants((current) =>
          current.map((candidate) =>
            candidate.id === participant.id ? previous : candidate,
          ),
        );
        setNotice({
          tone: "error",
          message:
            error instanceof Error
              ? error.message
              : "The participant could not be updated.",
        });
        return null;
      } finally {
        activeOperationRef.current = false;
        setBusyKey("");
      }
    },
    [selectedEvent],
  );

  const clearParticipant = async (
    participant: Participant,
    method?: string,
    changeOwed?: number,
  ) => {
    if (!selectedEvent || selectedEvent.isArchived) {
      return;
    }

    const updated = await updateParticipant(
      participant,
      {
        amountPaid: selectedEvent.totalCost,
        paymentStatus: "FULLY_CLEARED",
        paymentMethod: method ?? participant.paymentMethod ?? "Cash",
        changeOwed: changeOwed ?? 0,
      },
      "clear",
    );

    if (updated && selectedParticipantId === updated.id) {
      setPaymentDraft(String(updated.amountPaid));
      setPaymentStatusDraft(updated.paymentStatus);
      setPaymentMethodDraft(updated.paymentMethod || "Cash");
    }
  };

  const uploadProof = async (
    participant: Participant,
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file || selectedEvent?.isArchived || activeOperationRef.current) {
      return;
    }

    activeOperationRef.current = true;
    setBusyKey(`proof:${participant.id}`);

    try {
      const compressed = await compressProofImage(file);
      const formData = new FormData();
      formData.set("file", compressed);
      formData.set("eventId", participant.eventId);
      formData.set("participantId", participant.id);
      const { response, payload } = await apiRequest("/api/upload-proof", {
        method: "POST",
        body: formData,
      });

      if (
        !response.ok ||
        !isObject(payload) ||
        !isObject(payload.participant)
      ) {
        throw new Error(readError(payload, "Payment proof upload failed."));
      }

      const updated = payload.participant as Participant;
      setParticipants((current) =>
        current.map((candidate) =>
          candidate.id === participant.id ? updated : candidate,
        ),
      );
      setNotice({
        tone: "success",
        message: `${updated.fullName}'s payment proof was saved.`,
      });
    } catch (error) {
      setNotice({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "Payment proof upload failed.",
      });
    } finally {
      activeOperationRef.current = false;
      setBusyKey("");
    }
  };

  const deleteParticipant = async (participant: Participant) => {
    if (
      !selectedEvent ||
      selectedEvent.isArchived ||
      !isSuperAdmin ||
      activeOperationRef.current ||
      !window.confirm(
        `Delete ${participant.fullName} from ${selectedEvent.title}?`,
      )
    ) {
      return;
    }

    activeOperationRef.current = true;
    setBusyKey(`delete:${participant.id}`);

    try {
      const { response, payload } = await apiRequest(
        `/api/events/${encodeURIComponent(
          selectedEvent.id,
        )}/participants/${encodeURIComponent(participant.id)}`,
        { method: "DELETE" },
      );

      if (!response.ok) {
        throw new Error(
          readError(payload, "The participant could not be deleted."),
        );
      }

      setParticipants((current) =>
        current.filter((candidate) => candidate.id !== participant.id),
      );
      setSelectedParticipantId("");
      setNotice({
        tone: "success",
        message: `${participant.fullName} was deleted from the event.`,
      });
      notifyGateRosterChanged();
    } catch (error) {
      setNotice({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "The participant could not be deleted.",
      });
    } finally {
      activeOperationRef.current = false;
      setBusyKey("");
    }
  };

  const handleOpenEditModal = (participant: Participant) => {
    setSelectedParticipantId(participant.id);
    setParticipantNameDraft(participant.fullName);
    setParticipantContactDraft(participant.phoneNumber);
    setPaymentDraft(String(participant.amountPaid));
    setPaymentStatusDraft(participant.paymentStatus);
    setPaymentMethodDraft(participant.paymentMethod || "Cash");
    setAmountReceivedDraft("");
    setNotesDraft(participant.internalNotes ?? "");
  };

  const reorderParticipant = useCallback(
    (
      participantId: string,
      targetParticipantId: string,
      placement: "before" | "after",
    ) => {
      if (!participantId || participantId === targetParticipantId) {
        return;
      }

      setParticipants((current) => {
        const sourceIndex = current.findIndex(
          (participant) => participant.id === participantId,
        );
        const targetIndex = current.findIndex(
          (participant) => participant.id === targetParticipantId,
        );

        if (sourceIndex < 0 || targetIndex < 0) {
          return current;
        }

        const reordered = [...current];
        const [movedParticipant] = reordered.splice(sourceIndex, 1);
        const adjustedTargetIndex = reordered.findIndex(
          (participant) => participant.id === targetParticipantId,
        );
        const insertionIndex =
          adjustedTargetIndex + (placement === "after" ? 1 : 0);
        reordered.splice(insertionIndex, 0, movedParticipant);

        return reordered.every(
          (participant, index) => participant.id === current[index]?.id,
        )
          ? current
          : reordered;
      });
    },
    [],
  );

  const moveParticipantByOffset = useCallback(
    (participantId: string, offset: -1 | 1) => {
      const visibleIndex = visibleParticipants.findIndex(
        (participant) => participant.id === participantId,
      );
      const targetParticipant = visibleParticipants[visibleIndex + offset];

      if (visibleIndex < 0 || !targetParticipant) {
        return;
      }

      reorderParticipant(
        participantId,
        targetParticipant.id,
        offset < 0 ? "before" : "after",
      );
    },
    [reorderParticipant, visibleParticipants],
  );

  const handleTouchReorderMove = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    const participantId = touchReorderIdRef.current;

    if (!participantId || event.pointerType === "mouse") {
      return;
    }

    event.preventDefault();
    const targetCard = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>("[data-participant-id]");
    const targetParticipantId = targetCard?.dataset.participantId;

    if (!targetCard || !targetParticipantId) {
      return;
    }

    const targetBounds = targetCard.getBoundingClientRect();
    reorderParticipant(
      participantId,
      targetParticipantId,
      event.clientY >= targetBounds.top + targetBounds.height / 2
        ? "after"
        : "before",
    );
  };

  const finishTouchReorder = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === "mouse") {
      return;
    }

    touchReorderIdRef.current = "";
    setDraggingParticipantId("");

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const copySummary = async () => {
    if (!selectedEvent) {
      return;
    }

    const reportMoney = (value: number) =>
      safeNonNegativeNumber(value).toLocaleString("en-US");
    const participantRoster = participants.map((participant, index) => {
      const state = paymentState(participant, selectedEvent);
      const contact = participant.phoneNumber.trim() || "No contact";
      const participantLabel = `${index + 1}. ${participant.fullName} (${contact})`;

      if (state.kind === "free") {
        return `${participantLabel} – 🎁 Free Attendee`;
      }

      if (state.kind === "cleared") {
        return `${participantLabel} – ✅ Cleared (${reportMoney(
          state.amountPaid,
        )} EGP paid)`;
      }

      if (state.kind === "deposit") {
        return `${participantLabel} – 🟡 Deposit Paid (${reportMoney(
          state.amountPaid,
        )} EGP paid | ${reportMoney(state.remaining)} EGP owed)`;
      }

      return `${participantLabel} – 🔴 Unpaid (0 EGP paid | ${reportMoney(
        state.remaining,
      )} EGP owed)`;
    });
    const report = [
      `📊 GlowRunners Post-Run Report – ${selectedEvent.title}`,
      `📅 ${formatEventDate(selectedEvent.runDate)}`,
      `👥 Registered: ${totals.totalRegistered} (${totals.payingCount} Paying + ${totals.freeCount} Free Attendees)`,
      `💰 Expected Revenue: ${reportMoney(totals.expected)} EGP`,
      `✅ Total Collected: ${reportMoney(totals.collected)} EGP`,
      `🟡 Remaining Balance: ${reportMoney(totals.remaining)} EGP`,
      "",
      "──────────────────────────────",
      "📋 PARTICIPANT ROSTER",
      "",
      ...participantRoster,
    ].join("\n");

    try {
      await copyText(report);
      setNotice({
        tone: "success",
        message: "WhatsApp-ready event report copied.",
      });
    } catch (error) {
      setNotice({
        tone: "error",
        message:
          error instanceof Error ? error.message : "Report could not be copied.",
      });
    }
  };

  const logout = async () => {
    if (activeOperationRef.current) {
      return;
    }

    activeOperationRef.current = true;
    setBusyKey("logout");

    try {
      const { response, payload } = await apiRequest("/api/auth/session", {
        method: "DELETE",
      });

      if (!response.ok) {
        throw new Error(readError(payload, "Sign out failed."));
      }

      window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
      window.location.assign("/admin/login");
    } catch (error) {
      setNotice({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "Could not sign out. Check the connection and retry.",
      });
      activeOperationRef.current = false;
      setBusyKey("");
    }
  };

  const noticeClass =
    notice.tone === "success"
      ? "border-emerald-700 bg-emerald-950/60 text-emerald-200"
      : "border-red-800 bg-red-950/60 text-red-200";

  return (
    <main className="flex min-h-screen w-full flex-col items-center justify-start overflow-x-hidden bg-black px-4 py-3 text-white">
      <div className="box-border flex w-full max-w-md min-w-0 flex-col gap-3">
        <header className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-black uppercase tracking-[0.18em] text-fuchsia-400">
              GlowRunners Admin
            </p>
            <h1 className="truncate text-xl font-black">Post-Run Events</h1>
            <p className="truncate text-xs font-semibold text-zinc-500">
              {admin ? `Active: ${admin.displayName}` : "Loading admin…"}
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Link
              href="/admin"
              className="flex min-h-11 items-center rounded-xl border border-zinc-700 px-3 text-xs font-black"
            >
              Gate
            </Link>
            <button
              type="button"
              onClick={() => void logout()}
              disabled={isAnyBusy}
              className="min-h-11 rounded-xl border border-zinc-700 px-3 text-xs font-black disabled:opacity-50"
            >
              Sign out
            </button>
          </div>
        </header>

        {notice.tone !== "idle" && notice.message ? (
          <div
            className={`rounded-xl border px-3 py-2 text-xs font-bold ${noticeClass}`}
            role={notice.tone === "error" ? "alert" : "status"}
            aria-live="polite"
          >
            {notice.message}
          </div>
        ) : null}

        {eventsServiceError &&
        !/initializing|storage|configured/i.test(eventsServiceError) ? (
          <div
            className="flex min-w-0 flex-wrap items-center gap-2 rounded-xl border border-amber-800 bg-amber-950/50 px-3 py-2 text-xs font-bold text-amber-200"
            role="status"
            aria-live="polite"
          >
            <span className="min-w-0 flex-1 break-words">
              {eventsServiceError}
            </span>
            <button
              type="button"
              onClick={() => void loadEvents(showArchivedEvents)}
              disabled={isLoadingEvents}
              className="shrink-0 rounded-lg border border-amber-700 bg-amber-900/40 px-2.5 py-1 text-[11px] font-black text-amber-100 disabled:opacity-50"
            >
              Retry Now
            </button>
            <button
              type="button"
              onClick={() => setEventsServiceError(null)}
              className="shrink-0 px-1 text-base leading-none text-amber-400"
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        ) : null}

        {eventsConnectionMessage &&
        !/initializing|storage|configured/i.test(eventsConnectionMessage) ? (
          <div
            className="flex min-w-0 flex-wrap items-center gap-2 rounded-xl border border-amber-800 bg-amber-950/50 px-3 py-2 text-xs font-bold text-amber-200"
            role="status"
            aria-live="polite"
          >
            <span className="min-w-0 flex-1 break-words">
              {eventsConnectionMessage}
            </span>
            <button
              type="button"
              onClick={() => void loadEvents(showArchivedEvents)}
              disabled={isLoadingEvents}
              className="shrink-0 rounded-lg border border-amber-700 bg-amber-900/40 px-2.5 py-1 text-[11px] font-black text-amber-100 disabled:opacity-50"
            >
              Retry Now
            </button>
            <button
              type="button"
              onClick={() => setEventsConnectionMessage(null)}
              className="shrink-0 px-1 text-base leading-none text-amber-400"
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        ) : null}

        {isLoadingEvents ? (
          <section className="rounded-xl border border-zinc-800 bg-zinc-950 p-4 text-sm font-bold text-zinc-400">
            Loading events…
          </section>
        ) : events.length === 0 ? (
          <section className="rounded-2xl border border-dashed border-zinc-700 bg-zinc-950 p-6 text-center">
            <h2 className="text-lg font-black">No events found</h2>
            <p className="mt-2 text-sm font-semibold text-zinc-400">
              {showArchivedEvents
                ? "There are no active or archived post-run events."
                : "Create the next post-run activity or show archived history."}
            </p>
            {isSuperAdmin ? (
              <label className="mt-4 flex min-h-11 w-full cursor-pointer items-center justify-between rounded-xl border border-amber-800/70 bg-amber-950/20 px-3 text-left text-xs font-black text-amber-200">
                <span>Show Archived Events</span>
                <input
                  type="checkbox"
                  role="switch"
                  checked={showArchivedEvents}
                  disabled={isAnyBusy}
                  onChange={(event) =>
                    void toggleArchivedEvents(event.target.checked)
                  }
                  className="h-5 w-5 accent-amber-400"
                />
              </label>
            ) : null}
            <button
              type="button"
              onClick={openCreateEvent}
              className="mt-4 min-h-12 w-full rounded-xl bg-fuchsia-500 px-4 font-black"
            >
              + Create event
            </button>
          </section>
        ) : (
          <>
            <section className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-2">
              <label className="min-w-0">
                <span className="sr-only">Selected event</span>
                <select
                  value={selectedEventId}
                  disabled={isAnyBusy}
                  onChange={(event) => {
                    setEventsServiceError(null);
                    setEventsConnectionMessage(null);
                    setSelectedEventId(event.target.value);
                  }}
                  className="min-h-11 w-full min-w-0 rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-sm font-black text-white outline-none focus:border-fuchsia-400"
                >
                  {activeEvents.length > 0 ? (
                    <optgroup label="Active Events">
                      {activeEvents.map((event) => (
                        <option value={event.id} key={event.id}>
                          {event.title} · {formatEventDate(event.runDate)}
                        </option>
                      ))}
                    </optgroup>
                  ) : null}
                  {showArchivedEvents && archivedEvents.length > 0 ? (
                    <optgroup label="Archived Events">
                      {archivedEvents.map((event) => (
                        <option
                          value={event.id}
                          key={event.id}
                          className="text-zinc-500"
                        >
                          📦 ARCHIVED · {event.title} ·{" "}
                          {formatEventDate(event.runDate)}
                        </option>
                      ))}
                    </optgroup>
                  ) : null}
                </select>
              </label>
              <button
                type="button"
                onClick={openCreateEvent}
                disabled={isAnyBusy}
                className="min-h-11 rounded-xl bg-fuchsia-500 px-3 text-xs font-black disabled:opacity-50"
              >
                + Event
              </button>
              {isSuperAdmin ? (
                <label className="col-span-2 flex min-h-11 cursor-pointer items-center justify-between rounded-xl border border-zinc-800 bg-zinc-950 px-3 text-xs font-black text-zinc-300">
                  <span>Show Archived Events</span>
                  <input
                    type="checkbox"
                    role="switch"
                    checked={showArchivedEvents}
                    disabled={isAnyBusy}
                    onChange={(event) =>
                      void toggleArchivedEvents(event.target.checked)
                    }
                    className="h-5 w-5 accent-amber-400"
                  />
                </label>
              ) : null}
            </section>

            {selectedEvent ? (
              <>
                <section
                  className={`min-w-0 rounded-xl border px-3 py-2 ${
                    isSelectedEventArchived
                      ? "border-zinc-700 bg-zinc-900/70"
                      : "border-fuchsia-900/70 bg-fuchsia-950/25"
                  }`}
                >
                  <div className="flex min-w-0 items-center justify-between gap-2">
                    <div className="min-w-0">
                      <h2 className="truncate text-base font-black">
                        {selectedEvent.title}
                      </h2>
                      <p
                        className={`truncate text-[11px] font-bold ${
                          isSelectedEventArchived
                            ? "text-zinc-400"
                            : "text-fuchsia-200"
                        }`}
                      >
                        {formatEventDate(selectedEvent.runDate)} · Ticket{" "}
                        {formatMoney(selectedEvent.totalCost)} · Deposit{" "}
                        {formatMoney(selectedEvent.depositAmount)}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      {isSelectedEventArchived ? (
                        <span className="rounded-full bg-zinc-700 px-2 py-1 text-[8px] font-black text-zinc-200">
                          📦 ARCHIVED
                        </span>
                      ) : null}
                      <span className="rounded-full bg-black/60 px-2 py-1 text-[10px] font-black">
                        {participants.length}/{selectedEvent.capacity ?? "∞"}
                      </span>
                    </div>
                  </div>
                </section>

                <section
                  className="grid min-w-0 grid-cols-3 gap-2"
                  aria-label="Financial overview"
                >
                  {[
                    ["EXPECTED REVENUE", totals.expected, "text-white"],
                    ["TOTAL COLLECTED", totals.collected, "text-emerald-300"],
                    ["REMAINING BALANCE", totals.remaining, "text-amber-300"],
                    ["💵 CASH COLLECTED", totals.cashCollected, "text-emerald-400"],
                    ["📱 INSTAPAY / DIGITAL", totals.digitalCollected, "text-sky-300"],
                    ["🔴 CHANGE OWED", totals.totalChangeOwed, "text-rose-300"],
                  ].map(([label, value, color]) => (
                    <div
                      className="min-w-0 rounded-xl border border-zinc-800 bg-zinc-950 p-2"
                      key={String(label)}
                    >
                      <p className="min-h-5 break-words text-[8px] font-black uppercase leading-[10px] tracking-wide text-zinc-500">
                        {String(label)}
                      </p>
                      <p
                        className={`mt-1 truncate text-[11px] font-black tabular-nums sm:text-xs ${String(
                          color,
                        )}`}
                      >
                        {formatMoney(Number(value))}
                      </p>
                    </div>
                  ))}
                </section>


                <section
                  className="min-w-0 rounded-xl border border-zinc-800 bg-zinc-950 p-2"
                  aria-label="Event Options and Settings"
                >
                  <div className="mb-2 flex items-center justify-between gap-2 px-1">
                    <h2 className="text-[10px] font-black uppercase tracking-wide text-zinc-400">
                      Event Options &amp; Settings
                    </h2>
                    <span className="text-[9px] font-bold text-zinc-600">
                      {isSelectedEventArchived
                        ? "ARCHIVED · READ ONLY"
                        : isSuperAdmin
                          ? "SUPER ADMIN"
                          : "READ ONLY"}
                    </span>
                  </div>
                  <div className="grid min-w-0 grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={openEditEvent}
                      disabled={
                        !isSuperAdmin || isSelectedEventArchived || isAnyBusy
                      }
                      className="min-h-11 min-w-0 rounded-lg border border-zinc-700 px-2 text-[10px] font-black disabled:text-zinc-600"
                    >
                      Edit Event
                    </button>
                    <button
                      type="button"
                      onClick={() => void copySummary()}
                      disabled={isAnyBusy}
                      className="min-h-11 min-w-0 rounded-lg border border-fuchsia-800 bg-fuchsia-950/30 px-2 text-[10px] font-black text-fuchsia-200 disabled:opacity-50"
                    >
                      Copy Report
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void setEventArchived(!isSelectedEventArchived)
                      }
                      disabled={!isSuperAdmin || isAnyBusy}
                      className="min-h-11 min-w-0 rounded-lg border border-amber-700 bg-amber-950/30 px-2 text-[10px] font-black text-amber-200 disabled:text-zinc-600"
                    >
                      {busyKey === "archive-event"
                        ? "Archiving…"
                        : busyKey === "unarchive-event"
                          ? "Unarchiving…"
                          : isSelectedEventArchived
                            ? "📦 Unarchive"
                            : "📦 Archive Event"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleteEventCandidate(selectedEvent)}
                      disabled={!isSuperAdmin || isAnyBusy}
                      className="min-h-11 min-w-0 rounded-lg border border-red-800 bg-gradient-to-r from-red-950 to-red-900/60 px-2 text-[10px] font-black text-red-200 disabled:text-zinc-600"
                    >
                      🗑️ Delete Event
                    </button>
                  </div>
                </section>

                {isSelectedEventArchived ? (
                  <section className="rounded-xl border border-amber-800/60 bg-amber-950/20 px-3 py-2 text-xs font-bold text-amber-200">
                    📦 Historical ledger is read-only. Unarchive this event to
                    add participants or change payments.
                  </section>
                ) : (
                  <details className="group min-w-0 rounded-xl border border-zinc-800 bg-zinc-950">
                    <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between px-3 text-xs font-black">
                      <span>+ ADD PARTICIPANT</span>
                      <span className="text-zinc-500 group-open:rotate-45">
                        +
                      </span>
                    </summary>
                    <form
                      onSubmit={addParticipant}
                      className="grid min-w-0 grid-cols-1 gap-2 border-t border-zinc-800 p-3 sm:grid-cols-2"
                    >
                    <input
                      type="text"
                      required
                      maxLength={120}
                      autoComplete="name"
                      placeholder="Participant name"
                      value={participantForm.fullName}
                      onChange={(event) =>
                        setParticipantForm((current) => ({
                          ...current,
                          fullName: event.target.value,
                        }))
                      }
                      className="min-h-12 min-w-0 rounded-xl border border-zinc-700 bg-black px-3 text-base font-bold outline-none focus:border-fuchsia-400"
                    />
                    <input
                      type="text"
                      maxLength={80}
                      autoComplete="off"
                      aria-label="WhatsApp phone or @username (optional)"
                      placeholder="WhatsApp phone or @username (optional)"
                      value={participantForm.phoneNumber}
                      onChange={(event) =>
                        setParticipantForm((current) => ({
                          ...current,
                          phoneNumber: event.target.value,
                        }))
                      }
                      className="min-h-12 min-w-0 rounded-xl border border-zinc-700 bg-black px-3 text-base font-bold outline-none focus:border-fuchsia-400"
                    />
                    <label className="min-w-0 text-[10px] font-black uppercase tracking-wide text-zinc-400 sm:col-span-2">
                      Payment status
                      <select
                        value={participantForm.paymentStatus}
                        onChange={(event) =>
                          setParticipantForm((current) => ({
                            ...current,
                            paymentStatus: event.target.value as PaymentStatus,
                          }))
                        }
                        className="mt-1 min-h-12 w-full min-w-0 rounded-xl border border-zinc-700 bg-black px-3 text-base font-black normal-case tracking-normal text-white outline-none focus:border-fuchsia-400"
                      >
                        <option value="UNPAID">Unpaid</option>
                        <option value="FREE">🎁 Free</option>
                      </select>
                    </label>
                    <button
                      type="submit"
                      className="min-h-12 rounded-xl bg-white px-3 text-sm font-black text-black disabled:opacity-50 sm:col-span-2"
                    >
                      {busyKey === "add-participant"
                        ? "Adding…"
                        : "Add participant"}
                    </button>
                    </form>
                  </details>
                )}

                <section className="min-w-0">
                  <div
                    className="grid min-w-0 grid-cols-5 gap-1"
                    aria-label="Filter participants"
                  >
                    {(
                      [
                        ["all", "All"],
                        ["unpaid", "Unpaid"],
                        ["deposit", "Deposit Paid"],
                        ["cleared", "Cleared"],
                        ["free", "Free"],
                      ] as const
                    ).map(([value, label]) => (
                      <button
                        type="button"
                        key={value}
                        onClick={() => setPaymentFilter(value)}
                        aria-pressed={paymentFilter === value}
                        className={`min-h-11 min-w-0 rounded-lg px-1 text-[9px] font-black leading-tight ${
                          paymentFilter === value
                            ? "bg-white text-black"
                            : "border border-zinc-800 bg-zinc-950 text-zinc-400"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <label className="sr-only" htmlFor="participant-search">
                    Search participants
                  </label>
                  <input
                    id="participant-search"
                    type="search"
                    inputMode="search"
                    enterKeyHint="search"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search name or phone…"
                    className="mt-2 min-h-11 w-full min-w-0 rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-base font-bold outline-none placeholder:text-zinc-600 focus:border-white"
                  />
                </section>

                {isLoadingParticipants ? (
                  <p className="rounded-xl border border-zinc-800 bg-zinc-950 p-4 text-sm font-bold text-zinc-400">
                    Loading participant ledger…
                  </p>
                ) : visibleParticipants.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-zinc-700 bg-zinc-950 p-4 text-center text-sm font-bold text-zinc-400">
                    {participants.length === 0
                      ? "No participants have been added."
                      : "No participants match this filter."}
                  </p>
                ) : (
                  <div
                    className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-zinc-800"
                    data-testid="compact-participant-list"
                  >
                    {visibleParticipants.map((participant) => {
                      const state = paymentState(participant, selectedEvent);
                      const isCleared = state.kind === "cleared";
                      const isBusy = busyKey.endsWith(`:${participant.id}`);

                      return (
                        <article
                          key={participant.id}
                          data-participant-id={participant.id}
                          data-testid="compact-participant-row"
                          onDragOver={(event) => {
                            if (draggingParticipantId) {
                              event.preventDefault();
                              event.dataTransfer.dropEffect = "move";
                            }
                          }}
                          onDrop={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            const participantId =
                              event.dataTransfer.getData("text/plain") ||
                              draggingParticipantId;
                            const targetBounds =
                              event.currentTarget.getBoundingClientRect();
                            reorderParticipant(
                              participantId,
                              participant.id,
                              event.clientY >=
                                targetBounds.top + targetBounds.height / 2
                                ? "after"
                                : "before",
                            );
                            setDraggingParticipantId("");
                          }}
                          className={`flex h-12 min-w-0 items-center justify-between gap-1.5 border-b border-zinc-800 px-2 py-1 last:border-b-0 ${
                            draggingParticipantId === participant.id
                              ? "bg-zinc-900 opacity-70"
                              : "bg-zinc-950 hover:bg-zinc-900/40"
                          } transition-colors`}
                        >
                          <button
                            type="button"
                            draggable
                            aria-label={`Reorder ${participant.fullName}.`}
                            title={`Reorder ${participant.fullName}`}
                            onClick={(event) => event.stopPropagation()}
                            onPointerDown={(event) => {
                              event.stopPropagation();

                              if (event.pointerType === "mouse") {
                                return;
                              }

                              touchReorderIdRef.current = participant.id;
                              setDraggingParticipantId(participant.id);
                              event.currentTarget.setPointerCapture(
                                event.pointerId,
                              );
                            }}
                            onPointerMove={handleTouchReorderMove}
                            onPointerUp={finishTouchReorder}
                            onPointerCancel={finishTouchReorder}
                            onDragStart={(
                              event: DragEvent<HTMLButtonElement>,
                            ) => {
                              event.stopPropagation();
                              event.dataTransfer.effectAllowed = "move";
                              event.dataTransfer.setData(
                                "text/plain",
                                participant.id,
                              );
                              setDraggingParticipantId(participant.id);
                            }}
                            onDragEnd={() => setDraggingParticipantId("")}
                            onKeyDown={(
                              event: ReactKeyboardEvent<HTMLButtonElement>,
                            ) => {
                              if (
                                event.key !== "ArrowUp" &&
                                event.key !== "ArrowDown"
                              ) {
                                return;
                              }

                              event.preventDefault();
                              event.stopPropagation();
                              moveParticipantByOffset(
                                participant.id,
                                event.key === "ArrowUp" ? -1 : 1,
                              );
                            }}
                            className="flex h-8 w-6 shrink-0 touch-none cursor-grab select-none items-center justify-center text-xs font-black tracking-[-0.2em] text-zinc-600 outline-none active:cursor-grabbing hover:text-white"
                          >
                            ⋮⋮
                          </button>
                          <button
                            type="button"
                            onClick={() => handleOpenEditModal(participant)}
                            className="flex min-w-0 flex-1 flex-col text-left outline-none"
                            aria-label={`Edit ${participant.fullName}`}
                          >
                            <span className="block truncate text-xs font-black text-white leading-tight">
                              {participant.fullName}
                            </span>
                            <span className="block truncate text-[10px] font-bold tabular-nums text-zinc-400">
                              {participant.phoneNumber || "No contact"}
                            </span>
                          </button>

                          <div className="flex shrink-0 items-center gap-1.5">
                            <span
                              className={`rounded-full px-1.5 py-0.5 text-[8px] font-black whitespace-nowrap border ${
                                (participant.paymentMethod || "")
                                  .toLowerCase()
                                  .includes("instapay") ||
                                (participant.paymentMethod || "")
                                  .toLowerCase()
                                  .includes("vodafone") ||
                                (participant.paymentMethod || "")
                                  .toLowerCase()
                                  .includes("digital")
                                  ? "border-sky-800/50 bg-sky-950/80 text-sky-300"
                                  : "border-emerald-800/50 bg-emerald-950/80 text-emerald-300"
                              }`}
                            >
                              {(participant.paymentMethod || "")
                                .toLowerCase()
                                .includes("instapay") ||
                              (participant.paymentMethod || "")
                                .toLowerCase()
                                .includes("vodafone") ||
                              (participant.paymentMethod || "")
                                .toLowerCase()
                                .includes("digital")
                                ? "📱 InstaPay"
                                : "💵 Cash"}
                            </span>

                            <span
                              className={`rounded-full px-2 py-0.5 text-[9px] font-black whitespace-nowrap ${
                                (Number(participant.changeOwed) || 0) > 0
                                  ? "bg-rose-950/90 text-rose-300 border border-rose-800/50"
                                  : isCleared
                                    ? "bg-emerald-950/90 text-emerald-300 border border-emerald-800/50"
                                    : state.kind === "free"
                                      ? "bg-sky-950/90 text-sky-300 border border-sky-800/50"
                                      : state.kind === "deposit"
                                        ? "bg-amber-950/90 text-amber-200 border border-amber-800/50"
                                        : state.remaining > 0
                                          ? "bg-rose-950/90 text-rose-300 border border-rose-800/50"
                                          : "bg-zinc-900 text-zinc-400 border border-white/10"
                              }`}
                            >
                              {(Number(participant.changeOwed) || 0) > 0
                                ? `🔴 Change: ${participant.changeOwed} EGP`
                                : isCleared
                                  ? "🟢 Cleared"
                                  : state.kind === "free"
                                    ? "🎁 Free"
                                    : state.remaining > 0
                                      ? `🟡 Owed ${formatCompactMoney(state.remaining)}`
                                      : "⚪ Unpaid"}
                            </span>


                            <button
                              type="button"
                              disabled={
                                isSelectedEventArchived ||
                                isCleared ||
                                state.kind === "free" ||
                                isAnyBusy
                              }
                              onClick={(event) => {
                                event.stopPropagation();
                                void clearParticipant(participant);
                              }}
                              className={`h-8 min-w-12 shrink-0 rounded-lg px-2 text-[10px] font-black active:scale-95 transition-all ${
                                isCleared
                                  ? "border border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                                  : "bg-emerald-400 text-black hover:bg-emerald-300 shadow-md"
                              } disabled:opacity-50`}
                            >
                              {isBusy ? "…" : isCleared ? "✓" : "Clear"}
                            </button>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                )}

              </>
            ) : null}
          </>
        )}

        <footer className="py-3 text-center text-[9px] font-black uppercase tracking-[0.16em] text-zinc-700">
          GlowRunners Post-Run Control · Organiser Only
        </footer>
      </div>

      {eventModal ? (
        <ModalShell
          title={eventModal === "create" ? "Create event" : "Edit event settings"}
          onClose={closeEventModal}
        >
          <form onSubmit={eventModal === "create" ? createEvent : editEvent}>
            <EventFormFields
              form={eventForm}
              onChange={setEventForm}
              isBusy={isAnyBusy}
              canOverrideRunDate={
                eventModal === "edit" || Boolean(isSuperAdmin)
              }
              runDateMessage={
                eventModal !== "create"
                  ? undefined
                  : isLoadingRunDate
                    ? "Reading the newest Attendance tab…"
                    : activeRunDateError
                      ? activeRunDateError
                      : activeRunSheetName
                        ? `Synced from “${activeRunSheetName}”. ${
                            isSuperAdmin
                              ? "You can override this date if needed."
                              : "Only a Super Admin can override it."
                          }`
                        : undefined
              }
              runDateMessageIsError={Boolean(activeRunDateError)}
              submitDisabled={
                eventModal === "create" &&
                !isSuperAdmin &&
                (isLoadingRunDate || !eventForm.runDate)
              }
              submitLabel={
                busyKey === "create-event"
                  ? "Creating…"
                  : busyKey === "edit-event"
                    ? "Saving…"
                    : eventModal === "create"
                      ? "Create event"
                      : "Save event settings"
              }
            />
          </form>
        </ModalShell>
      ) : null}

      {deleteEventCandidate ? (
        <ModalShell
          title="Permanently Delete Event?"
          onClose={() => {
            if (busyKey !== "delete-event") {
              setDeleteEventCandidate(null);
            }
          }}
        >
          <div className="mt-4 flex min-w-0 flex-col gap-4">
            <p className="text-sm font-semibold leading-6 text-zinc-300">
              Are you sure you want to delete{" "}
              <strong className="text-white">
                &quot;{deleteEventCandidate.title}&quot;
              </strong>
              ? This will permanently remove the event and all associated
              participant records. This action cannot be undone.
            </p>
            <div className="grid min-w-0 grid-cols-2 gap-2">
              <button
                type="button"
                data-modal-autofocus
                disabled={busyKey === "delete-event"}
                onClick={() => setDeleteEventCandidate(null)}
                className="min-h-12 min-w-0 rounded-xl border border-zinc-700 px-3 text-sm font-black disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busyKey === "delete-event"}
                onClick={() => void permanentlyDeleteEvent()}
                className="min-h-12 min-w-0 rounded-xl bg-red-600 px-3 text-sm font-black text-white disabled:opacity-50"
              >
                {busyKey === "delete-event"
                  ? "Deleting…"
                  : "🗑️ Confirm Delete"}
              </button>
            </div>
          </div>
        </ModalShell>
      ) : null}

      {duplicateContactWarning ? (
        <ModalShell
          title="Duplicate Contact Warning"
          onClose={() => setDuplicateContactWarning(null)}
        >
          <div className="mt-4 flex min-w-0 flex-col gap-4">
            <p className="break-words rounded-xl border border-amber-800 bg-amber-950/30 p-3 text-sm font-semibold leading-6 text-amber-100">
              ⚠️ Warning: The contact number{` `}
              <strong className="text-white">
                {formatDuplicateContact(
                  duplicateContactWarning.normalizedContact,
                )}
              </strong>{` `}
              is already registered under{` `}
              <strong className="text-white">
                {duplicateContactWarning.existingParticipant.fullName}
              </strong>
              . Do you want to add{` `}
              <strong className="text-white">
                {duplicateContactWarning.candidate.fullName}
              </strong>{` `}
              with the same contact number anyway?
            </p>
            <div className="grid min-w-0 grid-cols-2 gap-2">
              <button
                type="button"
                data-modal-autofocus
                disabled={busyKey === "add-participant"}
                onClick={() => setDuplicateContactWarning(null)}
                className="min-h-12 min-w-0 rounded-xl border border-zinc-700 px-3 text-sm font-black disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busyKey === "add-participant"}
                onClick={() => {
                  const warning = duplicateContactWarning;
                  setDuplicateContactWarning(null);
                  void handleAddParticipant({
                    candidate: warning.candidate,
                    force: true,
                  });
                }}
                className="min-h-12 min-w-0 rounded-xl bg-amber-400 px-3 text-sm font-black text-black disabled:opacity-50"
              >
                Add Anyway
              </button>
            </div>
          </div>
        </ModalShell>
      ) : null}

      {selectedParticipant && selectedEvent ? (
        <ModalShell
          title={`Edit Participant · ${selectedParticipant.fullName}`}
          onClose={() => setSelectedParticipantId("")}
        >
          {(() => {
            const state = paymentState(selectedParticipant, selectedEvent);
            const directWhatsappPhone = whatsappPhone(
              selectedParticipant.phoneNumber,
            );
            const depositRequest = `Hi ${selectedParticipant.fullName}! You are registered for ${selectedEvent.title} on ${formatEventDate(
              selectedEvent.runDate,
            )}. Total cost: ${formatMoney(
              selectedEvent.totalCost,
            )}. Required deposit: ${formatMoney(
              selectedEvent.depositAmount,
            )}. Payment instructions: ${selectedEvent.paymentInstructions}`;
            const balanceNotice = `Hi ${selectedParticipant.fullName}! We received ${formatMoney(
              state.amountPaid,
            )} for ${selectedEvent.title}. Your remaining balance due on Friday is ${formatMoney(
              state.remaining,
            )}.`;
            const finalReceipt = `Hi ${selectedParticipant.fullName}! Your payment for ${selectedEvent.title} is fully cleared. Total received: ${formatMoney(
              state.amountPaid,
            )}. Remaining balance: 0 EGP. Thank you from GlowRunners!`;

            return (
              <div className="mt-3 flex min-w-0 flex-col gap-3">
                <div className="grid min-w-0 grid-cols-3 gap-2 rounded-xl border border-zinc-800 bg-black p-2">
                  <div className="min-w-0">
                    <p className="text-[9px] font-black uppercase text-zinc-500">
                      Status
                    </p>
                    <p className="mt-1 truncate text-[10px] font-black">
                      {state.longLabel}
                    </p>
                  </div>
                  <div className="min-w-0">
                    <p className="text-[9px] font-black uppercase text-zinc-500">
                      Paid
                    </p>
                    <p className="mt-1 truncate text-[10px] font-black text-emerald-300">
                      {formatMoney(state.amountPaid)}
                    </p>
                  </div>
                  <div className="min-w-0">
                    <p className="text-[9px] font-black uppercase text-zinc-500">
                      Owed
                    </p>
                    <p className="mt-1 truncate text-[10px] font-black text-amber-300">
                      {formatMoney(state.remaining)}
                    </p>
                  </div>
                </div>

                <p className="min-w-0 truncate rounded-lg border border-zinc-800 bg-black px-3 py-2 text-xs font-bold text-zinc-400">
                  Contact: {selectedParticipant.phoneNumber || "Not provided"}
                </p>

                {!isSelectedEventArchived ? (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      const draftedAmount = Number(paymentDraft);
                      const amountPaid =
                        paymentStatusDraft === "FREE" ||
                        paymentStatusDraft === "UNPAID"
                          ? 0
                          : paymentStatusDraft === "FULLY_CLEARED"
                            ? Number(selectedEvent.eventTicketPrice) || 0
                            : draftedAmount;

                      if (!Number.isFinite(amountPaid) || amountPaid < 0) {
                        setNotice({
                          tone: "error",
                          message: "Amount paid must be a non-negative number.",
                        });
                        return;
                      }

                      // 1. Close modal immediately for smooth UI
                      setSelectedParticipantId("");

                      // 2. Perform optimistic update and sync
                      void updateParticipant(
                        selectedParticipant,
                        {
                          fullName: participantNameDraft,
                          phoneNumber: participantContactDraft,
                          amountPaid,
                          paymentStatus: paymentStatusDraft,
                          paymentMethod: paymentMethodDraft,
                        },
                        "edit",
                      ).then((updated) => {
                        if (updated) {
                          setParticipantNameDraft(updated.fullName);
                          setParticipantContactDraft(updated.phoneNumber);
                          setPaymentDraft(String(updated.amountPaid));
                          setPaymentStatusDraft(updated.paymentStatus);
                          setPaymentMethodDraft(updated.paymentMethod || "Cash");
                          if (selectedEvent) {
                            void loadParticipants(selectedEvent.id);
                          }
                        }
                      });
                    }}
                    className="flex min-w-0 flex-col gap-3 rounded-xl border border-zinc-800 bg-black p-3"
                  >
                  <label className="text-[10px] font-black uppercase tracking-wide text-zinc-400">
                    Name
                    <input
                      type="text"
                      required
                      maxLength={120}
                      autoComplete="name"
                      value={participantNameDraft}
                      onChange={(event) =>
                        setParticipantNameDraft(event.target.value)
                      }
                      className="mt-1.5 min-h-12 w-full min-w-0 rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-base font-black normal-case tracking-normal text-white outline-none focus:border-sky-400"
                    />
                  </label>
                  <label className="text-[10px] font-black uppercase tracking-wide text-zinc-400">
                    WhatsApp phone or @username
                    <input
                      type="text"
                      maxLength={80}
                      autoComplete="off"
                      value={participantContactDraft}
                      onChange={(event) =>
                        setParticipantContactDraft(event.target.value)
                      }
                      className="mt-1.5 min-h-12 w-full min-w-0 rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-base font-black normal-case tracking-normal text-white outline-none focus:border-sky-400"
                    />
                  </label>
                  <label className="text-[10px] font-black uppercase tracking-wide text-zinc-400">
                    Payment method
                    <select
                      value={paymentMethodDraft}
                      onChange={(event) => setPaymentMethodDraft(event.target.value)}
                      className="mt-1.5 min-h-12 w-full min-w-0 rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-base font-black normal-case tracking-normal text-white outline-none focus:border-sky-400"
                    >
                      <option value="Cash">💵 Cash</option>
                      <option value="InstaPay">📱 InstaPay / Vodafone Cash</option>
                    </select>
                  </label>
                  <label className="text-[10px] font-black uppercase tracking-wide text-zinc-400">
                    Payment status
                    <select
                      value={paymentStatusDraft}
                      onChange={(event) => {
                        const status = event.target.value as PaymentStatus;
                        setPaymentStatusDraft(status);
                        if (status === "FREE" || status === "UNPAID") {
                          setPaymentDraft("0");
                        } else if (status === "FULLY_CLEARED") {
                          setPaymentDraft(
                            String(Number(selectedEvent.eventTicketPrice) || 0),
                          );
                        }
                      }}
                      className="mt-1.5 min-h-12 w-full min-w-0 rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-base font-black normal-case tracking-normal text-white outline-none focus:border-sky-400"
                    >
                      <option value="UNPAID">Unpaid</option>
                      <option value="DEPOSIT_PAID">Deposit Paid</option>
                      <option value="FULLY_CLEARED">Cleared</option>
                      <option value="FREE">🎁 Free</option>
                    </select>
                  </label>
                  <label className="text-[10px] font-black uppercase tracking-wide text-zinc-400">
                    Exact amount paid (EGP)
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      inputMode="decimal"
                      required
                      disabled={paymentStatusDraft !== "DEPOSIT_PAID"}
                      value={paymentDraft}
                      onChange={(event) => setPaymentDraft(event.target.value)}
                      className="mt-1.5 min-h-12 w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-base font-black outline-none focus:border-emerald-400"
                    />
                  </label>

                  {paymentStatusDraft !== "FREE" ? (
                    <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                      <p className="text-[10px] font-black uppercase tracking-wide text-zinc-400">
                        ON-SITE CASH RECEIVED (EGP)
                      </p>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        placeholder="0"
                        value={amountReceivedDraft}
                        onChange={(event) =>
                          setAmountReceivedDraft(event.target.value)
                        }
                        className="mt-1.5 min-h-12 w-full min-w-0 rounded-xl border border-zinc-700 bg-black px-4 text-base font-black text-white outline-none focus:border-emerald-400"
                      />
                      {(() => {
                        const currentPendingChange =
                          Number(selectedParticipant.changeOwed) || 0;
                        const received = Number(amountReceivedDraft) || 0;
                        const targetOwed = state.remaining;
                        const change =
                          received > 0 && targetOwed > 0 && received > targetOwed
                            ? received - targetOwed
                            : 0;

                        if (currentPendingChange > 0 && received === 0) {
                          return (
                            <div className="mt-2 rounded-lg border border-rose-500/40 bg-rose-500/15 p-2 text-center">
                              <p className="text-[9px] font-black uppercase tracking-wide text-rose-400">
                                🔴 Change Pending Handover
                              </p>
                              <p className="mt-0.5 text-sm font-black text-rose-300">
                                {currentPendingChange} EGP Owed to Runner
                              </p>
                            </div>
                          );
                        }

                        if (received > 0 && change > 0) {
                          return (
                            <div className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/15 p-2 text-center">
                              <p className="text-[9px] font-black uppercase tracking-wide text-amber-400">
                                💵 Change to Return
                              </p>
                              <p className="mt-0.5 text-sm font-black text-amber-300">
                                Give {change} EGP change to runner
                              </p>
                            </div>
                          );
                        }

                        return null;
                      })()}
                    </div>
                  ) : null}

                  {(() => {
                    const currentPendingChange =
                      Number(selectedParticipant.changeOwed) || 0;
                    const received = Number(amountReceivedDraft) || 0;
                    const targetOwed = state.remaining;
                    const change =
                      received > 0 && targetOwed > 0 && received > targetOwed
                        ? received - targetOwed
                        : 0;

                    return (
                      <div className="mt-2 flex flex-col gap-2">
                        {currentPendingChange > 0 ? (
                          <button
                            type="button"
                            disabled={isAnyBusy}
                            onClick={() => {
                              setSelectedParticipantId("");
                              void updateParticipant(
                                selectedParticipant,
                                {
                                  changeOwed: 0,
                                  paymentStatus: "FULLY_CLEARED",
                                },
                                "clear",
                              );
                            }}
                            className="min-h-12 w-full rounded-xl bg-gradient-to-r from-emerald-500 to-green-600 px-3 text-xs font-black text-white shadow-lg active:scale-95 transition-all"
                          >
                            💵 Mark {currentPendingChange} EGP Returned &amp; Clear
                          </button>
                        ) : null}

                        {change > 0 ? (
                          <button
                            type="button"
                            disabled={isAnyBusy}
                            onClick={() => {
                              setSelectedParticipantId("");
                              void updateParticipant(
                                selectedParticipant,
                                {
                                  fullName: participantNameDraft,
                                  phoneNumber: participantContactDraft,
                                  amountPaid:
                                    Number(selectedEvent.eventTicketPrice) ||
                                    selectedParticipant.amountPaid +
                                      state.remaining,
                                  paymentStatus: "FULLY_CLEARED",
                                  paymentMethod: paymentMethodDraft,
                                  changeOwed: change,
                                },
                                "edit",
                              );
                            }}
                            className="min-h-12 w-full rounded-xl bg-gradient-to-r from-amber-500 to-orange-600 px-3 text-xs font-black text-white shadow-lg active:scale-95 transition-all"
                          >
                            📥 Save &amp; Hold {change} EGP Change Owed
                          </button>
                        ) : (
                          <div className="grid min-w-0 grid-cols-2 gap-2">
                            <button
                              type="submit"
                              disabled={isAnyBusy}
                              className="min-h-12 rounded-xl bg-white px-3 text-xs font-black text-black disabled:opacity-50 active:scale-95 transition-all"
                            >
                              {busyKey === `edit:${selectedParticipant.id}`
                                ? "Saving…"
                                : "Save Participant"}
                            </button>
                            <button
                              type="button"
                              disabled={state.kind === "cleared" || isAnyBusy}
                              onClick={() => {
                                setSelectedParticipantId("");
                                void clearParticipant(
                                  selectedParticipant,
                                  paymentMethodDraft,
                                );
                              }}
                              className="min-h-12 rounded-xl bg-emerald-400 px-3 text-xs font-black text-black disabled:bg-emerald-950 disabled:text-emerald-400 active:scale-95 transition-all"
                            >
                              {state.kind === "cleared"
                                ? "✓ Fully Cleared"
                                : "Clear Full Balance"}
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })()}
                  </form>
                ) : null}


                <div className="mt-3 flex flex-col gap-2">
                  <p className="text-[10px] font-black tracking-[0.12em] text-zinc-400">
                    PAYMENT PROOF (INSTAPAY / VODAFONE CASH / SCREENSHOT)
                  </p>

                  {selectedParticipant.paymentProofUrl ? (
                    <div className="flex items-center gap-3 rounded-xl border border-fuchsia-800/40 bg-fuchsia-950/20 p-2.5">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={selectedParticipant.paymentProofUrl}
                        alt="Payment proof thumbnail"
                        className="h-12 w-12 rounded-lg border border-fuchsia-700/50 object-cover"
                      />

                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-black text-fuchsia-200">
                          Payment Proof Attached
                        </p>
                        <button
                          type="button"
                          onClick={() =>
                            setLightboxUrl(selectedParticipant.paymentProofUrl)
                          }
                          className="mt-0.5 text-[11px] font-bold text-fuchsia-400 underline hover:text-fuchsia-300"
                        >
                          View Full Screenshot
                        </button>
                      </div>
                    </div>
                  ) : null}

                  {isSelectedEventArchived ? (
                    <div className="flex min-h-11 min-w-0 items-center justify-center rounded-xl border border-zinc-800 px-3 text-center text-xs font-black text-zinc-500">
                      Read-only proof (Archived)
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-2">
                      <label className="flex min-h-11 cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-pink-500/40 bg-pink-500/10 px-3 text-center text-xs font-black text-pink-300 hover:bg-pink-500/20 active:scale-95 transition-all">
                        <span>📷</span>
                        <span>
                          {busyKey === `proof:${selectedParticipant.id}`
                            ? "Saving…"
                            : "Snap Live Photo"}
                        </span>
                        <input
                          type="file"
                          accept="image/*"
                          capture="environment"
                          id="liveCameraInput"
                          className="sr-only"
                          disabled={isAnyBusy}
                          onChange={(event) =>
                            void uploadProof(selectedParticipant, event)
                          }
                        />
                      </label>

                      <label className="flex min-h-11 cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-white/15 bg-white/5 px-3 text-center text-xs font-black text-zinc-300 hover:bg-white/10 active:scale-95 transition-all">
                        <span>📁</span>
                        <span>
                          {busyKey === `proof:${selectedParticipant.id}`
                            ? "Saving…"
                            : "From Gallery"}
                        </span>
                        <input
                          type="file"
                          accept="image/jpeg,image/png,image/webp,image/*"
                          id="galleryProofInput"
                          className="sr-only"
                          disabled={isAnyBusy}
                          onChange={(event) =>
                            void uploadProof(selectedParticipant, event)
                          }
                        />
                      </label>
                    </div>
                  )}
                </div>


                {directWhatsappPhone ? (
                  <div className="grid min-w-0 grid-cols-3 gap-2">
                  <a
                    href={whatsappLink(
                      directWhatsappPhone,
                      depositRequest,
                    )}
                    target="_blank"
                    rel="noreferrer"
                    className="flex min-h-12 min-w-0 items-center justify-center rounded-xl border border-zinc-700 px-2 text-center text-[10px] font-black"
                  >
                    Deposit Request
                  </a>
                  <a
                    href={whatsappLink(
                      directWhatsappPhone,
                      balanceNotice,
                    )}
                    target="_blank"
                    rel="noreferrer"
                    className="flex min-h-12 min-w-0 items-center justify-center rounded-xl border border-amber-800 px-2 text-center text-[10px] font-black text-amber-200"
                  >
                    Balance Notice
                  </a>
                  <a
                    href={whatsappLink(
                      directWhatsappPhone,
                      finalReceipt,
                    )}
                    target="_blank"
                    rel="noreferrer"
                    aria-disabled={state.kind !== "cleared"}
                    onClick={(event) => {
                      if (state.kind !== "cleared") {
                        event.preventDefault();
                      }
                    }}
                    className={`flex min-h-12 min-w-0 items-center justify-center rounded-xl border px-2 text-center text-[10px] font-black ${
                      state.kind === "cleared"
                        ? "border-emerald-800 text-emerald-300"
                        : "border-zinc-800 text-zinc-600"
                    }`}
                  >
                    Final Receipt
                  </a>
                  </div>
                ) : (
                  <p className="rounded-xl border border-zinc-800 px-3 py-3 text-center text-xs font-bold text-zinc-500">
                    Direct WhatsApp messages require a phone number.
                  </p>
                )}

                {!isSelectedEventArchived ? (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void updateParticipant(
                        selectedParticipant,
                        { internalNotes: notesDraft },
                        "notes",
                      );
                    }}
                    className="rounded-xl border border-zinc-800 bg-black p-3"
                  >
                  <label className="text-[10px] font-black uppercase tracking-wide text-zinc-400">
                    Internal admin notes
                    <textarea
                      maxLength={2000}
                      rows={3}
                      value={notesDraft}
                      onChange={(event) => setNotesDraft(event.target.value)}
                      placeholder="Private organiser note…"
                      className="mt-1.5 w-full resize-y rounded-xl border border-zinc-700 bg-zinc-950 p-3 text-base font-bold normal-case tracking-normal outline-none focus:border-fuchsia-400"
                    />
                  </label>
                  <button
                    type="submit"
                    disabled={isAnyBusy}
                    className="mt-2 min-h-11 w-full rounded-xl border border-zinc-700 text-xs font-black disabled:opacity-50"
                  >
                    {busyKey === `notes:${selectedParticipant.id}`
                      ? "Saving…"
                      : "Save Internal Note"}
                  </button>
                  </form>
                ) : selectedParticipant.internalNotes ? (
                  <div className="rounded-xl border border-zinc-800 bg-black p-3">
                    <p className="text-[10px] font-black uppercase tracking-wide text-zinc-500">
                      Internal admin notes
                    </p>
                    <p className="mt-2 whitespace-pre-wrap text-sm font-semibold text-zinc-300">
                      {selectedParticipant.internalNotes}
                    </p>
                  </div>
                ) : null}

                {isSuperAdmin && !isSelectedEventArchived ? (
                  <button
                    type="button"
                    disabled={isAnyBusy}
                    onClick={() =>
                      void deleteParticipant(selectedParticipant)
                    }
                    className="min-h-12 w-full rounded-xl border border-red-800 bg-red-950/30 px-4 text-sm font-black text-red-300 disabled:opacity-50"
                  >
                    {busyKey === `delete:${selectedParticipant.id}`
                      ? "Deleting…"
                      : "🗑️ Delete Participant"}
                  </button>
                ) : null}
              </div>
            );
          })()}
        </ModalShell>
      ) : null}

      {lightboxUrl ? (
        <ModalShell
          title="Payment proof screenshot"
          onClose={() => setLightboxUrl("")}
          layer="lightbox"
        >
          <div className="relative mt-3 h-[72svh] overflow-hidden rounded-xl border border-zinc-700 bg-black">
            <Image
              src={lightboxUrl}
              alt="Uploaded payment proof"
              fill
              unoptimized
              sizes="(max-width: 448px) 100vw, 448px"
              className="object-contain"
            />
          </div>
        </ModalShell>
      ) : null}
    </main>
  );
}
