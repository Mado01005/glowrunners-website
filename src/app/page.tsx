const WHAT_TO_BRING = [
  "Water bottle",
  "Comfortable running shoes",
  "Your best energy",
] as const;

export default function HomePage() {
  return (
    <main className="w-full min-h-screen bg-black text-white flex flex-col items-center justify-start overflow-x-hidden px-4">
      <div className="w-full max-w-md flex flex-col gap-4 box-border py-6">
        <header className="w-full min-w-0 py-3 text-center">
          <div className="mx-auto mb-5 h-2 w-20 rounded-full bg-pink-500 shadow-[0_0_20px_rgba(236,72,153,0.35)]" />
          <p className="text-xs font-black uppercase tracking-[0.28em] text-pink-500">
            Alexandria moves together
          </p>
          <h1 className="mt-3 max-w-full break-words text-3xl font-black uppercase leading-[0.92] tracking-tight text-white min-[380px]:text-4xl min-[430px]:text-5xl">
            Glow<span className="text-pink-500">Runners</span>
          </h1>
          <p className="mx-auto mt-4 max-w-sm text-sm font-semibold leading-6 text-zinc-400">
            Your live event briefing and fastest route to the starting line.
          </p>
        </header>

        <section
          aria-labelledby="event-location-heading"
          className="w-full min-w-0 overflow-hidden rounded-2xl border border-pink-500/40 bg-zinc-950 p-5 shadow-[0_0_20px_rgba(236,72,153,0.2)]"
        >
          <div className="flex min-w-0 items-start gap-4">
            <div
              aria-hidden="true"
              className="grid h-12 w-12 flex-shrink-0 place-items-center rounded-xl bg-pink-500/10"
            >
              <svg
                className="h-6 w-6 text-pink-500"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z" />
                <circle cx="12" cy="10" r="2.5" />
              </svg>
            </div>
            <div className="min-w-0">
              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-zinc-500">
                This week&apos;s location
              </p>
              <h2
                id="event-location-heading"
                className="mt-1 break-words text-2xl font-black leading-tight text-white"
              >
                Kafr Abdo
              </h2>
              <p className="mt-2 text-sm font-semibold text-zinc-400">
                Friday sunrise session · arrive ready to move
              </p>
            </div>
          </div>
        </section>

        <section
          aria-labelledby="bring-heading"
          className="w-full min-w-0 rounded-2xl border border-zinc-800 bg-zinc-950 p-5"
        >
          <h2
            id="bring-heading"
            className="text-sm font-black uppercase tracking-[0.16em] text-white"
          >
            What to bring
          </h2>
          <ul className="mt-4 flex w-full min-w-0 flex-col gap-3">
            {WHAT_TO_BRING.map((item) => (
              <li
                key={item}
                className="flex min-w-0 items-start gap-3 text-sm font-semibold text-zinc-300"
              >
                <span
                  aria-hidden="true"
                  className="mt-0.5 grid h-5 w-5 flex-shrink-0 place-items-center rounded-full bg-pink-500 text-xs font-black text-black"
                >
                  ✓
                </span>
                <span className="min-w-0 break-words">{item}</span>
              </li>
            ))}
          </ul>
        </section>

        <section
          aria-labelledby="ticket-hub-heading"
          className="w-full min-w-0 rounded-2xl border border-zinc-800 bg-zinc-950 p-5 shadow-[0_0_20px_rgba(236,72,153,0.18)]"
        >
          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-pink-500">
            Ready for check-in?
          </p>
          <h2
            id="ticket-hub-heading"
            className="mt-1 text-2xl font-black text-white"
          >
            Ticket Hub
          </h2>
          <p className="mt-2 text-sm font-semibold leading-6 text-zinc-400">
            Enter the WhatsApp number used during registration to find your QR
            ticket.
          </p>

          <form
            method="GET"
            action="/ticket"
            className="mt-5 flex w-full min-w-0 flex-col gap-3"
          >
            <label
              htmlFor="ticket-phone"
              className="text-xs font-black uppercase tracking-wide text-zinc-300"
            >
              Registration phone
            </label>
            <div className="flex min-h-14 w-full min-w-0 items-center overflow-hidden rounded-xl border border-zinc-700 bg-black focus-within:border-white">
              <span className="flex-shrink-0 px-4 text-base font-black text-zinc-300">
                +20
              </span>
              <span aria-hidden="true" className="h-7 w-px bg-zinc-700" />
              <input
                id="ticket-phone"
                name="phone"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                enterKeyHint="search"
                maxLength={18}
                required
                aria-describedby="ticket-phone-help"
                placeholder="10 1234 5678"
                className="h-14 w-full min-w-0 bg-transparent px-4 text-base font-bold text-white outline-none placeholder:text-zinc-600"
              />
            </div>
            <p
              id="ticket-phone-help"
              className="text-xs font-semibold text-zinc-500"
            >
              Numbers, spaces, and dashes are accepted.
            </p>
            <button
              type="submit"
              className="min-h-14 w-full min-w-0 rounded-xl bg-pink-500 px-4 py-3 text-sm font-black uppercase tracking-wide text-black shadow-[0_0_20px_rgba(236,72,153,0.3)] transition active:scale-[0.99]"
            >
              Find my QR ticket
            </button>
          </form>
        </section>

        <footer className="w-full min-w-0 py-3 text-center text-xs font-semibold text-zinc-600">
          Live event details powered by the GlowRunners crew.
        </footer>
      </div>
    </main>
  );
}
