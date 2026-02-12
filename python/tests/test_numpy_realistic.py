"""Realistic numpy patterns: structured arrays, masked arrays, 0-d, edge dtypes."""

from __future__ import annotations

import time

import numpy as np
import numpy.ma as ma

from variable_inspector.inspector import inspect_one, summarize_one

# ---------------------------------------------------------------------------
# Structured arrays
# ---------------------------------------------------------------------------


class TestStructuredArrays:
    def test_basic_structured(self) -> None:
        dt = np.dtype([("name", "U10"), ("age", "i4"), ("weight", "f8")])
        arr = np.array([("Alice", 25, 65.5), ("Bob", 30, 75.2)], dtype=dt)
        info = inspect_one("people", arr)
        assert info["type"] == "ndarray"
        assert info["shape"] == [2]
        assert info["ndim"] == 2 or info["ndim"] == 1  # 1D structured
        # dtype string should contain field names or describe the structure
        assert info["dtype"] is not None
        assert info["nbytes"] is not None
        assert info["nbytes"] > 0

    def test_structured_summary(self) -> None:
        dt = np.dtype([("x", "f8"), ("y", "f8")])
        arr = np.array([(1.0, 2.0), (3.0, 4.0)], dtype=dt)
        s = summarize_one("pts", arr)
        assert "ndarray" in s
        assert "(2,)" in s

    def test_performance(self) -> None:
        dt = np.dtype([("id", "i4"), ("values", "f8", (100,))])
        arr = np.zeros(1000, dtype=dt)
        start = time.perf_counter()
        inspect_one("big", arr)
        elapsed_ms = (time.perf_counter() - start) * 1000
        assert elapsed_ms < 5


# ---------------------------------------------------------------------------
# Masked arrays
# ---------------------------------------------------------------------------


class TestMaskedArrays:
    def test_basic_masked(self) -> None:
        data = np.array([1.5, 2.5, 3.5, 4.5, 5.5])
        mask = np.array([False, False, True, False, False])
        arr = ma.array(data, mask=mask)
        info = inspect_one("masked", arr)
        assert info["name"] == "masked"
        # MaskedArray has type name 'MaskedArray' — goes through generic handler
        assert "MaskedArray" in info["type"] or "ndarray" in info["type"]
        # Should still have shape and dtype via generic handler
        if "shape" in info:
            assert info["shape"] == [5]
        if "dtype" in info:
            assert info["dtype"] == "float64"

    def test_2d_masked(self) -> None:
        data = np.arange(12).reshape(3, 4)
        mask = np.zeros((3, 4), dtype=bool)
        mask[1, 2] = True
        arr = ma.array(data, mask=mask)
        info = inspect_one("m2d", arr)
        assert info["name"] == "m2d"
        if "shape" in info:
            assert info["shape"] == [3, 4]

    def test_all_masked(self) -> None:
        arr = ma.array([1.0, 2.0, 3.0], mask=True)
        info = inspect_one("all_m", arr)
        assert info["name"] == "all_m"
        assert "type" in info

    def test_summary(self) -> None:
        arr = ma.array([1, 2, 3], mask=[False, True, False])
        s = summarize_one("m", arr)
        assert "MaskedArray" in s or "ndarray" in s

    def test_performance(self) -> None:
        data = np.random.randn(10000)
        mask = np.random.random(10000) > 0.9
        arr = ma.array(data, mask=mask)
        start = time.perf_counter()
        inspect_one("big_mask", arr)
        elapsed_ms = (time.perf_counter() - start) * 1000
        assert elapsed_ms < 5


# ---------------------------------------------------------------------------
# 0-dimensional arrays (scalars)
# ---------------------------------------------------------------------------


class TestScalarArrays:
    def test_0d_int(self) -> None:
        arr = np.array(42)
        info = inspect_one("scalar", arr)
        assert info["type"] == "ndarray"
        assert info["shape"] == []
        assert info["ndim"] == 0

    def test_0d_float(self) -> None:
        arr = np.array(3.14)
        info = inspect_one("pi", arr)
        assert info["shape"] == []
        assert info["dtype"] == "float64"

    def test_0d_complex(self) -> None:
        arr = np.array(1 + 2j)
        info = inspect_one("z", arr)
        assert info["shape"] == []
        assert "complex" in info["dtype"]

    def test_0d_string(self) -> None:
        arr = np.array("hello")
        info = inspect_one("s", arr)
        assert info["shape"] == []
        assert "U" in info["dtype"]

    def test_summary(self) -> None:
        arr = np.array(42)
        s = summarize_one("n", arr)
        assert "ndarray" in s
        assert "()" in s


# ---------------------------------------------------------------------------
# Complex dtypes
# ---------------------------------------------------------------------------


class TestComplexDtypes:
    def test_complex64(self) -> None:
        arr = np.array([1 + 2j, 3 + 4j], dtype=np.complex64)
        info = inspect_one("c64", arr)
        assert info["dtype"] == "complex64"
        assert info["nbytes"] == 2 * 8  # 2 elements * 8 bytes each

    def test_complex128(self) -> None:
        arr = np.array([1 + 2j, 3 + 4j], dtype=np.complex128)
        info = inspect_one("c128", arr)
        assert info["dtype"] == "complex128"
        assert info["nbytes"] == 2 * 16


