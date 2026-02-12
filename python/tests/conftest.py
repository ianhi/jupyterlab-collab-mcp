"""Fixtures for variable inspector tests."""

from __future__ import annotations

import numpy as np
import pandas as pd
import polars as pl
import pytest
import xarray as xr

# ---------------------------------------------------------------------------
# pandas fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def small_df() -> pd.DataFrame:
    return pd.DataFrame({"id": [1, 2, 3], "name": ["a", "b", "c"], "score": [1.0, 2.0, 3.0]})


@pytest.fixture
def large_df() -> pd.DataFrame:
    """10000 rows x 100 columns."""
    data = {f"col_{i}": np.random.randn(10000) for i in range(100)}
    return pd.DataFrame(data)


@pytest.fixture
def small_series() -> pd.Series:
    return pd.Series([1, 2, 3], name="values", dtype="int64")


# ---------------------------------------------------------------------------
# polars fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def polars_df() -> pl.DataFrame:
    return pl.DataFrame({"x": [1, 2, 3], "y": [4.0, 5.0, 6.0], "z": ["a", "b", "c"]})


@pytest.fixture
def polars_lazy() -> pl.LazyFrame:
    return pl.DataFrame({"a": [1, 2], "b": [3.0, 4.0]}).lazy()


@pytest.fixture
def polars_series() -> pl.Series:
    return pl.Series("vals", [10, 20, 30])


# ---------------------------------------------------------------------------
# numpy fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def np_array() -> np.ndarray:
    return np.zeros((100, 50), dtype=np.float64)


@pytest.fixture
def large_np_array() -> np.ndarray:
    return np.random.randn(10000, 100)


# ---------------------------------------------------------------------------
# xarray fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def xr_dataset() -> xr.Dataset:
    return xr.Dataset(
        {
            "temp": (["time", "x"], np.random.randn(365, 100)),
            "precip": (["time", "x"], np.random.randn(365, 100)),
        },
        coords={"time": np.arange(365), "x": np.arange(100)},
    )


@pytest.fixture
def xr_datatree() -> xr.DataTree:
    return xr.DataTree.from_dict(
        {
            "/": xr.Dataset({"global_temp": (["time"], np.random.randn(100))}),
            "/north": xr.Dataset({"temp": (["time", "lat"], np.random.randn(100, 50))}),
            "/south": xr.Dataset({"temp": (["time", "lat"], np.random.randn(100, 50))}),
        }
    )


@pytest.fixture
def xr_dataarray() -> xr.DataArray:
    return xr.DataArray(
        np.random.randn(10, 20),
        dims=["lat", "lon"],
        coords={"lat": np.arange(10), "lon": np.arange(20)},
    )


# ---------------------------------------------------------------------------
# dict / nested fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def nested_dict() -> dict:
    return {
        "level1_a": {"level2_a": [1, 2, 3], "level2_b": {"level3": "deep"}},
        "level1_b": np.zeros((5, 5)),
        "scalar": 42,
    }


@pytest.fixture
def large_dict() -> dict:
    """Dict with 100k keys."""
    return {f"key_{i}": i for i in range(100_000)}


@pytest.fixture
def mixed_namespace(
    small_df: pd.DataFrame,
    np_array: np.ndarray,
    polars_df: pl.DataFrame,
    xr_dataset: xr.Dataset,
    nested_dict: dict,
) -> dict:
    """Simulates a realistic kernel namespace."""
    return {
        "df": small_df,
        "arr": np_array,
        "pdf": polars_df,
        "ds": xr_dataset,
        "config": nested_dict,
        "count": 42,
        "name": "experiment_1",
        "results": [1.0, 2.0, 3.0],
        # Things that should be filtered out:
        "_private": "hidden",
        "np": np,
        "pd": pd,
    }
