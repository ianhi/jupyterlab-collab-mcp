"""Edge cases: broken objects, exotic types, and the generic fallback handler.

Tests that the inspector never crashes and gives useful output for objects
from libraries we haven't special-cased (matplotlib, sklearn, etc.) as well
as pathological Python objects.
"""

from __future__ import annotations

import collections
import datetime
import enum
import re
import time
from dataclasses import dataclass
from decimal import Decimal
from fractions import Fraction
from pathlib import Path
from typing import NamedTuple

import numpy as np
import pandas as pd

from variable_inspector.inspector import inspect_one, list_user_variables, summarize_one


# ---------------------------------------------------------------------------
# Edge-case objects
# ---------------------------------------------------------------------------


class BrokenGetattr:
    """Object where getattr raises on every attribute."""

    def __getattr__(self, name: str) -> None:
        raise RuntimeError(f"Cannot access {name}")


class BrokenReprAndLen:
    """Object with broken repr AND len."""

    def __repr__(self) -> str:
        raise ValueError("repr exploded")

    def __len__(self) -> int:
        raise TypeError("len exploded")


class SlowRepr:
    """Object with repr that would be slow if not capped."""

    def __repr__(self) -> str:
        # Simulate slow repr by building a huge string
        return "x" * 100_000


class NegativeLen:
    """Object with negative __len__ (yes, this is possible)."""

    def __len__(self) -> int:
        return -1


class NonStringRepr:
    """Object whose __repr__ returns non-string (pathological)."""

    def __repr__(self) -> int:  # type: ignore[override]
        return 42  # type: ignore[return-value]


class CircularDict(dict):
    """Dict that contains itself."""

    pass


class Color(enum.Enum):
    RED = 1
    GREEN = 2
    BLUE = 3


class Priority(enum.IntEnum):
    LOW = 1
    MEDIUM = 2
    HIGH = 3


class Point(NamedTuple):
    x: float
    y: float


@dataclass
class Config:
    host: str = "localhost"
    port: int = 8080
    debug: bool = False


# ---------------------------------------------------------------------------
# Tests — broken objects must never crash
# ---------------------------------------------------------------------------


class TestBrokenObjects:
    def test_broken_getattr(self) -> None:
        obj = BrokenGetattr()
        info = inspect_one("bad", obj)
        assert info["name"] == "bad"
        assert "type" in info

    def test_broken_repr_and_len(self) -> None:
        obj = BrokenReprAndLen()
        info = inspect_one("bad", obj)
        assert info["name"] == "bad"
        assert "type" in info

    def test_slow_repr_is_capped(self) -> None:
        obj = SlowRepr()
        start = time.perf_counter()
        info = inspect_one("slow", obj)
        elapsed_ms = (time.perf_counter() - start) * 1000
        # Should be fast because _safe_repr caps at 200 chars
        assert elapsed_ms < 5
        if "repr" in info:
            assert len(info["repr"]) <= 203  # 200 + "..."

    def test_negative_len(self) -> None:
        obj = NegativeLen()
        info = inspect_one("neg", obj)
        assert info["name"] == "neg"
        # Should handle gracefully
        assert "type" in info

    def test_non_string_repr(self) -> None:
        obj = NonStringRepr()
        info = inspect_one("bad", obj)
        assert info["name"] == "bad"
        assert "type" in info

    def test_circular_dict(self) -> None:
        d: CircularDict = CircularDict()
        d["self"] = d
        info = inspect_one("circ", d)
        assert info["name"] == "circ"
        assert info["type"] == "CircularDict"
        # Should have keys without infinite recursion
        assert "self" in info["keys"]

    def test_circular_dict_performance(self) -> None:
        """Circular dict must not cause infinite loop in repr."""
        d: CircularDict = CircularDict()
        d["self"] = d
        d["other"] = d
        start = time.perf_counter()
        inspect_one("circ", d)
        elapsed_ms = (time.perf_counter() - start) * 1000
        assert elapsed_ms < 50, f"Circular dict took {elapsed_ms:.2f}ms"


# ---------------------------------------------------------------------------
# Tests — stdlib types that should work well through generic handler
# ---------------------------------------------------------------------------


