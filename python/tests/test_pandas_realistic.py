"""Realistic pandas patterns: dtypes, indices, and objects users actually have."""

from __future__ import annotations

import time

import numpy as np
import pandas as pd
import pytest

from variable_inspector.inspector import inspect_one, summarize_one

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def categorical_df() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "city": pd.Categorical(["NYC", "LA", "NYC", "SF"], categories=["NYC", "LA", "SF"]),
            "score": [1.0, 2.0, 3.0, 4.0],
        }
    )


@pytest.fixture
def multiindex_row_df() -> pd.DataFrame:
    idx = pd.MultiIndex.from_tuples([("A", 1), ("A", 2), ("B", 1), ("B", 2)], names=["group", "id"])
    return pd.DataFrame({"val": [10, 20, 30, 40]}, index=idx)


@pytest.fixture
def multiindex_col_df() -> pd.DataFrame:
    cols = pd.MultiIndex.from_tuples(
        [("X", "a"), ("X", "b"), ("Y", "a"), ("Y", "b")], names=["letter", "sub"]
    )
    return pd.DataFrame([[1, 2, 3, 4], [5, 6, 7, 8]], columns=cols)


@pytest.fixture
def nullable_dtypes_df() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "nullable_int": pd.array([1, 2, None], dtype=pd.Int64Dtype()),
            "nullable_str": pd.array(["a", "b", None], dtype=pd.StringDtype()),
            "nullable_bool": pd.array([True, False, None], dtype=pd.BooleanDtype()),
        }
    )


@pytest.fixture
def datetime_index_df() -> pd.DataFrame:
    idx = pd.date_range("2024-01-01", periods=100, freq="h")
    return pd.DataFrame({"temp": np.random.randn(100), "humidity": np.random.randn(100)}, index=idx)


@pytest.fixture
def period_index_df() -> pd.DataFrame:
    idx = pd.period_range("2024-01", periods=12, freq="M")
    return pd.DataFrame({"revenue": np.random.randn(12)}, index=idx)


@pytest.fixture
def timedelta_index_df() -> pd.DataFrame:
    idx = pd.timedelta_range("1 day", periods=5)
    return pd.DataFrame({"distance": [100, 200, 300, 400, 500]}, index=idx)


@pytest.fixture
def empty_df_with_cols() -> pd.DataFrame:
    return pd.DataFrame(columns=["id", "name", "score"]).astype(
        {"id": "int64", "name": "object", "score": "float64"}
    )


@pytest.fixture
def duplicate_col_df() -> pd.DataFrame:
    return pd.DataFrame([[1, 2, 3], [4, 5, 6]], columns=["A", "B", "A"])


@pytest.fixture
def wide_df() -> pd.DataFrame:
    return pd.DataFrame({f"col_{i}": [i] for i in range(500)})


@pytest.fixture
def groupby_obj() -> pd.core.groupby.DataFrameGroupBy:
    df = pd.DataFrame({"grp": ["A", "A", "B", "B", "C"], "val": [1, 2, 3, 4, 5]})
    return df.groupby("grp")


@pytest.fixture
def sparse_df() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "sparse_col": pd.array([0, 0, 1, 0, 0, 2, 0, 0], dtype="Sparse[int64]"),
            "normal_col": range(8),
        }
    )


@pytest.fixture
def mixed_dtypes_df() -> pd.DataFrame:
    """A realistic 'messy' DataFrame like you'd get from pd.read_csv."""
    return pd.DataFrame(
        {
            "id": range(5),
            "name": ["Alice", "Bob", "Charlie", "David", "Eve"],
            "score": [1.1, 2.2, None, 4.4, 5.5],
            "active": [True, False, True, True, False],
            "created_at": pd.to_datetime(
                ["2024-01-01", "2024-02-01", None, "2024-04-01", "2024-05-01"]
            ),
            "category": pd.Categorical(["A", "B", "A", "C", "B"]),
        }
    )


# ---------------------------------------------------------------------------
# Tests — all check that inspect_one captures adequate detail
# ---------------------------------------------------------------------------


