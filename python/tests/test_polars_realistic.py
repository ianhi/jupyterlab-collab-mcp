"""Realistic polars patterns: struct/list columns, temporal types, enums, lazy chains."""

from __future__ import annotations

import time

import polars as pl

from variable_inspector.inspector import inspect_one, summarize_one


# ---------------------------------------------------------------------------
# Struct columns
# ---------------------------------------------------------------------------


class TestStructColumns:
    def test_basic_struct(self) -> None:
        df = pl.DataFrame(
            {
                "id": [1, 2, 3],
                "person": [
                    {"name": "Alice", "age": 30},
                    {"name": "Bob", "age": 25},
                    {"name": "Charlie", "age": 35},
                ],
            }
        )
        info = inspect_one("df", df)
        assert info["type"] == "polars.DataFrame"
        assert info["shape"] == [3, 2]
        person_col = next(c for c in info["columns"] if c["name"] == "person")
        assert "Struct" in person_col["dtype"]

    def test_nested_struct(self) -> None:
        df = pl.DataFrame(
            {
                "id": [1, 2],
                "person": [
                    {
                        "name": "Alice",
                        "address": {"street": "123 Main St", "city": "NYC"},
                    },
                    {
                        "name": "Bob",
                        "address": {"street": "456 Oak Ave", "city": "LA"},
                    },
                ],
            }
        )
        info = inspect_one("df", df)
        person_col = next(c for c in info["columns"] if c["name"] == "person")
        assert "Struct" in person_col["dtype"]

    def test_struct_summary(self) -> None:
        df = pl.DataFrame(
            {"data": [{"x": 1, "y": 2.0}, {"x": 3, "y": 4.0}]}
        )
        s = summarize_one("df", df)
        assert "polars.DataFrame" in s
        assert "Struct" in s


# ---------------------------------------------------------------------------
# List columns
# ---------------------------------------------------------------------------


class TestListColumns:
    def test_list_of_ints(self) -> None:
        df = pl.DataFrame(
            {
                "id": [1, 2, 3],
                "scores": [[85, 90, 78], [92, 88], [75]],
            }
        )
        info = inspect_one("df", df)
        scores_col = next(c for c in info["columns"] if c["name"] == "scores")
        assert "List" in scores_col["dtype"]

    def test_list_of_strings(self) -> None:
        df = pl.DataFrame(
            {
                "id": [1, 2],
                "tags": [["python", "data"], ["rust", "fast"]],
            }
        )
        info = inspect_one("df", df)
        tags_col = next(c for c in info["columns"] if c["name"] == "tags")
        assert "List" in tags_col["dtype"]
        assert "String" in tags_col["dtype"] or "Utf8" in tags_col["dtype"]


# ---------------------------------------------------------------------------
# Enum dtype
# ---------------------------------------------------------------------------


class TestEnumDtype:
    def test_basic_enum(self) -> None:
        df = pl.DataFrame(
            {"size": ["small", "medium", "large", "small"]}
        ).with_columns(
            pl.col("size").cast(pl.Enum(["small", "medium", "large"]))
        )
        info = inspect_one("df", df)
        size_col = next(c for c in info["columns"] if c["name"] == "size")
        assert "Enum" in size_col["dtype"]


# ---------------------------------------------------------------------------
# Temporal types
# ---------------------------------------------------------------------------


class TestTemporalTypes:
    def test_date(self) -> None:
        df = pl.DataFrame(
            {
                "event_date": pl.date_range(
                    pl.date(2024, 1, 1), pl.date(2024, 1, 3), "1d", eager=True
                ),
            }
        )
        info = inspect_one("df", df)
        col = info["columns"][0]
        assert col["dtype"] == "Date"

    def test_datetime(self) -> None:
        df = pl.DataFrame(
            {
                "ts": pl.datetime_range(
                    pl.datetime(2024, 1, 1),
                    pl.datetime(2024, 1, 3),
                    "1d",
                    eager=True,
                ),
            }
        )
        info = inspect_one("df", df)
        col = info["columns"][0]
        assert "Datetime" in col["dtype"]

    def test_datetime_with_timezone(self) -> None:
        df = pl.DataFrame(
            {
                "utc_time": pl.datetime_range(
                    pl.datetime(2024, 1, 1),
                    pl.datetime(2024, 1, 3),
                    "1d",
                    eager=True,
                    time_zone="UTC",
                ),
            }
        )
        info = inspect_one("df", df)
        col = info["columns"][0]
        assert "UTC" in col["dtype"]

    def test_duration(self) -> None:
        df = pl.DataFrame({"elapsed": [3600, 7200, 10800]}).with_columns(
            pl.col("elapsed").cast(pl.Duration(time_unit="us"))
        )
        info = inspect_one("df", df)
        col = info["columns"][0]
        assert "Duration" in col["dtype"]

    def test_time(self) -> None:
        df = pl.DataFrame(
            {"event_time": ["09:30:00", "14:45:30", "16:20:15"]}
        ).with_columns(
            pl.col("event_time").str.strptime(pl.Time, format="%H:%M:%S")
        )
        info = inspect_one("df", df)
        col = info["columns"][0]
        assert col["dtype"] == "Time"


# ---------------------------------------------------------------------------
# Null-heavy data
# ---------------------------------------------------------------------------


