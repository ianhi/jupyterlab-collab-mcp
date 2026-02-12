"""Realistic xarray patterns: attrs, non-dim coords, deep DataTree, encoding."""

from __future__ import annotations

import time

import numpy as np
import xarray as xr

from variable_inspector.inspector import inspect_one, summarize_one

# ---------------------------------------------------------------------------
# Dataset with attributes and encoding
# ---------------------------------------------------------------------------


class TestDatasetWithAttrs:
    def test_attrs_preserved(self) -> None:
        ds = xr.Dataset(
            {"temp": (["time", "lat"], np.zeros((10, 5)))},
            coords={"time": np.arange(10), "lat": np.linspace(-90, 90, 5)},
            attrs={"title": "My Dataset", "history": "created for testing"},
        )
        info = inspect_one("ds", ds)
        assert info["type"] == "xarray.Dataset"
        assert "time" in info["dims"]
        assert "lat" in info["dims"]
        assert info["dims"]["time"] == 10
        assert info["dims"]["lat"] == 5

    def test_many_coords(self) -> None:
        """Dataset with coordinate variables beyond the dimensions."""
        ds = xr.Dataset(
            {"temp": (["time"], np.zeros(100))},
            coords={
                "time": np.arange(100),
                "time_label": ("time", [f"t{i}" for i in range(100)]),
                "time_float": ("time", np.linspace(0, 1, 100)),
            },
        )
        info = inspect_one("ds", ds)
        assert "time" in info["coords"]
        assert "time_label" in info["coords"]
        assert "time_float" in info["coords"]


# ---------------------------------------------------------------------------
# Dataset with many variables
# ---------------------------------------------------------------------------


class TestManyVariables:
    def test_truncation(self) -> None:
        """Dataset with more variables than max_items."""
        ds = xr.Dataset(
            {f"var_{i}": (["x"], np.zeros(10)) for i in range(50)},
            coords={"x": np.arange(10)},
        )
        info = inspect_one("ds", ds, max_items=10)
        # data_vars is now a list of dicts
        assert len(info["data_vars"]) == 10
        assert info["data_vars_truncated"] == 50

    def test_no_truncation_under_limit(self) -> None:
        ds = xr.Dataset(
            {"a": (["x"], [1, 2]), "b": (["x"], [3, 4])},
            coords={"x": [0, 1]},
        )
        info = inspect_one("ds", ds)
        # data_vars is now a list of dicts
        assert len(info["data_vars"]) == 2
        assert "data_vars_truncated" not in info

    def test_performance_50_vars(self) -> None:
        ds = xr.Dataset(
            {f"var_{i}": (["time", "x", "y"], np.zeros((100, 50, 50))) for i in range(50)},
            coords={"time": np.arange(100), "x": np.arange(50), "y": np.arange(50)},
        )
        start = time.perf_counter()
        inspect_one("ds", ds)
        elapsed_ms = (time.perf_counter() - start) * 1000
        assert elapsed_ms < 5, f"50-var xarray Dataset took {elapsed_ms:.2f}ms"


# ---------------------------------------------------------------------------
# DataArray patterns
# ---------------------------------------------------------------------------


class TestDataArrayRealistic:
    def test_named_dataarray(self) -> None:
        da = xr.DataArray(
            np.random.randn(10, 20),
            dims=["time", "space"],
            coords={"time": np.arange(10), "space": np.arange(20)},
            name="temperature",
        )
        info = inspect_one("da", da)
        assert info["type"] == "xarray.DataArray"
        assert info["dims"] == {"time": 10, "space": 20}
        assert info["dtype"] == "float64"

    def test_int_dataarray(self) -> None:
        da = xr.DataArray(np.arange(100).reshape(10, 10), dims=["x", "y"])
        info = inspect_one("da", da)
        assert info["dtype"] == "int64"
        assert info["dims"] == {"x": 10, "y": 10}

    def test_0d_dataarray(self) -> None:
        da = xr.DataArray(42.0)
        info = inspect_one("da", da)
        assert info["type"] == "xarray.DataArray"
        assert info["dtype"] == "float64"
        assert info["dims"] == {}

    def test_high_dim_dataarray(self) -> None:
        da = xr.DataArray(
            np.zeros((2, 3, 4, 5)),
            dims=["batch", "channel", "height", "width"],
        )
        info = inspect_one("da", da)
        assert info["dims"] == {"batch": 2, "channel": 3, "height": 4, "width": 5}

    def test_summary(self) -> None:
        da = xr.DataArray(
            np.zeros((10, 20)),
            dims=["x", "y"],
        )
        s = summarize_one("da", da)
        assert "xarray.DataArray" in s
        assert "float64" in s
        assert "x:10" in s
        assert "y:20" in s


# ---------------------------------------------------------------------------
# DataTree patterns
# ---------------------------------------------------------------------------


