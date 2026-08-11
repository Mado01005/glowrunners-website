#!/usr/bin/env python3
"""Verify the local GlowRunners Python and read-only Google Sheets setup."""

from __future__ import annotations

import importlib
import json
import os
import re
import sys
from pathlib import Path
from typing import Any

SHEET_ID = "1MJApZDOATx8vZUGKBtaHOFnIo831lSZJHl8KUJEaguM"
READ_ONLY_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly"
REQUIRED_PACKAGES = ("gspread", "oauth2client", "pywhatkit")
ENVIRONMENT_CREDENTIAL_NAMES = (
    "GOOGLE_CREDENTIALS_JSON",
    "GOOGLE_CREDS_JSON",
    "GOOGLE_SHEETS_CREDENTIALS",
)
WORKSPACE_ROOT = Path(__file__).resolve().parents[4]
CREDENTIALS_PATH = WORKSPACE_ROOT / "credentials.json"
LOCAL_ENV_PATHS = (
    WORKSPACE_ROOT / ".env.local",
    WORKSPACE_ROOT / ".env.development.local",
)
ENV_ASSIGNMENT_PATTERN = re.compile(
    r"(?m)^(?P<name>[A-Za-z_][A-Za-z0-9_]*)="
)


def import_required_packages() -> Any:
    missing: list[str] = []
    imported: dict[str, Any] = {}

    for package_name in REQUIRED_PACKAGES:
        try:
            imported[package_name] = importlib.import_module(package_name)
        except ImportError:
            missing.append(package_name)

    if missing:
        joined = ", ".join(missing)
        raise RuntimeError(
            f"Missing Python package(s): {joined}. "
            "Activate .venv and run `python3 -m pip install -r requirements.txt`."
        )

    return imported["gspread"]


def read_dotenv_value(path: Path, variable_name: str) -> str | None:
    if not path.is_file():
        return None

    source = path.read_text(encoding="utf-8")
    assignments = list(ENV_ASSIGNMENT_PATTERN.finditer(source))

    for index, assignment in enumerate(assignments):
        if assignment.group("name") != variable_name:
            continue

        value_end = (
            assignments[index + 1].start()
            if index + 1 < len(assignments)
            else len(source)
        )
        value = source[assignment.end() : value_end].strip()
        return value or None

    return None


def parse_service_account_json(serialized: str) -> dict[str, Any]:
    candidates = [serialized.strip()]
    stripped = serialized.strip()

    if len(stripped) >= 2 and stripped[0] == stripped[-1] == "'":
        candidates.append(stripped[1:-1])
    if len(stripped) >= 2 and stripped[0] == stripped[-1] == '"':
        candidates.append(stripped[1:-1])

    parse_errors: list[str] = []
    for candidate in candidates:
        current: Any = candidate
        try:
            for _ in range(3):
                if isinstance(current, dict):
                    credentials = current
                    break
                if not isinstance(current, str):
                    raise TypeError("Credentials must decode to a JSON object")
                current = json.loads(current, strict=False)
            else:
                credentials = current

            if not isinstance(credentials, dict):
                raise TypeError("Credentials must decode to a JSON object")

            private_key = credentials.get("private_key")
            if isinstance(private_key, str):
                credentials["private_key"] = private_key.replace("\\n", "\n")
            return credentials
        except (json.JSONDecodeError, TypeError) as error:
            parse_errors.append(str(error))

    raise RuntimeError(
        "Google service-account credentials are not valid JSON: "
        + "; ".join(parse_errors)
    )


def validate_service_account(credentials: dict[str, Any]) -> None:
    required_fields = (
        "type",
        "project_id",
        "private_key_id",
        "private_key",
        "client_email",
        "token_uri",
    )
    missing = [field for field in required_fields if not credentials.get(field)]

    if credentials.get("type") != "service_account":
        raise RuntimeError("Google credentials must have type `service_account`.")
    if missing:
        raise RuntimeError(
            "Google service-account credentials are missing: " + ", ".join(missing)
        )


def load_credentials() -> tuple[dict[str, Any], str]:
    if CREDENTIALS_PATH.is_file():
        credentials = parse_service_account_json(
            CREDENTIALS_PATH.read_text(encoding="utf-8")
        )
        validate_service_account(credentials)
        return credentials, "credentials.json"

    for variable_name in ENVIRONMENT_CREDENTIAL_NAMES:
        value = os.environ.get(variable_name, "").strip()
        if value:
            credentials = parse_service_account_json(value)
            validate_service_account(credentials)
            return credentials, f"environment variable {variable_name}"

    for env_path in LOCAL_ENV_PATHS:
        for variable_name in ENVIRONMENT_CREDENTIAL_NAMES:
            value = read_dotenv_value(env_path, variable_name)
            if value:
                credentials = parse_service_account_json(value)
                validate_service_account(credentials)
                return credentials, f"ignored local environment file {env_path.name}"

    raise RuntimeError(
        "No credentials found. Add ignored credentials.json or configure "
        "GOOGLE_CREDENTIALS_JSON."
    )


def main() -> int:
    try:
        gspread = import_required_packages()
        credentials, source = load_credentials()
        client = gspread.service_account_from_dict(
            credentials,
            scopes=[READ_ONLY_SCOPE],
        )
        spreadsheet = client.open_by_key(SHEET_ID)
        worksheet_count = len(spreadsheet.worksheets())

        if worksheet_count == 0:
            raise RuntimeError("The spreadsheet is reachable but contains no worksheets.")

        print(f"Read-only Sheets access confirmed using {source}.")
        print(f"Accessible worksheets: {worksheet_count}")
        print("✅ GlowRunners Environment & Credentials Verified")
        return 0
    except Exception as error:  # noqa: BLE001 - diagnostic must report all setup failures
        print(f"❌ GlowRunners environment check failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

