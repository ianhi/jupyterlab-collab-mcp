"""Tests for pandas DataFrame and Series inspection."""

from __future__ import annotations

import pandas as pd

from variable_inspector.inspector import inspect_one, summarize_one


class TestPandasDataFrame:
    def test_basic_structure(self, small_df: pd.DataFrame) -> None:
        info = inspect_one("df", small_df)
        assert info["name"] == "df"
        assert info["type"] == "DataFrame"
        assert info["shape"] == [3, 3]
        assert len(info["columns"]) == 3
        assert info["columns"][0]["name"] == "id"

    def test_column_dtypes(self, small_df: pd.DataFrame) -> None:
        info = inspect_one("df", small_df)
        dtypes = {c["name"]: c["dtype"] for c in info["columns"]}
        assert dtypes["id"] == "int64"
        assert dtypes["score"] == "float64"

    def test_truncation(self, large_df: pd.DataFrame) -> None:
        info = inspect_one("df", large_df, max_items=5)
        assert len(info["columns"]) == 5
        assert info["columns_truncated"] == 100

    def test_memory_bytes(self, small_df: pd.DataFrame) -> None:
        info = inspect_one("df", small_df)
        assert "memory_bytes" in info
        assert info["memory_bytes"] > 0

    def test_summary(self, small_df: pd.DataFrame) -> None:
        s = summarize_one("df", small_df)
        assert "DataFrame" in s
        assert "3\u00d73" in s
        assert "id:" in s


class TestPandasSeries:
    def test_basic(self, small_series: pd.Series) -> None:
        info = inspect_one("s", small_series)
        assert info["type"] == "Series"
        assert info["dtype"] == "int64"
        assert info["shape"] == [3]
        assert info["series_name"] == "values"

    def test_summary(self, small_series: pd.Series) -> None:
        s = summarize_one("s", small_series)
        assert "Series" in s
        assert "int64" in s
