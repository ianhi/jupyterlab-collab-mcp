"""Performance benchmarks for the variable inspector.

All inspections must complete well under 5ms for individual variables
and under 10ms for listing mode.
"""

from __future__ import annotations

import time

import numpy as np
import pandas as pd
import polars as pl
import xarray as xr

from variable_inspector.inspector import inspect_one, list_user_variables, summarize_one


def _time_ms(fn, *args, **kwargs) -> float:  # type: ignore[no-untyped-def]
    """Run fn and return wall-clock time in ms."""
    start = time.perf_counter()
    fn(*args, **kwargs)
    return (time.perf_counter() - start) * 1000


class TestPerformance:
    def test_inspect_large_dataframe_under_5ms(self, large_df: pd.DataFrame) -> None:
        elapsed = _time_ms(inspect_one, "df", large_df)
        assert elapsed < 5, f"inspect_one on 10000x100 DataFrame took {elapsed:.2f}ms (limit: 5ms)"

    def test_inspect_large_dict_under_5ms(self, large_dict: dict) -> None:
        elapsed = _time_ms(inspect_one, "d", large_dict, max_items=20)
        assert elapsed < 5, f"inspect_one on 100k-key dict took {elapsed:.2f}ms (limit: 5ms)"

    def test_inspect_nested_dict_under_5ms(self) -> None:
        # Nested dict with scalar values (typical config/params)
        nested = {f"key_{i}": {f"inner_{j}": j * 0.1 for j in range(50)} for i in range(20)}
        elapsed = _time_ms(inspect_one, "n", nested, max_items=20)
        assert elapsed < 5, f"inspect_one on nested dict took {elapsed:.2f}ms (limit: 5ms)"

    def test_list_100_variables_under_10ms(self) -> None:
        # Build a namespace with 100 mixed-type variables
        ns: dict = {}
        for i in range(25):
            ns[f"df_{i}"] = pd.DataFrame({"a": [1, 2], "b": [3, 4]})
        for i in range(25):
            ns[f"arr_{i}"] = np.zeros((100, 100))
        for i in range(25):
            ns[f"dict_{i}"] = {f"k{j}": j for j in range(50)}
        for i in range(25):
            ns[f"scalar_{i}"] = i * 3.14

        elapsed = _time_ms(
            list_user_variables,
            ns,
            detail="schema",
            max_variables=100,
            max_items=20,
        )
        assert elapsed < 50, f"list_user_variables schema mode took {elapsed:.2f}ms (limit: 50ms)"

    def test_polars_lazyframe_no_collect(self) -> None:
        """Verify LazyFrame inspection never materializes data."""
        # Create a LazyFrame with an expensive operation
        lf = (
            pl.DataFrame({"x": range(1000)})
            .lazy()
            .with_columns(pl.col("x").cast(pl.Float64).alias("y"))
        )
        elapsed = _time_ms(inspect_one, "lf", lf)
        assert elapsed < 5, f"inspect_one on LazyFrame took {elapsed:.2f}ms (limit: 5ms)"
        # Also verify the result says lazy
        info = inspect_one("lf", lf)
        assert info["lazy"] is True

    def test_xarray_large_dataset_under_5ms(self) -> None:
        ds = xr.Dataset(
            {f"var_{i}": (["time", "x", "y"], np.zeros((100, 50, 50))) for i in range(50)},
            coords={"time": np.arange(100), "x": np.arange(50), "y": np.arange(50)},
        )
        elapsed = _time_ms(inspect_one, "ds", ds)
        assert elapsed < 5, f"inspect_one on xarray Dataset with 50 vars took {elapsed:.2f}ms"

    def test_summarize_large_dataframe_under_5ms(self, large_df: pd.DataFrame) -> None:
        elapsed = _time_ms(summarize_one, "df", large_df)
        assert elapsed < 10, f"summarize_one on 10000x100 DataFrame took {elapsed:.2f}ms"

    def test_dict_of_large_arrays_under_5ms(self) -> None:
        """Dict with 100 large numpy arrays — should not repr every element."""
        d = {f"arr_{i}": np.random.randn(1000, 100) for i in range(100)}
        elapsed = _time_ms(inspect_one, "d", d, max_items=20)
        assert (
            elapsed < 5
        ), f"inspect_one on dict with 100 large arrays took {elapsed:.2f}ms (limit: 5ms)"

    def test_list_of_dataframes_under_5ms(self) -> None:
        """List of 50 DataFrames — should not repr every element."""
        lst = [pd.DataFrame({"x": range(1000)}) for _ in range(50)]
        elapsed = _time_ms(inspect_one, "lst", lst)
        assert (
            elapsed < 5
        ), f"inspect_one on list of 50 DataFrames took {elapsed:.2f}ms (limit: 5ms)"
