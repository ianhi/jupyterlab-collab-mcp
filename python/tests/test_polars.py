"""Tests for polars DataFrame, LazyFrame, and Series inspection."""

from __future__ import annotations

import polars as pl

from variable_inspector.inspector import inspect_one, summarize_one


class TestPolarsDataFrame:
    def test_basic(self, polars_df: pl.DataFrame) -> None:
        info = inspect_one("pdf", polars_df)
        assert info["type"] == "polars.DataFrame"
        assert info["shape"] == [3, 3]
        assert len(info["columns"]) == 3

    def test_schema(self, polars_df: pl.DataFrame) -> None:
        info = inspect_one("pdf", polars_df)
        col_names = [c["name"] for c in info["columns"]]
        assert "x" in col_names
        assert "y" in col_names

    def test_summary(self, polars_df: pl.DataFrame) -> None:
        s = summarize_one("pdf", polars_df)
        assert "polars.DataFrame" in s
        assert "3\u00d73" in s


class TestPolarsLazyFrame:
    def test_basic(self, polars_lazy: pl.LazyFrame) -> None:
        info = inspect_one("lf", polars_lazy)
        assert info["type"] == "polars.LazyFrame"
        assert info["lazy"] is True
        assert len(info["columns"]) == 2

    def test_summary(self, polars_lazy: pl.LazyFrame) -> None:
        s = summarize_one("lf", polars_lazy)
        assert "polars.LazyFrame" in s
        assert "a:" in s


class TestPolarsSeries:
    def test_basic(self, polars_series: pl.Series) -> None:
        info = inspect_one("ps", polars_series)
        assert info["type"] == "polars.Series"
        assert info["series_name"] == "vals"

    def test_summary(self, polars_series: pl.Series) -> None:
        s = summarize_one("ps", polars_series)
        assert "polars.Series" in s
