"""Output quality tests: verify inspector output is actually useful to agents.

These tests don't just check structure — they check that an agent reading the
output would understand what the variable is and how to work with it. Run this
file periodically as a quality audit.

    cd python && uv run pytest tests/test_output_quality.py -v
"""

from __future__ import annotations

import collections
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd
import polars as pl
import xarray as xr

from variable_inspector.inspector import inspect_one, list_user_variables, summarize_one

# ---------------------------------------------------------------------------
# pandas DataFrame: can an agent understand the schema?
# ---------------------------------------------------------------------------


class TestPandasOutputQuality:
    def test_mixed_dtypes_df_shows_all_column_info(self) -> None:
        """Agent needs to see every column name and dtype to write correct code."""
        df = pd.DataFrame(
            {
                "user_id": [1, 2, 3],
                "name": ["Alice", "Bob", "Charlie"],
                "score": [95.5, None, 87.0],
                "created": pd.to_datetime(["2024-01-01", "2024-02-01", "2024-03-01"]),
                "active": [True, False, True],
                "tier": pd.Categorical(["gold", "silver", "gold"]),
            }
        )
        info = inspect_one("df", df)

        # Agent must see shape
        assert info["shape"] == [3, 6]

        # Agent must see EVERY column with its dtype
        dtypes = {c["name"]: c["dtype"] for c in info["columns"]}
        assert dtypes["user_id"] == "int64"
        assert dtypes["score"] == "float64"
        assert "datetime64" in dtypes["created"]
        assert dtypes["active"] == "bool"
        assert dtypes["tier"] == "category"

        # Memory should be reported
        assert info["memory_bytes"] > 0

    def test_multiindex_shows_index_structure(self) -> None:
        """Agent must know index is MultiIndex and see level names."""
        idx = pd.MultiIndex.from_tuples(
            [("2024-Q1", "A"), ("2024-Q1", "B"), ("2024-Q2", "A")],
            names=["quarter", "group"],
        )
        df = pd.DataFrame({"value": [10, 20, 30]}, index=idx)
        info = inspect_one("df", df)

        # Must distinguish MultiIndex from plain index
        assert info.get("index_type") == "MultiIndex"
        assert info.get("index_names") == ["quarter", "group"]
        assert info.get("index_nlevels") == 2

    def test_datetime_index_shows_freq(self) -> None:
        """Agent needs to know the index is datetime-typed."""
        idx = pd.date_range("2024-01-01", periods=100, freq="h")
        df = pd.DataFrame({"temp": np.random.randn(100)}, index=idx)
        info = inspect_one("df", df)
        assert "datetime64" in info["index_dtype"]

    def test_summary_readable_for_listing(self) -> None:
        """Summary must be concise enough for a variable listing."""
        df = pd.DataFrame({f"col_{i}": range(100) for i in range(50)})
        s = summarize_one("df", df, max_items=20)
        # Should not be excessively long
        assert len(s) < 300, f"Summary too long ({len(s)} chars): {s[:100]}..."
        # But must contain shape
        assert "100" in s
        assert "50" in s


# ---------------------------------------------------------------------------
# polars: agent must see schema without triggering collect
# ---------------------------------------------------------------------------


class TestPolarsOutputQuality:
    def test_lazyframe_shows_schema_without_rows(self) -> None:
        """Agent sees output columns but knows data isn't materialized."""
        lf = (
            pl.DataFrame({"x": range(1000), "cat": ["A", "B"] * 500})
            .lazy()
            .filter(pl.col("x") > 500)
            .group_by("cat")
            .agg(pl.col("x").mean().alias("avg_x"))
        )
        info = inspect_one("lf", lf)
        assert info["lazy"] is True
        col_names = [c["name"] for c in info["columns"]]
        assert "cat" in col_names
        assert "avg_x" in col_names

    def test_eager_vs_lazy_distinguishable(self) -> None:
        """Agent must be able to tell eager from lazy at a glance."""
        df = pl.DataFrame({"x": [1, 2, 3]})
        lf = df.lazy()

        info_eager = inspect_one("df", df)
        info_lazy = inspect_one("lf", lf)

        assert "lazy" not in info_eager or info_eager.get("lazy") is not True
        assert info_lazy["lazy"] is True
        assert info_eager["type"] == "polars.DataFrame"
        assert info_lazy["type"] == "polars.LazyFrame"


