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
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
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
          username,
          password,
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
        Username
        <input
          className="min-h-14 w-full min-w-0 rounded-xl border border-zinc-700 bg-black px-4 py-3 text-base font-bold normal-case tracking-normal text-white outline-none placeholder:text-zinc-600 focus:border-white"
          name="username"
          type="text"
          autoCapitalize="none"
          autoComplete="username"
          enterKeyHint="next"
          maxLength={64}
          required
          placeholder="Iwan, Layal, or 01025272693"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
        />
      </label>

      <label className="flex min-w-0 flex-col gap-2 text-xs font-black uppercase tracking-wide text-zinc-300">
        Password
        <input
          className="min-h-14 w-full min-w-0 rounded-xl border border-zinc-700 bg-black px-4 py-3 text-base font-bold normal-case tracking-normal text-white outline-none placeholder:text-zinc-600 focus:border-white"
          name="password"
          type="password"
          autoComplete="current-password"
          enterKeyHint="go"
          maxLength={256}
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
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
