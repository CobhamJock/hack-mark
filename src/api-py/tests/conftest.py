from __future__ import annotations

import shutil
from collections.abc import Iterator
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from main import app


@pytest.fixture(autouse=True)
def isolated_database(monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    api_dir = Path(__file__).resolve().parents[1]
    directory = api_dir / f".test-data-{uuid4().hex}"
    directory.mkdir()
    database = directory / "app.db"
    monkeypatch.chdir(api_dir)
    monkeypatch.setenv("DB_FILE", str(database))
    monkeypatch.setenv("DB_MIGRATIONS_DIR", str(api_dir.parent / "database" / "migrations"))
    monkeypatch.setenv("INVENTORY_ADMIN_TOKEN", "test-inventory-admin")
    try:
        yield database
    finally:
        shutil.rmtree(directory)


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(app) as test_client:
        yield test_client