# ---------------------------------------------------------------------------
# numpy: agent must understand shape, dtype, and memory
# ---------------------------------------------------------------------------


class TestNumpyOutputQuality:
    def test_structured_array_shows_fields(self) -> None:
        """Agent needs to see field names and types for structured arrays."""
        dt = np.dtype([("name", "U10"), ("age", "i4"), ("weight", "f8")])
        arr = np.array([("Alice", 25, 65.5), ("Bob", 30, 75.2)], dtype=dt)
        info = inspect_one("people", arr)

        # dtype string must contain field info
        assert "name" in info["dtype"]
        assert "age" in info["dtype"]
        assert "weight" in info["dtype"]

    def test_high_dim_shape_readable(self) -> None:
        """Agent must see full shape for N-D arrays."""
        arr = np.zeros((2, 3, 4, 5, 6))
        info = inspect_one("tensor", arr)
        assert info["shape"] == [2, 3, 4, 5, 6]
        assert info["ndim"] == 5

        s = summarize_one("tensor", arr)
        assert "(2, 3, 4, 5, 6)" in s


# ---------------------------------------------------------------------------
# xarray: agent must understand dimensions and variables
# ---------------------------------------------------------------------------


class TestXarrayOutputQuality:
    def test_dataset_shows_dims_and_vars(self) -> None:
        """Agent must see dimension sizes and variable names."""
        ds = xr.Dataset(
            {
                "temp": (["time", "lat", "lon"], np.zeros((100, 10, 20))),
                "precip": (["time", "lat", "lon"], np.ones((100, 10, 20))),
            },
            coords={"time": np.arange(100), "lat": np.linspace(-90, 90, 10)},
        )
        info = inspect_one("ds", ds)

        assert info["dims"]["time"] == 100
        assert info["dims"]["lat"] == 10
        assert info["dims"]["lon"] == 20
        # data_vars is now a list of dicts with 'name' and 'dtype'
        var_names = [v["name"] for v in info["data_vars"]]
        assert "temp" in var_names
        assert "precip" in var_names
        # Check dtypes are included
        dtypes = {v["name"]: v["dtype"] for v in info["data_vars"]}
        assert dtypes["temp"] == "float64"
        assert dtypes["precip"] == "float64"
        assert "time" in info["coords"]

    def test_dataarray_shows_dim_names_and_sizes(self) -> None:
        """Agent must be able to see what each dimension means."""
        da = xr.DataArray(
            np.zeros((10, 20)),
            dims=["time", "space"],
            coords={"time": np.arange(10)},
        )
        info = inspect_one("da", da)
        assert info["dims"] == {"time": 10, "space": 20}
        assert info["dtype"] == "float64"

    def test_datatree_shows_hierarchy(self) -> None:
        """Agent must understand the tree structure."""
        tree = xr.DataTree.from_dict(
            {
                "/": xr.Dataset({"global_var": (["x"], [1, 2])}),
                "/sensors": xr.Dataset({"reading": (["t"], [10, 20, 30])}),
                "/sensors/calibration": xr.Dataset({"offset": (["t"], [0.1, 0.2, 0.3])}),
            }
        )
        info = inspect_one("tree", tree)
        assert "sensors" in info["children"]
        assert info["total_nodes"] >= 3

        s = summarize_one("tree", tree)
        assert "3 nodes" in s


# ---------------------------------------------------------------------------
# dict of DataFrames: agent must understand contents without verbosity
# ---------------------------------------------------------------------------