class TestNullHeavyData:
    def test_many_nulls(self) -> None:
        df = pl.DataFrame(
            {
                "id": [1, 2, 3, 4, 5],
                "name": ["Alice", None, "Charlie", None, "Eve"],
                "score": [85.5, None, None, 92.0, None],
            }
        )
        info = inspect_one("df", df)
        assert info["shape"] == [5, 3]
        # Dtypes should still be the base type, not affected by nulls
        name_col = next(c for c in info["columns"] if c["name"] == "name")
        assert name_col["dtype"] in ("String", "Utf8")
        score_col = next(c for c in info["columns"] if c["name"] == "score")
        assert "Float" in score_col["dtype"]


# ---------------------------------------------------------------------------
# LazyFrame with complex plan
# ---------------------------------------------------------------------------


class TestComplexLazyFrame:
    def test_lazy_chain(self) -> None:
        df = pl.DataFrame(
            {
                "date": pl.date_range(
                    pl.date(2024, 1, 1), pl.date(2024, 1, 10), "1d", eager=True
                ),
                "value": list(range(10)),
                "category": ["A", "B"] * 5,
            }
        )
        lf = (
            df.lazy()
            .filter(pl.col("value") > 3)
            .group_by("category")
            .agg(pl.col("value").sum().alias("total"))
            .sort("total")
        )
        info = inspect_one("lf", lf)
        assert info["type"] == "polars.LazyFrame"
        assert info["lazy"] is True
        col_names = [c["name"] for c in info["columns"]]
        assert "category" in col_names
        assert "total" in col_names

    def test_lazy_performance(self) -> None:
        """LazyFrame inspect must not trigger .collect()."""
        df = pl.DataFrame({"x": range(100_000), "y": range(100_000)})
        lf = df.lazy().filter(pl.col("x") > 50000).with_columns(
            (pl.col("y") * 2).alias("y2")
        )
        start = time.perf_counter()
        inspect_one("lf", lf)
        elapsed_ms = (time.perf_counter() - start) * 1000
        assert elapsed_ms < 5, f"LazyFrame took {elapsed_ms:.2f}ms"


# ---------------------------------------------------------------------------
# Mixed complex types
# ---------------------------------------------------------------------------


class TestMixedComplexTypes:
    def test_realistic_mixed(self) -> None:
        """A realistic DataFrame combining multiple complex column types."""
        df = pl.DataFrame(
            {
                "id": [1, 2, 3],
                "name": ["Alice", "Bob", "Charlie"],
                "scores": [[85, 90, 78], [92, 88], [75]],
                "date_created": pl.date_range(
                    pl.date(2024, 1, 1), pl.date(2024, 1, 3), "1d", eager=True
                ),
                "metadata": [
                    {"version": "1.0", "tags": ["python"]},
                    {"version": "2.0", "tags": ["rust", "fast"]},
                    {"version": "1.5", "tags": ["web"]},
                ],
            }
        )
        info = inspect_one("df", df)
        assert info["shape"] == [3, 5]

        # Verify each column's dtype is captured
        dtypes = {c["name"]: c["dtype"] for c in info["columns"]}
        assert dtypes["id"] == "Int64"
        assert dtypes["name"] in ("String", "Utf8")
        assert "List" in dtypes["scores"]
        assert dtypes["date_created"] == "Date"
        assert "Struct" in dtypes["metadata"]

    def test_mixed_summary(self) -> None:
        df = pl.DataFrame(
            {
                "id": [1, 2],
                "tags": [["a", "b"], ["c"]],
                "data": [{"x": 1}, {"x": 2}],
            }
        )
        s = summarize_one("df", df)
        assert "polars.DataFrame" in s
        assert "2\u00d73" in s


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------


class TestPolarsEdgeCases:
    def test_empty_dataframe(self) -> None:
        df = pl.DataFrame(
            {
                "id": pl.Series([], dtype=pl.Int64),
                "name": pl.Series([], dtype=pl.String),
            }
        )
        info = inspect_one("empty", df)
        assert info["shape"] == [0, 2]
        assert len(info["columns"]) == 2

    def test_single_row(self) -> None:
        df = pl.DataFrame({"id": [1], "value": [42.5]})
        info = inspect_one("one", df)
        assert info["shape"] == [1, 2]

    def test_wide_dataframe(self) -> None:
        df = pl.DataFrame({f"col_{i}": [1, 2, 3] for i in range(200)})
        info = inspect_one("wide", df, max_items=20)
        assert len(info["columns"]) == 20
        assert info["columns_truncated"] == 200

    def test_wide_performance(self) -> None:
        df = pl.DataFrame({f"col_{i}": [1] for i in range(500)})
        start = time.perf_counter()
        inspect_one("wide", df, max_items=20)
        elapsed_ms = (time.perf_counter() - start) * 1000
        assert elapsed_ms < 5


# ---------------------------------------------------------------------------
# Performance
# ---------------------------------------------------------------------------


class TestPolarsPerformance:
    def test_struct_under_5ms(self) -> None:
        df = pl.DataFrame(
            {"data": [{"k": i, "v": float(i)} for i in range(1000)]}
        )
        start = time.perf_counter()
        inspect_one("df", df)
        elapsed_ms = (time.perf_counter() - start) * 1000
        assert elapsed_ms < 5

    def test_mixed_types_under_5ms(self) -> None:
        df = pl.DataFrame(
            {
                "id": range(10000),
                "name": [f"item_{i}" for i in range(10000)],
                "scores": [[1, 2, 3]] * 10000,
                "meta": [{"key": "val"}] * 10000,
            }
        )
        start = time.perf_counter()
        inspect_one("df", df, max_items=20)
        elapsed_ms = (time.perf_counter() - start) * 1000
        assert elapsed_ms < 5