# ---------------------------------------------------------------------------
# Object arrays
# ---------------------------------------------------------------------------


class TestObjectArrays:
    def test_object_array(self) -> None:
        arr = np.array(["hello", 42, [1, 2, 3]], dtype=object)
        info = inspect_one("obj", arr)
        assert info["type"] == "ndarray"
        assert info["dtype"] == "object"
        assert info["shape"] == [3]

    def test_object_array_performance(self) -> None:
        """Object arrays with heavy elements must not repr each element."""
        heavy = np.array([np.zeros(1000) for _ in range(100)], dtype=object)
        start = time.perf_counter()
        inspect_one("heavy", heavy)
        elapsed_ms = (time.perf_counter() - start) * 1000
        assert elapsed_ms < 5, f"Object array took {elapsed_ms:.2f}ms"


# ---------------------------------------------------------------------------
# High-dimensional arrays
# ---------------------------------------------------------------------------


class TestHighDimensional:
    def test_6d_array(self) -> None:
        arr = np.zeros((2, 2, 2, 2, 2, 2))
        info = inspect_one("a6d", arr)
        assert info["shape"] == [2, 2, 2, 2, 2, 2]
        assert info["ndim"] == 6
        assert info["nbytes"] == 64 * 8

    def test_5d_irregular(self) -> None:
        arr = np.ones((3, 4, 5, 2, 6), dtype=np.float32)
        info = inspect_one("a5d", arr)
        assert info["shape"] == [3, 4, 5, 2, 6]
        assert info["ndim"] == 5

    def test_summary_high_dim(self) -> None:
        arr = np.zeros((2, 3, 4, 5))
        s = summarize_one("hd", arr)
        assert "ndarray" in s
        assert "(2, 3, 4, 5)" in s


# ---------------------------------------------------------------------------
# Record arrays
# ---------------------------------------------------------------------------


class TestRecordArrays:
    def test_recarray(self) -> None:
        dt = np.dtype([("name", "U10"), ("age", "i4")])
        arr = np.rec.array([("Alice", 25), ("Bob", 30)], dtype=dt)
        info = inspect_one("rec", arr)
        assert info["name"] == "rec"
        # recarray is a subclass of ndarray — might go through generic handler
        assert "recarray" in info["type"] or "ndarray" in info["type"]
        if "shape" in info:
            assert info["shape"] == [2]

    def test_recarray_summary(self) -> None:
        dt = np.dtype([("x", "f8"), ("y", "f8")])
        arr = np.rec.array([(1.0, 2.0), (3.0, 4.0)], dtype=dt)
        s = summarize_one("pts", arr)
        # Should get some useful output
        assert len(s) > 0


# ---------------------------------------------------------------------------
# String arrays
# ---------------------------------------------------------------------------


class TestStringArrays:
    def test_unicode_fixed(self) -> None:
        arr = np.array(["hello", "world", "foo"], dtype="U5")
        info = inspect_one("strs", arr)
        assert info["type"] == "ndarray"
        assert "U" in info["dtype"]
        assert info["shape"] == [3]

    def test_byte_strings(self) -> None:
        arr = np.array([b"hello", b"world"], dtype="S5")
        info = inspect_one("bstrs", arr)
        assert "S" in info["dtype"]


# ---------------------------------------------------------------------------
# Boolean arrays
# ---------------------------------------------------------------------------


class TestBooleanArrays:
    def test_bool_array(self) -> None:
        arr = np.array([True, False, True, False, True])
        info = inspect_one("mask", arr)
        assert info["dtype"] == "bool"
        assert info["shape"] == [5]
        assert info["nbytes"] == 5  # 1 byte per bool

    def test_bool_from_comparison(self) -> None:
        arr = np.arange(10) > 5
        info = inspect_one("gt5", arr)
        assert info["dtype"] == "bool"
        assert info["shape"] == [10]


# ---------------------------------------------------------------------------
# Empty arrays
# ---------------------------------------------------------------------------


class TestEmptyArrays:
    def test_empty_1d(self) -> None:
        arr = np.array([], dtype=np.float64)
        info = inspect_one("empty", arr)
        assert info["shape"] == [0]
        assert info["nbytes"] == 0

    def test_empty_2d(self) -> None:
        arr = np.zeros((0, 5))
        info = inspect_one("empty2d", arr)
        assert info["shape"] == [0, 5]
        assert info["nbytes"] == 0


# ---------------------------------------------------------------------------
# Fortran-order and views
# ---------------------------------------------------------------------------


class TestMemoryLayout:
    def test_fortran_order(self) -> None:
        arr = np.asfortranarray(np.zeros((10, 20)))
        info = inspect_one("fort", arr)
        assert info["type"] == "ndarray"
        assert info["shape"] == [10, 20]
        assert info["nbytes"] == 10 * 20 * 8

    def test_view(self) -> None:
        original = np.zeros(100)
        view = original[10:20]
        info = inspect_one("v", view)
        assert info["shape"] == [10]
        # nbytes for the view is the view's nbytes (not the original)
        assert info["nbytes"] == 10 * 8