class TestStdlibTypes:
    def test_enum_instance(self) -> None:
        info = inspect_one("c", Color.RED)
        assert info["name"] == "c"
        # Enum values are essentially scalars
        assert "type" in info

    def test_int_enum(self) -> None:
        info = inspect_one("p", Priority.HIGH)
        # IntEnum is an int subclass
        assert info["name"] == "p"
        assert "type" in info

    def test_namedtuple(self) -> None:
        pt = Point(x=1.0, y=2.0)
        info = inspect_one("pt", pt)
        assert info["type"] == "Point"
        assert info["length"] == 2
        # Small tuple — should have repr
        assert "repr" in info
        assert "1.0" in info["repr"]

    def test_dataclass(self) -> None:
        cfg = Config()
        info = inspect_one("cfg", cfg)
        assert info["name"] == "cfg"
        assert info["type"] == "Config"
        # Should get a useful repr from the dataclass
        if "repr" in info:
            assert "localhost" in info["repr"]

    def test_datetime(self) -> None:
        dt = datetime.datetime(2024, 1, 15, 10, 30, 0)
        info = inspect_one("dt", dt)
        assert info["name"] == "dt"
        # datetime is not in _SCALAR_TYPES so goes through generic
        assert "type" in info

    def test_date(self) -> None:
        d = datetime.date(2024, 1, 15)
        info = inspect_one("d", d)
        assert info["name"] == "d"

    def test_timedelta(self) -> None:
        td = datetime.timedelta(days=7, hours=3)
        info = inspect_one("td", td)
        assert info["name"] == "td"

    def test_decimal(self) -> None:
        d = Decimal("3.14159265358979323846")
        info = inspect_one("d", d)
        assert info["name"] == "d"
        assert "type" in info

    def test_fraction(self) -> None:
        f = Fraction(22, 7)
        info = inspect_one("f", f)
        assert info["name"] == "f"

    def test_path(self) -> None:
        p = Path("/home/user/data/experiment.csv")
        info = inspect_one("p", p)
        assert info["name"] == "p"
        assert "Path" in info["type"]
        if "repr" in info:
            assert "experiment.csv" in info["repr"]

    def test_compiled_regex(self) -> None:
        pat = re.compile(r"\d+\.\d+")
        info = inspect_one("pat", pat)
        assert info["name"] == "pat"

    def test_ordered_dict(self) -> None:
        od = collections.OrderedDict([("a", 1), ("b", 2), ("c", 3)])
        info = inspect_one("od", od)
        # OrderedDict is a dict subclass
        assert info["type"] == "OrderedDict"
        assert info["length"] == 3
        assert info["keys"] == ["a", "b", "c"]

    def test_defaultdict(self) -> None:
        dd = collections.defaultdict(list, {"x": [1, 2], "y": [3]})
        info = inspect_one("dd", dd)
        assert info["type"] == "defaultdict"
        assert info["length"] == 2
        assert "x" in info["keys"]

    def test_counter(self) -> None:
        c = collections.Counter("abracadabra")
        info = inspect_one("c", c)
        assert info["type"] == "Counter"
        assert info["length"] == 5  # 5 unique letters

    def test_deque(self) -> None:
        dq = collections.deque([1, 2, 3, 4, 5], maxlen=10)
        info = inspect_one("dq", dq)
        assert info["name"] == "dq"
        assert info["length"] == 5

    def test_frozenset(self) -> None:
        fs = frozenset({1, 2, 3, 4})
        info = inspect_one("fs", fs)
        assert info["type"] == "frozenset"
        assert info["length"] == 4

    def test_bytes(self) -> None:
        b = b"hello world"
        info = inspect_one("b", b)
        assert info["type"] == "bytes"
        assert info["value"] == "b'hello world'"

    def test_bytearray(self) -> None:
        ba = bytearray(b"hello")
        info = inspect_one("ba", ba)
        assert info["name"] == "ba"


# ---------------------------------------------------------------------------
# Tests — summary format for generics
# ---------------------------------------------------------------------------


