---
name: glowrunners-engine
description: Architecture, financial math, Google Sheets API resilience, and mobile UI constraints for GlowRunners. Use when working on Next.js admin pages, gate control, gspread scripts, walk-in logic, or attendance sheets.
---

# GlowRunners Engine

Apply these rules before changing GlowRunners attendance, payments, admin access, or field-operation interfaces.

## Execute safely

1. Inspect the existing implementation and preserve working authentication, attendance, and deployment paths.
2. Use the repository `.venv` for Python work. Keep credentials in ignored files or environment variables; never commit service-account material.
3. Run `python3 send_confirmation.py` successfully before running `python3 make_table.py`. Stop when confirmation sending fails; never build the table from an incomplete confirmation run.
4. Run `python3 .agents/skills/glowrunners-engine/scripts/check_env.py` before Sheets automation or deployment diagnostics.

## Enforce Google Sheets resilience

- Never call `gspread.get_all_records()`. Google Forms can create duplicate headers that make record mapping fail or silently select the wrong column.
- Always call `worksheet.get_all_values()`, normalize the header row, and scan candidate columns from right to left with `reversed(...)`. Treat the rightmost matching column as authoritative.
- Normalize phone numbers before matching and prefix local Egyptian numbers with `'` before writing them to Sheets.
- Read [references/gspread-resilience.md](references/gspread-resilience.md) before changing gspread reads, attendance matching, or phone serialization.

## Enforce gate-control rules

- Set the walk-in base fee to `70 EGP`.
- Calculate change owed from `Amount Received - 70 EGP`, never from an older ticket price. Clamp the displayed owed value to zero when the result is negative.
- Update the live `🔴 CHANGE OWED` total immediately after a confirmed cash transaction.
- Count a runner as confirmed only when the trimmed status explicitly equals `✅ CONFIRMED` or `[x]`. Treat blank cells, `[  ]`, `Sent - ...`, `InstaPay`, and `Vodafone Cash` as pending.
- Read `TUESDAY_LOCATION` and `FRIDAY_LOCATION` dynamically from root `config.py`. Do not hardcode either location in automation or UI branches.
- Read [references/financial-math.md](references/financial-math.md) before changing payment totals, expenses, settlement, or post-run event calculations.

## Enforce admin security

Allow administrative access only for:

- Abdallah Saad: `01025272693`
- Iwan Haitham: `01110112860`
- Layal: `01060804017`

Normalize Egyptian phone variants before whitelist comparison. Apply the same whitelist at backend API boundaries and frontend admin routes. Never rely on client-only authorization.

## Preserve mobile containment

- Keep each admin view inside a full-width, overflow-hidden page with a single `w-full max-w-md` content column.
- Use `min-w-0`, fractional grids, wrapping text, and touch targets at least 44px high.
- Verify at 375px, 390px, and 430px that `scrollWidth <= clientWidth`, controls remain reachable, and no error overlay or console exception appears.