class TestDictOutputQuality:
    def test_dict_of_dfs_shows_shapes(self) -> None:
        """Agent needs to know what's inside dict values without full repr."""
        data = {
            "train": pd.DataFrame({"x": range(1000), "y": range(1000)}),
            "test": pd.DataFrame({"x": range(200), "y": range(200)}),
        }
        info = inspect_one("splits", data)

        assert info["keys"] == ["train", "test"]
        # Value previews should exist and be informative
        assert "values_preview" in info
        # Preview should mention DataFrame, not dump rows
        for key in ["train", "test"]:
            preview = info["values_preview"][key]
            assert "DataFrame" in preview

    def test_dict_summary_shows_keys(self) -> None:
        """One-line summary must list key names."""
        d = {"learning_rate": 0.001, "epochs": 100, "batch_size": 32}
        s = summarize_one("config", d)
        assert "learning_rate" in s
        assert "epochs" in s
        assert "batch_size" in s


# ---------------------------------------------------------------------------
# Generic handler: unknown types must still give useful info
# ---------------------------------------------------------------------------


class TestGenericOutputQuality:
    def test_custom_class_shows_type_and_repr(self) -> None:
        """Agent must at least know the type and see repr for unknown objects."""

        @dataclass
        class ModelConfig:
            name: str = "RandomForest"
            n_estimators: int = 100
            max_depth: int = 10

        cfg = ModelConfig()
        info = inspect_one("cfg", cfg)
        assert info["type"] == "ModelConfig"
        assert "repr" in info
        assert "RandomForest" in info["repr"]

    def test_path_useful(self) -> None:
        p = Path("/data/experiments/run_42/results.csv")
        info = inspect_one("p", p)
        assert "Path" in info["type"]
        assert "results.csv" in info["repr"]

    def test_counter_shows_keys(self) -> None:
        """Counter (dict subclass) should show its type, not just 'dict'."""
        c = collections.Counter("abracadabra")
        info = inspect_one("c", c)
        assert info["type"] == "Counter"
        assert info["length"] == 5


# ---------------------------------------------------------------------------
# list_user_variables: mixed namespace quality check
# ---------------------------------------------------------------------------


class TestVariableListingQuality:
    def test_schema_mode_orients_agent(self) -> None:
        """Schema mode summaries must give enough info to understand each variable."""
        ns = {
            "df": pd.DataFrame({"x": range(100), "y": range(100), "label": ["A"] * 100}),
            "model_params": {"lr": 0.001, "epochs": 50},
            "arr": np.zeros((28, 28)),
            "name": "experiment_42",
            "n_classes": 10,
            "ds": xr.Dataset({"temp": (["time"], np.zeros(365))}),
        }
        result = list_user_variables(ns, detail="schema")

        # Every summary should be a useful one-liner
        for s in result:
            assert isinstance(s, str)
            assert len(s) > 5, f"Summary too short to be useful: {s!r}"
            assert len(s) < 300, f"Summary too long: {s!r}"

        # Check specific summaries contain key info
        summaries = {s.split(":")[0]: s for s in result}
        assert "100" in summaries["df"]  # row count
        assert "lr" in summaries["model_params"]  # key name
        assert "(28, 28)" in summaries["arr"]  # shape
        assert "experiment_42" in summaries["name"]  # value
        assert "10" in summaries["n_classes"]  # value
        assert "time" in summaries["ds"]  # dimension name

    def test_full_mode_gives_structured_data(self) -> None:
        """Full mode must return structured dicts, not strings."""
        ns = {
            "df": pd.DataFrame({"a": [1, 2], "b": [3, 4]}),
            "x": 42,
        }
        result = list_user_variables(ns, detail="full")
        assert all(isinstance(r, dict) for r in result)
        df_info = next(r for r in result if r["name"] == "df")
        assert "columns" in df_info
        assert "shape" in df_info
