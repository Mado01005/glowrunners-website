# Google Sheets and phone resilience

## Duplicate Google Forms columns

Google Forms can append a new column when a question is renamed, restored, or recreated. The sheet can therefore contain identical headers or several aliases for the same logical field. `gspread.get_all_records()` expects a unique header mapping and can raise a duplicate-header error; a naive left-to-right lookup can also select stale data.

Read the raw grid with `get_all_values()`. Normalize whitespace and casing, then scan from the right because the newest Google Forms column is normally the rightmost match.

```python
def normalize_header(value: str) -> str:
    return " ".join(value.strip().casefold().split())


values = worksheet.get_all_values()
headers = [normalize_header(value) for value in (values[0] if values else [])]


def find_rightmost_column(*aliases: str) -> int | None:
    wanted = {normalize_header(alias) for alias in aliases}
    return next(
        (index for index in reversed(range(len(headers))) if headers[index] in wanted),
        None,
    )


status_column = find_rightmost_column(
    "Confirmed?",
    "Confirmation Status",
    "Check-in Status",
)
```

Handle an empty sheet, a header-only sheet, and a missing required column explicitly. Never silently fall back to column zero.

## Egyptian phone normalization

Accept spaces, dashes, parentheses, `+20`, `20`, and local `01...` forms.

```python
import re


def normalize_egyptian_mobile(raw: str) -> tuple[str, str]:
    digits = re.sub(r"\D", "", raw)
    if digits.startswith("20"):
        digits = digits[2:]

    check_in_id = digits.lstrip("0")
    if not re.fullmatch(r"1[0125]\d{8}", check_in_id):
        raise ValueError("Expected an Egyptian mobile number")

    local_phone = f"0{check_in_id}"  # 01XXXXXXXXX
    return local_phone, check_in_id
```

Use these representations consistently:

- Display and local matching: `01XXXXXXXXX`.
- Check-in or QR identifier: strip the leading zero to `1XXXXXXXXX`.
- WhatsApp `wa.me`: prefix the check-in identifier with `20`, producing `201XXXXXXXXX`.
- Google Sheets writes: prefix the local number with an apostrophe, for example `'<phone>`, so Sheets preserves the leading zero and does not convert the value to a number.

Compare canonical values, not raw cell text. Preserve the original value only for display or audit purposes.

