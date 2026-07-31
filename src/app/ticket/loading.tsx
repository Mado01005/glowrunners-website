export default function TicketLoading() {
  return (
    <main className="ticket-shell" aria-busy="true">
      <section
        className="ticket-card"
        aria-label="Loading GlowRunners ticket"
        role="status"
      >
        <p className="ticket-brand">GlowRunners Sunrise Pass</p>
        <div className="motion-safe:animate-pulse">
          <div className="mx-auto h-9 w-3/4 rounded bg-white/10" />
          <div className="mx-auto mt-4 h-5 w-1/2 rounded bg-white/10" />
          <div className="qr-frame mt-6">
            <div className="h-full w-full rounded bg-zinc-200" />
          </div>
        </div>
        <p className="ticket-subtitle">Loading your ticket…</p>
      </section>
    </main>
  );
}
