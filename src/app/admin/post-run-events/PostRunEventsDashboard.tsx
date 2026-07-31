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
  type FormEvent,
  type ReactNode,
} from "react";

type DepositStatus = "PENDING" | "VERIFIED";
type SettlementStatus = "UNPAID" | "FULLY_CLEARED";
type PaymentFilter = "all" | "unpaid" | "deposit" | "cleared";
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
}>;

type Participant = Readonly<{
  id: string;
  eventId: string;
  fullName: string;
  phoneNumber: string;
  depositStatus: DepositStatus;
  depositPaid: number;
  amountPaid: number;
  paymentProofUrl: string;
  remainingBalance: number;
  settlementStatus: SettlementStatus;
  updatedByAdmin: string;
  internalNotes: string;
  createdAt: string;
  updatedAt: string;
}>;

type ParticipantPatch = Readonly<{
  amountPaid?: number;
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

const EMPTY_EVENT_FORM: EventFormState = {
  title: "",
  runDate: "",
  totalCost: "",
  depositAmount: "",
  capacity: "",
  paymentInstructions: "",
};

const EMPTY_PARTICIPANT_FORM = {
  fullName: "",
  phoneNumber: "",
};

const SESSION_STORAGE_KEY = "glowrunners.admin.identity.v1";

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

function formatEventDate(value: string) {
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : DATE_FORMATTER.format(date);
}

function whatsappPhone(value: string) {
  const digits = value.replace(/\D/g, "");
  const withoutCountryCode = digits.replace(/^20/, "").replace(/^0+/, "");
  return withoutCountryCode ? `20${withoutCountryCode}` : "";
}

function whatsappLink(phone: string, message: string) {
  return `https://wa.me/${whatsappPhone(phone)}?text=${encodeURIComponent(message)}`;
}

function paymentState(participant: Participant, event: PostRunEvent) {
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
  const response = await fetch(input, {
    cache: "no-store",
    credentials: "same-origin",
    ...init,
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
}: {
  form: EventFormState;
  onChange: (next: EventFormState) => void;
  submitLabel: string;
  isBusy: boolean;
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
          value={form.runDate}
          onChange={(event) =>
            onChange({ ...form, runDate: event.target.value })
          }
          className="mt-1.5 min-h-12 w-full min-w-0 rounded-xl border border-zinc-700 bg-black px-3 text-base font-bold normal-case tracking-normal text-white outline-none focus:border-fuchsia-400"
        />
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
        disabled={isBusy}
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
  const [selectedEventId, setSelectedEventId] = useState("");
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [eventModal, setEventModal] = useState<EventModal>(null);
  const [eventForm, setEventForm] =
    useState<EventFormState>(EMPTY_EVENT_FORM);
  const [participantForm, setParticipantForm] = useState(
    EMPTY_PARTICIPANT_FORM,
  );
  const [selectedParticipantId, setSelectedParticipantId] = useState("");
  const [paymentDraft, setPaymentDraft] = useState("");
  const [notesDraft, setNotesDraft] = useState("");
  const [paymentFilter, setPaymentFilter] =
    useState<PaymentFilter>("all");
  const [search, setSearch] = useState("");
  const [lightboxUrl, setLightboxUrl] = useState("");
  const [busyKey, setBusyKey] = useState("");
  const [isLoadingEvents, setIsLoadingEvents] = useState(true);
  const [isLoadingParticipants, setIsLoadingParticipants] = useState(false);
  const [notice, setNotice] = useState<{
    tone: "success" | "error" | "idle";
    message: string;
  }>({ tone: "idle", message: "" });
  const participantsRequestIdRef = useRef(0);
  const activeOperationRef = useRef(false);

  const selectedEvent =
    events.find((event) => event.id === selectedEventId) ?? null;
  const selectedParticipant =
    participants.find(
      (participant) => participant.id === selectedParticipantId,
    ) ?? null;
  const isSuperAdmin = admin?.role === "super-admin";
  const isAnyBusy = busyKey.length > 0;

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

  const loadEvents = useCallback(async () => {
    setIsLoadingEvents(true);

    try {
      const { response, payload } = await apiRequest("/api/events");

      if (
        !response.ok ||
        !isObject(payload) ||
        !Array.isArray(payload.events)
      ) {
        throw new Error(readError(payload, "Events could not be loaded."));
      }

      const nextEvents = payload.events as PostRunEvent[];
      setEvents(nextEvents);
      setSelectedEventId((current) =>
        nextEvents.some((event) => event.id === current)
          ? current
          : (nextEvents[0]?.id ?? ""),
      );
    } finally {
      setIsLoadingEvents(false);
    }
  }, []);

  const loadParticipants = useCallback(async (eventId: string) => {
    const requestId = participantsRequestIdRef.current + 1;
    participantsRequestIdRef.current = requestId;
    setParticipants([]);

    if (!eventId) {
      setIsLoadingParticipants(false);
      return;
    }

    setIsLoadingParticipants(true);

    try {
      const { response, payload } = await apiRequest(
        `/api/events/${encodeURIComponent(eventId)}/participants`,
      );

      if (
        !response.ok ||
        !isObject(payload) ||
        !Array.isArray(payload.participants)
      ) {
        throw new Error(readError(payload, "Participants could not be loaded."));
      }

      if (participantsRequestIdRef.current === requestId) {
        setParticipants(payload.participants as Participant[]);
      }
    } catch (error) {
      if (participantsRequestIdRef.current === requestId) {
        setNotice({
          tone: "error",
          message:
            error instanceof Error
              ? error.message
              : "Participants could not be loaded.",
        });
      }
    } finally {
      if (participantsRequestIdRef.current === requestId) {
        setIsLoadingParticipants(false);
      }
    }
  }, []);

  useEffect(() => {
    void Promise.all([loadSession(), loadEvents()]).catch((error: unknown) => {
      setNotice({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "The event manager could not be loaded.",
      });
    });
  }, [loadEvents, loadSession]);

  useEffect(() => {
    setSelectedParticipantId("");
    setSearch("");
    setPaymentFilter("all");
    void loadParticipants(selectedEventId);
  }, [loadParticipants, selectedEventId]);

  const totals = useMemo(() => {
    if (!selectedEvent) {
      return { expected: 0, collected: 0, remaining: 0 };
    }

    const expected = selectedEvent.totalCost * participants.length;
    const collected = participants.reduce(
      (sum, participant) =>
        sum +
        (Number.isFinite(participant.amountPaid)
          ? Math.max(0, participant.amountPaid)
          : 0),
      0,
    );

    return {
      expected,
      collected,
      remaining: expected - collected,
    };
  }, [participants, selectedEvent]);

  const visibleParticipants = useMemo(() => {
    if (!selectedEvent) {
      return [];
    }

    const normalizedSearch = search.trim().toLocaleLowerCase("en-US");

    return participants.filter((participant) => {
      const state = paymentState(participant, selectedEvent);
      const matchesFilter =
        paymentFilter === "all" || state.kind === paymentFilter;
      const matchesSearch =
        !normalizedSearch ||
        `${participant.fullName} ${participant.phoneNumber}`
          .toLocaleLowerCase("en-US")
          .includes(normalizedSearch);
      return matchesFilter && matchesSearch;
    });
  }, [participants, paymentFilter, search, selectedEvent]);

  const openCreateEvent = () => {
    setEventForm(EMPTY_EVENT_FORM);
    setEventModal("create");
  };

  const openEditEvent = () => {
    if (!selectedEvent || !isSuperAdmin) {
      return;
    }

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

  const createEvent = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (activeOperationRef.current || isLoadingEvents) {
      return;
    }

    activeOperationRef.current = true;
    setBusyKey("create-event");

    try {
      const { response, payload } = await apiRequest("/api/events", {
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
      setEventModal(null);
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
      setEventModal(null);
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

  const archiveEvent = async () => {
    if (
      !selectedEvent ||
      !isSuperAdmin ||
      activeOperationRef.current ||
      !window.confirm(
        `Archive "${selectedEvent.title}"? It will leave the active event list but remain in the audit ledger.`,
      )
    ) {
      return;
    }

    activeOperationRef.current = true;
    setBusyKey("archive-event");

    try {
      const { response, payload } = await apiRequest(
        `/api/events/${encodeURIComponent(selectedEvent.id)}`,
        { method: "DELETE" },
      );

      if (!response.ok) {
        throw new Error(readError(payload, "The event could not be archived."));
      }

      const remainingEvents = events.filter(
        (candidate) => candidate.id !== selectedEvent.id,
      );
      setEvents(remainingEvents);
      setSelectedEventId(remainingEvents[0]?.id ?? "");
      setNotice({
        tone: "success",
        message: `${selectedEvent.title} was archived.`,
      });
    } catch (error) {
      setNotice({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "The event could not be archived.",
      });
    } finally {
      activeOperationRef.current = false;
      setBusyKey("");
    }
  };

  const addParticipant = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (
      !selectedEvent ||
      isLoadingParticipants ||
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
          body: JSON.stringify(participantForm),
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
      setParticipants((current) => [created, ...current]);
      setParticipantForm(EMPTY_PARTICIPANT_FORM);
      setNotice({
        tone: "success",
        message: `${created.fullName} was added.`,
      });
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

  const updateParticipant = useCallback(
    async (
      participant: Participant,
      patch: ParticipantPatch,
      action: string,
    ): Promise<Participant | null> => {
      if (!selectedEvent || activeOperationRef.current) {
        return null;
      }

      activeOperationRef.current = true;
      setBusyKey(`${action}:${participant.id}`);
      const previous = participant;
      const nextAmount = patch.amountPaid ?? participant.amountPaid;
      const optimisticState = paymentState(
        { ...participant, amountPaid: nextAmount },
        selectedEvent,
      );
      const optimistic: Participant = {
        ...participant,
        ...patch,
        amountPaid: nextAmount,
        depositPaid: nextAmount,
        remainingBalance: optimisticState.remaining,
        depositStatus:
          optimisticState.kind === "unpaid" ? "PENDING" : "VERIFIED",
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
          `/api/events/${encodeURIComponent(
            selectedEvent.id,
          )}/participants/${encodeURIComponent(participant.id)}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patch),
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

  const clearParticipant = async (participant: Participant) => {
    if (!selectedEvent) {
      return;
    }

    const updated = await updateParticipant(
      participant,
      { amountPaid: selectedEvent.totalCost },
      "clear",
    );

    if (updated && selectedParticipantId === updated.id) {
      setPaymentDraft(String(updated.amountPaid));
    }
  };

  const uploadProof = async (
    participant: Participant,
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file || activeOperationRef.current) {
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

  const openParticipant = (participant: Participant) => {
    setSelectedParticipantId(participant.id);
    setPaymentDraft(String(participant.amountPaid));
    setNotesDraft(participant.internalNotes ?? "");
  };

  const copySummary = async () => {
    if (!selectedEvent) {
      return;
    }

    const lines = participants.map((participant, index) => {
      const state = paymentState(participant, selectedEvent);
      return `${index + 1}. ${participant.fullName} · Paid ${formatMoney(
        state.amountPaid,
      )} · Owes ${formatMoney(state.remaining)} · ${state.longLabel}`;
    });
    const report = [
      `📊 GlowRunners Post-Run Report – ${selectedEvent.title}`,
      `📅 ${formatEventDate(selectedEvent.runDate)}`,
      `👥 Registered: ${participants.length}`,
      `💰 Expected Revenue: ${formatMoney(totals.expected)}`,
      `✅ Total Collected: ${formatMoney(totals.collected)}`,
      `🟡 Remaining Balance: ${formatMoney(totals.remaining)}`,
      "",
      ...lines,
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

        {isLoadingEvents ? (
          <section className="rounded-xl border border-zinc-800 bg-zinc-950 p-4 text-sm font-bold text-zinc-400">
            Loading events…
          </section>
        ) : events.length === 0 ? (
          <section className="rounded-2xl border border-dashed border-zinc-700 bg-zinc-950 p-6 text-center">
            <h2 className="text-lg font-black">No active events</h2>
            <p className="mt-2 text-sm font-semibold text-zinc-400">
              Create the next post-run activity and start its ledger.
            </p>
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
                <span className="sr-only">Active event</span>
                <select
                  value={selectedEventId}
                  disabled={isAnyBusy}
                  onChange={(event) => setSelectedEventId(event.target.value)}
                  className="min-h-11 w-full min-w-0 rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-sm font-black text-white outline-none focus:border-fuchsia-400"
                >
                  {events.map((event) => (
                    <option value={event.id} key={event.id}>
                      {event.title} · {formatEventDate(event.runDate)}
                    </option>
                  ))}
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
            </section>

            {selectedEvent ? (
              <>
                <section className="min-w-0 rounded-xl border border-fuchsia-900/70 bg-fuchsia-950/25 px-3 py-2">
                  <div className="flex min-w-0 items-center justify-between gap-2">
                    <div className="min-w-0">
                      <h2 className="truncate text-base font-black">
                        {selectedEvent.title}
                      </h2>
                      <p className="truncate text-[11px] font-bold text-fuchsia-200">
                        {formatEventDate(selectedEvent.runDate)} · Ticket{" "}
                        {formatMoney(selectedEvent.totalCost)} · Deposit{" "}
                        {formatMoney(selectedEvent.depositAmount)}
                      </p>
                    </div>
                    <span className="shrink-0 rounded-full bg-black/60 px-2 py-1 text-[10px] font-black">
                      {participants.length}/{selectedEvent.capacity ?? "∞"}
                    </span>
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
                      {isSuperAdmin ? "SUPER ADMIN" : "READ ONLY"}
                    </span>
                  </div>
                  <div className="grid min-w-0 grid-cols-3 gap-2">
                    <button
                      type="button"
                      onClick={openEditEvent}
                      disabled={!isSuperAdmin || isAnyBusy}
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
                      onClick={() => void archiveEvent()}
                      disabled={!isSuperAdmin || isAnyBusy}
                      className="min-h-11 min-w-0 rounded-lg border border-red-900 px-2 text-[10px] font-black text-red-300 disabled:text-zinc-600"
                    >
                      Archive
                    </button>
                  </div>
                </section>

                <details className="group min-w-0 rounded-xl border border-zinc-800 bg-zinc-950">
                  <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between px-3 text-xs font-black">
                    <span>+ ADD PARTICIPANT</span>
                    <span className="text-zinc-500 group-open:rotate-45">+</span>
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
                      disabled={isAnyBusy}
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
                      type="tel"
                      required
                      maxLength={24}
                      inputMode="tel"
                      autoComplete="tel"
                      disabled={isAnyBusy}
                      placeholder="WhatsApp phone"
                      value={participantForm.phoneNumber}
                      onChange={(event) =>
                        setParticipantForm((current) => ({
                          ...current,
                          phoneNumber: event.target.value,
                        }))
                      }
                      className="min-h-12 min-w-0 rounded-xl border border-zinc-700 bg-black px-3 text-base font-bold outline-none focus:border-fuchsia-400"
                    />
                    <button
                      type="submit"
                      disabled={
                        isAnyBusy ||
                        (selectedEvent.capacity !== null &&
                          participants.length >= selectedEvent.capacity)
                      }
                      className="min-h-12 rounded-xl bg-white px-3 text-sm font-black text-black disabled:opacity-50 sm:col-span-2"
                    >
                      {busyKey === "add-participant"
                        ? "Adding…"
                        : "Add participant"}
                    </button>
                  </form>
                </details>

                <section className="min-w-0">
                  <div
                    className="grid min-w-0 grid-cols-4 gap-1.5"
                    aria-label="Filter participants"
                  >
                    {(
                      [
                        ["all", "All"],
                        ["unpaid", "Unpaid (0 EGP)"],
                        ["deposit", "Deposit Paid"],
                        ["cleared", "Fully Cleared"],
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
                          data-testid="compact-participant-row"
                          className="grid h-[50px] min-w-0 grid-cols-[minmax(0,1fr)_72px] border-b border-zinc-800 bg-zinc-950 last:border-b-0"
                        >
                          <button
                            type="button"
                            onClick={() => openParticipant(participant)}
                            className="grid h-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-1.5 px-2 text-left outline-none focus:bg-zinc-900"
                            aria-label={`Open ${participant.fullName} payment details`}
                          >
                            <span className="min-w-0">
                              <span className="block truncate text-[11px] font-black leading-tight">
                                {participant.fullName}
                              </span>
                              <span className="block truncate text-[9px] font-bold tabular-nums text-zinc-500">
                                {participant.phoneNumber}
                              </span>
                            </span>
                            <span
                              className={`max-w-[118px] truncate rounded-full px-1.5 py-1 text-[8px] font-black ${
                                state.kind === "unpaid"
                                  ? "bg-red-950 text-red-300"
                                  : state.kind === "deposit"
                                    ? "bg-amber-950 text-amber-200"
                                    : "bg-emerald-950 text-emerald-300"
                              }`}
                            >
                              {state.label}
                            </span>
                          </button>
                          <div className="flex h-full min-w-0 flex-col items-stretch justify-center gap-0.5 border-l border-zinc-800 px-1">
                            <span className="truncate text-center text-[8px] font-black tabular-nums text-amber-300">
                              {isCleared
                                ? "0 owed"
                                : `${formatCompactMoney(state.remaining)} owed`}
                            </span>
                            <button
                              type="button"
                              disabled={isCleared || isAnyBusy}
                              onClick={() => void clearParticipant(participant)}
                            className="min-h-7 rounded-md bg-emerald-400 px-1 text-[9px] font-black text-black disabled:bg-emerald-950 disabled:text-emerald-400"
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
          onClose={() => setEventModal(null)}
        >
          <form onSubmit={eventModal === "create" ? createEvent : editEvent}>
            <EventFormFields
              form={eventForm}
              onChange={setEventForm}
              isBusy={isAnyBusy}
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

      {selectedParticipant && selectedEvent ? (
        <ModalShell
          title={selectedParticipant.fullName}
          onClose={() => setSelectedParticipantId("")}
        >
          {(() => {
            const state = paymentState(selectedParticipant, selectedEvent);
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

                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    const amountPaid = Number(paymentDraft);

                    if (!Number.isFinite(amountPaid) || amountPaid < 0) {
                      setNotice({
                        tone: "error",
                        message: "Amount paid must be a non-negative number.",
                      });
                      return;
                    }

                    void updateParticipant(
                      selectedParticipant,
                      { amountPaid },
                      "payment",
                    ).then((updated) => {
                      if (updated) {
                        setPaymentDraft(String(updated.amountPaid));
                      }
                    });
                  }}
                  className="rounded-xl border border-zinc-800 bg-black p-3"
                >
                  <label className="text-[10px] font-black uppercase tracking-wide text-zinc-400">
                    Exact amount paid (EGP)
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      inputMode="decimal"
                      required
                      value={paymentDraft}
                      onChange={(event) => setPaymentDraft(event.target.value)}
                      className="mt-1.5 min-h-12 w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-base font-black outline-none focus:border-emerald-400"
                    />
                  </label>
                  <div className="mt-2 grid min-w-0 grid-cols-2 gap-2">
                    <button
                      type="submit"
                      disabled={isAnyBusy}
                      className="min-h-12 rounded-xl bg-white px-3 text-xs font-black text-black disabled:opacity-50"
                    >
                      {busyKey === `payment:${selectedParticipant.id}`
                        ? "Updating…"
                        : "Update Payment"}
                    </button>
                    <button
                      type="button"
                      disabled={state.kind === "cleared" || isAnyBusy}
                      onClick={() =>
                        void clearParticipant(selectedParticipant)
                      }
                      className="min-h-12 rounded-xl bg-emerald-400 px-3 text-xs font-black text-black disabled:bg-emerald-950 disabled:text-emerald-400"
                    >
                      {state.kind === "cleared"
                        ? "✓ Fully Cleared"
                        : "Clear Full Balance"}
                    </button>
                  </div>
                </form>

                <div className="grid min-w-0 grid-cols-2 gap-2">
                  <label className="flex min-h-12 min-w-0 cursor-pointer items-center justify-center rounded-xl border border-zinc-700 px-3 text-center text-xs font-black">
                    {busyKey === `proof:${selectedParticipant.id}`
                      ? "Compressing…"
                      : selectedParticipant.paymentProofUrl
                        ? "Replace Proof"
                        : "Upload Proof"}
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      className="sr-only"
                      disabled={isAnyBusy}
                      onChange={(event) =>
                        void uploadProof(selectedParticipant, event)
                      }
                    />
                  </label>
                  <button
                    type="button"
                    disabled={!selectedParticipant.paymentProofUrl}
                    onClick={() =>
                      setLightboxUrl(selectedParticipant.paymentProofUrl)
                    }
                    className="min-h-12 min-w-0 rounded-xl border border-fuchsia-700 bg-fuchsia-950/40 px-3 text-xs font-black text-fuchsia-200 disabled:border-zinc-800 disabled:text-zinc-600"
                  >
                    {selectedParticipant.paymentProofUrl
                      ? "View Screenshot"
                      : "No Screenshot"}
                  </button>
                </div>

                <div className="grid min-w-0 grid-cols-3 gap-2">
                  <a
                    href={whatsappLink(
                      selectedParticipant.phoneNumber,
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
                      selectedParticipant.phoneNumber,
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
                      selectedParticipant.phoneNumber,
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

                {isSuperAdmin ? (
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
