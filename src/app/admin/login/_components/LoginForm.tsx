"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

type LoginFormProps = Readonly<{
  nextPath: string;
}>;

function readErrorMessage(payload: unknown): string | null {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload) ||
    !("error" in payload) ||
    typeof payload.error !== "string"
  ) {
    return null;
  }

  const message = payload.error.trim();
  return message.length > 0 && message.length <= 240 ? message : null;
}

export function LoginForm({ nextPath }: LoginFormProps) {
  const router = useRouter();
  const [phone, setPhone] = useState("");
  const [accessCode, setAccessCode] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (isSubmitting) {
      return;
    }

    setErrorMessage("");
    setIsSubmitting(true);

    try {
      const response = await fetch("/api/auth/session", {
        method: "POST",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          phone,
          accessCode,
        }),
      });
      const payload: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        setErrorMessage(
          readErrorMessage(payload) ??
            "Unable to sign in. Check your details and try again.",
        );
        return;
      }

      router.replace(nextPath);
      router.refresh();
    } catch {
      setErrorMessage(
        "Unable to reach the admin service. Check your connection and retry.",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form
      className="mt-5 flex w-full min-w-0 flex-col gap-4"
      onSubmit={handleSubmit}
    >
      <label className="flex min-w-0 flex-col gap-2 text-xs font-black uppercase tracking-wide text-zinc-300">
        Admin phone
        <input
          className="min-h-14 w-full min-w-0 rounded-xl border border-zinc-700 bg-black px-4 py-3 text-base font-bold normal-case tracking-normal text-white outline-none placeholder:text-zinc-600 focus:border-white"
          name="phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          enterKeyHint="next"
          maxLength={32}
          required
          placeholder="010 2527 2693"
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
        />
      </label>

      <label className="flex min-w-0 flex-col gap-2 text-xs font-black uppercase tracking-wide text-zinc-300">
        Access code
        <input
          className="min-h-14 w-full min-w-0 rounded-xl border border-zinc-700 bg-black px-4 py-3 text-base font-bold normal-case tracking-normal text-white outline-none placeholder:text-zinc-600 focus:border-white"
          name="accessCode"
          type="password"
          autoComplete="current-password"
          enterKeyHint="go"
          maxLength={512}
          required
          value={accessCode}
          onChange={(event) => setAccessCode(event.target.value)}
        />
      </label>

      {errorMessage ? (
        <p
          className="break-words rounded-xl border border-red-500/60 bg-red-950 p-3 text-sm font-bold text-red-100"
          role="alert"
          aria-live="assertive"
        >
          {errorMessage}
        </p>
      ) : null}

      <button
        className="min-h-14 w-full min-w-0 rounded-xl bg-white px-4 py-3 text-sm font-black uppercase tracking-wide text-black transition active:scale-[0.99] disabled:cursor-wait disabled:opacity-60"
        type="submit"
        disabled={isSubmitting}
        aria-busy={isSubmitting}
      >
        {isSubmitting ? "Signing in…" : "Open admin portal"}
      </button>
    </form>
  );
}
