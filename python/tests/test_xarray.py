"""Tests for xarray Dataset, DataArray, and DataTree inspection."""

from __future__ import annotations

import xarray as xr

from variable_inspector.inspector import inspect_one, summarize_one


class TestXarrayDataset:
    def test_basic(self, xr_dataset: xr.Dataset) -> None:
        info = inspect_one("ds", xr_dataset)
        assert "xarray" in info["type"]
        assert "dims" in info
        assert "time" in info["dims"]
        assert "data_vars" in info
        # data_vars is now a list of dicts with 'name' and 'dtype'
        var_names = [v["name"] for v in info["data_vars"]]
        assert "temp" in var_names

    def test_summary(self, xr_dataset: xr.Dataset) -> None:
        s = summarize_one("ds", xr_dataset)
        assert "xarray.Dataset" in s
        assert "time:" in s
        assert "temp" in s


class TestXarrayDataArray:
    def test_basic(self, xr_dataarray: xr.DataArray) -> None:
        info = inspect_one("da", xr_dataarray)
        assert "xarray" in info["type"]
        assert "dims" in info
        assert "lat" in info["dims"]
        assert info["dtype"] == "float64"

    def test_summary(self, xr_dataarray: xr.DataArray) -> None:
        s = summarize_one("da", xr_dataarray)
        assert "xarray.DataArray" in s


class TestXarrayDataTree:
    def test_basic(self, xr_datatree: xr.DataTree) -> None:
        info = inspect_one("tree", xr_datatree)
        assert "xarray" in info["type"]
        assert "children" in info
        assert "north" in info["children"]
        assert "south" in info["children"]
        assert info.get("total_nodes", 0) >= 3

    def test_summary(self, xr_datatree: xr.DataTree) -> None:
        s = summarize_one("tree", xr_datatree)
        assert "xarray.DataTree" in s
        assert "3 nodes" in s