class TestDataTreeRealistic:
    def test_deep_tree(self) -> None:
        """Three-level deep tree."""
        tree = xr.DataTree.from_dict(
            {
                "/": xr.Dataset({"root_var": (["x"], [1, 2, 3])}),
                "/level1": xr.Dataset({"l1_var": (["x"], [4, 5, 6])}),
                "/level1/level2": xr.Dataset({"l2_var": (["x"], [7, 8, 9])}),
            }
        )
        info = inspect_one("tree", tree)
        assert info["type"] == "xarray.DataTree"
        assert "level1" in info["children"]
        assert info["total_nodes"] >= 3

    def test_wide_tree(self) -> None:
        """Tree with many children at one level."""
        children = {
            f"/station_{i}": xr.Dataset({"temp": (["time"], np.random.randn(10))})
            for i in range(20)
        }
        children["/"] = xr.Dataset()
        tree = xr.DataTree.from_dict(children)
        info = inspect_one("tree", tree, max_items=5)
        assert len(info["children"]) == 5
        # Should report truncation
        assert info.get("children_truncated", 0) >= 20

    def test_empty_tree(self) -> None:
        tree = xr.DataTree()
        info = inspect_one("tree", tree)
        assert info["type"] == "xarray.DataTree"

    def test_tree_summary(self) -> None:
        tree = xr.DataTree.from_dict(
            {
                "/": xr.Dataset(),
                "/a": xr.Dataset({"x": (["t"], [1, 2])}),
                "/b": xr.Dataset({"y": (["t"], [3, 4])}),
            }
        )
        s = summarize_one("tree", tree)
        assert "xarray.DataTree" in s
        assert "3 nodes" in s


# ---------------------------------------------------------------------------
# Mixed dtype datasets
# ---------------------------------------------------------------------------


class TestMixedDtypes:
    def test_string_and_numeric(self) -> None:
        ds = xr.Dataset(
            {
                "temp": (["time"], np.zeros(5, dtype="float32")),
                "label": (["time"], ["a", "b", "c", "d", "e"]),
            }
        )
        info = inspect_one("ds", ds)
        # data_vars is now a list of dicts with 'name' and 'dtype'
        var_names = [v["name"] for v in info["data_vars"]]
        assert "temp" in var_names
        assert "label" in var_names

    def test_complex_dtype(self) -> None:
        da = xr.DataArray(np.array([1 + 2j, 3 + 4j]), dims=["x"])
        info = inspect_one("da", da)
        assert "complex" in info["dtype"]


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------


class TestXarrayEdgeCases:
    def test_empty_dataset(self) -> None:
        ds = xr.Dataset()
        info = inspect_one("ds", ds)
        assert info["type"] == "xarray.Dataset"
        assert info["dims"] == {}
        assert info["data_vars"] == []

    def test_scalar_dataset(self) -> None:
        ds = xr.Dataset({"x": 42})
        info = inspect_one("ds", ds)
        assert info["type"] == "xarray.Dataset"
        # data_vars is now a list of dicts with 'name' and 'dtype'
        var_names = [v["name"] for v in info["data_vars"]]
        assert "x" in var_names

    def test_single_value_dataarray(self) -> None:
        da = xr.DataArray(np.array(3.14))
        info = inspect_one("da", da)
        assert info["dtype"] == "float64"

    def test_bool_dataarray(self) -> None:
        da = xr.DataArray([True, False, True], dims=["x"])
        info = inspect_one("da", da)
        assert info["dtype"] == "bool"


# ---------------------------------------------------------------------------
# Performance
# ---------------------------------------------------------------------------


class TestXarrayPerformance:
    def test_dataset_under_5ms(self) -> None:
        ds = xr.Dataset(
            {f"var_{i}": (["time", "x"], np.zeros((1000, 100))) for i in range(20)},
            coords={"time": np.arange(1000), "x": np.arange(100)},
        )
        start = time.perf_counter()
        inspect_one("ds", ds, max_items=20)
        elapsed_ms = (time.perf_counter() - start) * 1000
        assert elapsed_ms < 5

    def test_dataarray_under_5ms(self) -> None:
        da = xr.DataArray(
            np.zeros((100, 200, 50)),
            dims=["time", "x", "y"],
        )
        start = time.perf_counter()
        inspect_one("da", da)
        elapsed_ms = (time.perf_counter() - start) * 1000
        assert elapsed_ms < 5

    def test_datatree_under_5ms(self) -> None:
        children = {
            f"/group_{i}": xr.Dataset({f"var_{j}": (["x"], np.zeros(100)) for j in range(5)})
            for i in range(10)
        }
        children["/"] = xr.Dataset()
        tree = xr.DataTree.from_dict(children)
        start = time.perf_counter()
        inspect_one("tree", tree, max_items=20)
        elapsed_ms = (time.perf_counter() - start) * 1000
        assert elapsed_ms < 5

    def test_summary_under_5ms(self) -> None:
        ds = xr.Dataset(
            {f"var_{i}": (["time", "x"], np.zeros((500, 200))) for i in range(30)},
        )
        start = time.perf_counter()
        summarize_one("ds", ds, max_items=20)
        elapsed_ms = (time.perf_counter() - start) * 1000
        assert elapsed_ms < 5
