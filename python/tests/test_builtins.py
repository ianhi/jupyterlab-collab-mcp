"""Tests for dict, list, tuple, set, scalars, and error handling."""

from __future__ import annotations

from variable_inspector.inspector import inspect_one, list_user_variables, summarize_one


class TestDict:
    def test_basic(self) -> None:
        d = {"a": 1, "b": "hello", "c": [1, 2, 3]}
        info = inspect_one("d", d)
        assert info["type"] == "dict"
        assert info["length"] == 3
        assert info["keys"] == ["a", "b", "c"]

    def test_values_preview(self) -> None:
        d = {"host": "localhost", "port": 8080}
        info = inspect_one("d", d)
        assert "values_preview" in info
        assert "host" in info["values_preview"]
        assert "str" in info["values_preview"]["host"]

    def test_max_items_truncation(self) -> None:
        d = {f"k{i}": i for i in range(100)}
        info = inspect_one("d", d, max_items=5)
        assert len(info["keys"]) == 5
        assert info["keys_truncated"] == 100

    def test_summary(self) -> None:
        d = {"host": "localhost", "port": 8080}
        s = summarize_one("cfg", d)
        assert "dict" in s
        assert "2 keys" in s
        assert "host" in s


class TestCollections:
    def test_list(self) -> None:
        info = inspect_one("lst", [1, 2, "a", "b"])
        assert info["type"] == "list"
        assert info["length"] == 4
        assert "repr" in info

    def test_large_list_uses_element_types(self) -> None:
        info = inspect_one("lst", list(range(100)))
        assert info["type"] == "list"
        assert info["length"] == 100
        assert "element_types" in info
        assert "repr" not in info
        assert len(info["element_types"]) == 5
        assert info["element_types"][0] == "int"

    def test_tuple(self) -> None:
        info = inspect_one("t", (1, 2, 3))
        assert info["type"] == "tuple"
        assert info["length"] == 3

    def test_empty_list(self) -> None:
        info = inspect_one("e", [])
        assert info["type"] == "list"
        assert info["length"] == 0

    def test_set(self) -> None:
        info = inspect_one("s", {1, 2, 3})
        assert info["type"] == "set"
        assert info["length"] == 3


class TestScalars:
    def test_int(self) -> None:
        info = inspect_one("n", 42)
        assert info["type"] == "int"
        assert info["value"] == "42"

    def test_float(self) -> None:
        info = inspect_one("f", 3.14)
        assert info["type"] == "float"

    def test_str(self) -> None:
        info = inspect_one("s", "hello")
        assert info["type"] == "str"
        assert info["value"] == "'hello'"

    def test_none(self) -> None:
        info = inspect_one("n", None)
        assert info["type"] == "NoneType"

    def test_bool(self) -> None:
        info = inspect_one("b", True)
        assert info["type"] == "bool"

    def test_long_string_truncation(self) -> None:
        s = "x" * 500
        info = inspect_one("s", s)
        assert len(info["value"]) <= 200

    def test_summary(self) -> None:
        s = summarize_one("n", 42)
        assert "int" in s
        assert "42" in s


class TestErrorHandling:
    def test_broken_repr(self) -> None:
        class BadRepr:
            def __repr__(self) -> str:
                raise RuntimeError("boom")

        info = inspect_one("bad", BadRepr())
        assert "type" in info

    def test_broken_len(self) -> None:
        class BadLen:
            def __len__(self) -> int:
                raise RuntimeError("boom")

        info = inspect_one("bad", BadLen())
        assert "type" in info


class TestListUserVariables:
    def test_basic_mode(self, mixed_namespace: dict) -> None:
        result = list_user_variables(mixed_namespace, detail="basic")
        assert isinstance(result, list)
        names = [r["name"] for r in result]
        assert "df" in names
        assert "arr" in names
        assert "np" not in names
        assert "pd" not in names
        assert "_private" not in names

    def test_schema_mode(self, mixed_namespace: dict) -> None:
        result = list_user_variables(mixed_namespace, detail="schema")
        assert isinstance(result, list)
        assert all(isinstance(s, str) for s in result)
        joined = "\n".join(result)
        assert "DataFrame" in joined
        assert "ndarray" in joined

    def test_full_mode(self, mixed_namespace: dict) -> None:
        result = list_user_variables(mixed_namespace, detail="full")
        assert isinstance(result, list)
        assert all(isinstance(d, dict) for d in result)

    def test_filter_by_name(self, mixed_namespace: dict) -> None:
        result = list_user_variables(mixed_namespace, detail="basic", filter_name="df")
        names = [r["name"] for r in result]
        assert "df" in names
        assert "arr" not in names

    def test_max_variables_cap(self, mixed_namespace: dict) -> None:
        result = list_user_variables(mixed_namespace, detail="basic", max_variables=3)
        assert len(result) <= 3

    def test_include_private(self, mixed_namespace: dict) -> None:
        result = list_user_variables(mixed_namespace, detail="basic", include_private=True)
        names = [r["name"] for r in result]
        assert "_private" in names
