"""Tests for numpy ndarray inspection."""

from __future__ import annotations

import numpy as np

from variable_inspector.inspector import inspect_one, summarize_one


class TestNumpyNdarray:
    def test_basic(self, np_array: np.ndarray) -> None:
        info = inspect_one("arr", np_array)
        assert info["type"] == "ndarray"
        assert info["shape"] == [100, 50]
        assert info["dtype"] == "float64"
        assert info["ndim"] == 2
        assert info["nbytes"] == 100 * 50 * 8

    def test_summary(self, np_array: np.ndarray) -> None:
        s = summarize_one("arr", np_array)
        assert "ndarray" in s
        assert "float64" in s
        assert "(100, 50)" in s