class TestCategoricalDtype:
    def test_columns_include_category(self, categorical_df: pd.DataFrame) -> None:
        info = inspect_one("df", categorical_df)
        dtypes = {c["name"]: c["dtype"] for c in info["columns"]}
        assert dtypes["city"] == "category"
        assert dtypes["score"] == "float64"

    def test_shape(self, categorical_df: pd.DataFrame) -> None:
        info = inspect_one("df", categorical_df)
        assert info["shape"] == [4, 2]

    def test_summary_shows_dtype(self, categorical_df: pd.DataFrame) -> None:
        s = summarize_one("df", categorical_df)
        assert "category" in s


class TestMultiIndex:
    def test_row_multiindex_shape(self, multiindex_row_df: pd.DataFrame) -> None:
        info = inspect_one("df", multiindex_row_df)
        assert info["shape"] == [4, 1]
        assert info["columns"][0]["name"] == "val"

    def test_col_multiindex_shape(self, multiindex_col_df: pd.DataFrame) -> None:
        info = inspect_one("df", multiindex_col_df)
        assert info["shape"] == [2, 4]
        # Column names should be string representations of the tuples
        col_names = [c["name"] for c in info["columns"]]
        assert len(col_names) == 4

    def test_row_multiindex_index_dtype(self, multiindex_row_df: pd.DataFrame) -> None:
        info = inspect_one("df", multiindex_row_df)
        # MultiIndex doesn't have a single dtype, but we should still get index info
        assert "index_dtype" in info

    def test_performance(self, multiindex_row_df: pd.DataFrame) -> None:
        start = time.perf_counter()
        inspect_one("df", multiindex_row_df)
        elapsed_ms = (time.perf_counter() - start) * 1000
        assert elapsed_ms < 5


class TestNullableDtypes:
    def test_captures_nullable_dtypes(self, nullable_dtypes_df: pd.DataFrame) -> None:
        info = inspect_one("df", nullable_dtypes_df)
        dtypes = {c["name"]: c["dtype"] for c in info["columns"]}
        assert dtypes["nullable_int"] == "Int64"
        assert dtypes["nullable_str"] == "string"
        assert dtypes["nullable_bool"] == "boolean"

    def test_summary_readable(self, nullable_dtypes_df: pd.DataFrame) -> None:
        s = summarize_one("df", nullable_dtypes_df)
        assert "DataFrame" in s
        assert "nullable_int" in s


class TestDatetimeIndex:
    def test_datetime_index_dtype(self, datetime_index_df: pd.DataFrame) -> None:
        info = inspect_one("df", datetime_index_df)
        # Should capture the index dtype (datetime64[...])
        assert "index_dtype" in info
        assert "datetime64" in info["index_dtype"]

    def test_shape(self, datetime_index_df: pd.DataFrame) -> None:
        info = inspect_one("df", datetime_index_df)
        assert info["shape"] == [100, 2]

    def test_summary(self, datetime_index_df: pd.DataFrame) -> None:
        s = summarize_one("df", datetime_index_df)
        assert "100" in s
        assert "temp" in s


class TestPeriodAndTimedelta:
    def test_period_index(self, period_index_df: pd.DataFrame) -> None:
        info = inspect_one("df", period_index_df)
        assert info["shape"] == [12, 1]
        assert "index_dtype" in info

    def test_timedelta_index(self, timedelta_index_df: pd.DataFrame) -> None:
        info = inspect_one("df", timedelta_index_df)
        assert info["shape"] == [5, 1]
        assert "index_dtype" in info
        assert "timedelta" in info["index_dtype"]


class TestEmptyDataFrame:
    def test_shape_with_columns(self, empty_df_with_cols: pd.DataFrame) -> None:
        info = inspect_one("df", empty_df_with_cols)
        assert info["shape"] == [0, 3]
        assert len(info["columns"]) == 3

    def test_column_dtypes_preserved(self, empty_df_with_cols: pd.DataFrame) -> None:
        info = inspect_one("df", empty_df_with_cols)
        dtypes = {c["name"]: c["dtype"] for c in info["columns"]}
        assert dtypes["id"] == "int64"
        assert dtypes["score"] == "float64"

    def test_completely_empty(self) -> None:
        info = inspect_one("df", pd.DataFrame())
        assert info["shape"] == [0, 0]
        assert info["columns"] == []


