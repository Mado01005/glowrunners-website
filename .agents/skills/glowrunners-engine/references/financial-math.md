# GlowRunners financial math

Coerce every input to a finite, non-negative number before aggregation. Derive statuses from numeric values rather than maintaining conflicting manual totals.

## Gate Control

Use a walk-in ticket price of `70 EGP`.

```text
Raw Change Difference = Amount Received - 70
Change Owed = MAX(0, Amount Received - 70)
Ticket Shortfall = MAX(0, 70 - Amount Received)
Cash Retained = Amount Received - Change Returned
```

Calculate cash in hand only from physically confirmed cash transactions:

```text
Cash in Hand = SUM(Cash Retained for confirmed cash runners and walk-ins)
               - SUM(Cash Expenses Paid)
```

Do not include pending runners, InstaPay receipts, Vodafone Cash receipts, or unreturned change as spendable cash. Track unresolved change separately in `🔴 CHANGE OWED`:

```text
Outstanding Change = SUM(Change Owed - Change Already Returned)
```

## Post-Run Events

For an event with ticket price `Ticket Price`, participants `P`, collected payments, and vendor cost:

```text
Expected Revenue = Ticket Price * Total Participants
Total Collected = SUM(Amount Paid for participant in P)
Remaining Balance = Expected Revenue - Total Collected
Net Profit = Total Collected - Vendor Cost
```

For each participant:

```text
Participant Remaining Balance = MAX(0, Ticket Price - Amount Paid)
```

Classify payment status from the participant math:

- `Amount Paid == 0`: unpaid.
- `0 < Amount Paid < Ticket Price`: deposit verified or partially paid.
- `Amount Paid >= Ticket Price`: fully cleared.

Recalculate all summary cards from the participant ledger after every mutation. Never increment cached totals independently of the underlying payment update.