class TestGenericSummary:
    def test_namedtuple_summary(self) -> None:
        pt = Point(x=1.0, y=2.0)
        s = summarize_one("pt", pt)
        assert "Point" in s
        assert "len=2" in s

    def test_dataclass_summary(self) -> None:
        cfg = Config()
        s = summarize_one("cfg", cfg)
        assert "Config" in s

    def test_path_summary(self) -> None:
        p = Path("/data/file.csv")
        s = summarize_one("p", p)
        assert "Path" in s

    def test_counter_summary(self) -> None:
        c = collections.Counter("abracadabra")
        s = summarize_one("c", c)
        assert "Counter" in s
        assert "5 keys" in s


# ---------------------------------------------------------------------------
# Tests — list_user_variables with exotic namespace
# ---------------------------------------------------------------------------


class TestExoticNamespace:
    def test_mixed_namespace(self) -> None:
        """Simulates a kernel with many different object types."""
        ns = {
            "df": pd.DataFrame({"a": [1, 2]}),
            "arr": np.zeros(10),
            "config": Config(),
            "point": Point(1.0, 2.0),
            "color": Color.RED,
            "regex": re.compile(r"\w+"),
            "path": Path("/tmp/data"),
            "counter": collections.Counter("hello"),
            "n": 42,
            "pi": 3.14,
            "name": "experiment",
            # Should be filtered out:
            "np": np,
            "pd": pd,
            "_hidden": "secret",
        }
        result = list_user_variables(ns, detail="basic")
        names = [r["name"] for r in result]
        # Data objects included
        assert "df" in names
        assert "arr" in names
        assert "config" in names
        assert "point" in names
        # Modules excluded
        assert "np" not in names
        assert "pd" not in names
        # Private excluded
        assert "_hidden" not in names

    def test_schema_mode_no_crash(self) -> None:
        """Schema mode with exotic objects should not crash."""
        ns = {
            "bad": BrokenReprAndLen(),
            "circ": CircularDict({"self": None}),
            "good": [1, 2, 3],
        }
        # Make it circular
        ns["circ"]["self"] = ns["circ"]
        result = list_user_variables(ns, detail="schema")
        assert len(result) == 3
        assert all(isinstance(s, str) for s in result)

    def test_full_mode_no_crash(self) -> None:
        """Full mode with exotic objects should not crash."""
        ns = {
            "bad": BrokenGetattr(),
            "ok": {"key": "value"},
        }
        result = list_user_variables(ns, detail="full")
        assert len(result) == 2


# ---------------------------------------------------------------------------
# Performance — generic handler must be fast
# ---------------------------------------------------------------------------


class TestGenericPerformance:
    def test_dataclass_under_5ms(self) -> None:
        cfg = Config()
        start = time.perf_counter()
        inspect_one("cfg", cfg)
        elapsed = (time.perf_counter() - start) * 1000
        assert elapsed < 5

    def test_large_namedtuple_under_5ms(self) -> None:
        BigTuple = collections.namedtuple("BigTuple", [f"field_{i}" for i in range(100)])  # noqa: PYI024
        obj = BigTuple(*range(100))
        start = time.perf_counter()
        inspect_one("big", obj)
        elapsed = (time.perf_counter() - start) * 1000
        assert elapsed < 5

    def test_exotic_namespace_under_50ms(self) -> None:
        """Full list_user_variables with 50 exotic objects."""
        ns = {}
        for i in range(10):
            ns[f"path_{i}"] = Path(f"/tmp/file_{i}.csv")
        for i in range(10):
            ns[f"counter_{i}"] = collections.Counter(f"data_{i}" * 10)
        for i in range(10):
            ns[f"dt_{i}"] = datetime.datetime(2024, 1, i + 1)
        for i in range(10):
            ns[f"dec_{i}"] = Decimal(f"{i}.{i}")
        for i in range(10):
            ns[f"cfg_{i}"] = Config(host=f"host_{i}")
        start = time.perf_counter()
        list_user_variables(ns, detail="schema", max_variables=50)
        elapsed = (time.perf_counter() - start) * 1000
        assert elapsed < 50, f"50 exotic variables took {elapsed:.2f}ms"