class TestDuplicateColumns:
    def test_captures_all_columns(self, duplicate_col_df: pd.DataFrame) -> None:
        info = inspect_one("df", duplicate_col_df)
        col_names = [c["name"] for c in info["columns"]]
        assert col_names == ["A", "B", "A"]
        assert info["shape"] == [2, 3]


class TestWideDataFrame:
    def test_truncation(self, wide_df: pd.DataFrame) -> None:
        info = inspect_one("df", wide_df, max_items=20)
        assert len(info["columns"]) == 20
        assert info["columns_truncated"] == 500

    def test_performance(self, wide_df: pd.DataFrame) -> None:
        start = time.perf_counter()
        inspect_one("df", wide_df, max_items=20)
        elapsed_ms = (time.perf_counter() - start) * 1000
        assert elapsed_ms < 20, f"Wide DataFrame took {elapsed_ms:.2f}ms"


class TestGroupBy:
    def test_groupby_not_crash(self, groupby_obj: pd.core.groupby.DataFrameGroupBy) -> None:
        """GroupBy objects should not crash the inspector."""
        info = inspect_one("grouped", groupby_obj)
        assert info["name"] == "grouped"
        assert "type" in info
        assert "GroupBy" in info["type"] or "DataFrameGroupBy" in info["type"]

    def test_groupby_has_length(self, groupby_obj: pd.core.groupby.DataFrameGroupBy) -> None:
        info = inspect_one("grouped", groupby_obj)
        # GroupBy supports len() — returns number of groups
        assert info.get("length") == 3

    def test_groupby_summary(self, groupby_obj: pd.core.groupby.DataFrameGroupBy) -> None:
        s = summarize_one("grouped", groupby_obj)
        assert "GroupBy" in s or "DataFrameGroupBy" in s


class TestSparseDtype:
    def test_sparse_columns(self, sparse_df: pd.DataFrame) -> None:
        info = inspect_one("df", sparse_df)
        dtypes = {c["name"]: c["dtype"] for c in info["columns"]}
        assert "Sparse" in dtypes["sparse_col"]

    def test_shape(self, sparse_df: pd.DataFrame) -> None:
        info = inspect_one("df", sparse_df)
        assert info["shape"] == [8, 2]


class TestMixedDtypes:
    """Simulates a real CSV read with mixed types, NaNs, datetimes."""

    def test_captures_all_dtypes(self, mixed_dtypes_df: pd.DataFrame) -> None:
        info = inspect_one("df", mixed_dtypes_df)
        dtypes = {c["name"]: c["dtype"] for c in info["columns"]}
        assert dtypes["id"] == "int64"
        assert dtypes["active"] == "bool"
        assert "datetime64" in dtypes["created_at"]
        assert dtypes["category"] == "category"

    def test_summary_readable(self, mixed_dtypes_df: pd.DataFrame) -> None:
        s = summarize_one("df", mixed_dtypes_df)
        assert "5" in s  # 5 rows
        assert "6" in s  # 6 cols

    def test_memory_reported(self, mixed_dtypes_df: pd.DataFrame) -> None:
        info = inspect_one("df", mixed_dtypes_df)
        assert "memory_bytes" in info
        assert info["memory_bytes"] > 0

    def test_performance(self, mixed_dtypes_df: pd.DataFrame) -> None:
        start = time.perf_counter()
        inspect_one("df", mixed_dtypes_df)
        elapsed_ms = (time.perf_counter() - start) * 1000
        assert elapsed_ms < 5


class TestPandasSeries:
    """Additional Series patterns beyond the basic test."""

    def test_datetime_series(self) -> None:
        s = pd.Series(pd.date_range("2024-01-01", periods=10), name="dates")
        info = inspect_one("s", s)
        assert info["type"] == "Series"
        assert "datetime64" in info["dtype"]
        assert info["series_name"] == "dates"

    def test_categorical_series(self) -> None:
        s = pd.Series(pd.Categorical(["A", "B", "A", "C"]), name="cats")
        info = inspect_one("s", s)
        assert info["dtype"] == "category"

    def test_nullable_int_series(self) -> None:
        s = pd.Series(pd.array([1, 2, None], dtype=pd.Int64Dtype()), name="nullable")
        info = inspect_one("s", s)
        assert info["dtype"] == "Int64"
