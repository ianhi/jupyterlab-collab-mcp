"""
Variable inspector for Jupyter kernels.

Provides fast, safe introspection of kernel variables. Uses library repr()
as the primary mechanism (libraries invest heavily in making repr fast and
informative), with structured attribute extraction only for DataFrame/array
types where agents need machine-readable column/dtype metadata.

Safety rules:
- Never triggers lazy computation (polars LazyFrame .collect(), dask .compute())
- Uses capped repr() for everything except known-dangerous types
- All enumeration capped with itertools.islice
"""

from __future__ import annotations

import contextlib
import types
from itertools import islice
from typing import Any


def _safe_attr(obj: Any, name: str, default: Any = None) -> Any:
    try:
        return getattr(obj, name, default)
    except Exception:
        return default


def _safe_len(obj: Any) -> int | None:
    try:
        return len(obj)
    except Exception:
        return None


def _truncate_name(name: str, max_len: int | None) -> str:
    """Truncate long names. max_len=None means no limit."""
    if max_len is None:
        return str(name)
    s = str(name)
    return s if len(s) <= max_len else s[: max_len - 3] + "..."


def _safe_repr(obj: Any, limit: int = 200) -> str:
    """Safe repr with character cap.

    For large Python containers (dict/list/tuple/set), avoids calling repr()
    which would recursively repr every element — expensive if values are heavy
    objects like numpy arrays or DataFrames.
    """
    # Large containers: bail early to avoid expensive recursive repr
    if isinstance(obj, (dict, list, tuple, set, frozenset)):
        try:
            n = len(obj)
        except Exception:
            n = None
        if n is not None and n > 20:
            return f"<{type(obj).__name__} with {n} items>"
    try:
        r = repr(obj)
    except Exception:
        return f"<{type(obj).__name__}>"
    if len(r) > limit:
        return r[: limit - 3] + "..."
    return r


def _type_name(obj: Any) -> str:
    """Short type name: 'DataFrame', 'ndarray', etc."""
    return type(obj).__name__


def _module(obj: Any) -> str:
    return getattr(type(obj), "__module__", "") or ""


# ---------------------------------------------------------------------------
# Structured inspectors — only for types where agents need machine-readable
# metadata (columns, dtypes, shape). Everything else uses repr().
# ---------------------------------------------------------------------------


def _inspect_pandas_dataframe(
    name: str, obj: Any, max_items: int, max_name_length: int | None = 60
) -> dict[str, Any]:
    shape = _safe_attr(obj, "shape", ())
    cols = list(islice(_safe_attr(obj, "columns", []), max_items))
    dtypes = _safe_attr(obj, "dtypes", None)

    col_info = []
    for c in cols:
        dt = "?"
        if dtypes is not None:
            with contextlib.suppress(Exception):
                dt = str(dtypes[c])
        col_info.append({"name": _truncate_name(c, max_name_length), "dtype": dt})

    total_cols = shape[1] if len(shape) > 1 else len(cols)
    result: dict[str, Any] = {
        "name": name,
        "type": "DataFrame",
        "shape": list(shape),
        "columns": col_info,
    }
    if total_cols > max_items:
        result["columns_truncated"] = total_cols

    idx = _safe_attr(obj, "index", None)
    if idx is not None:
        result["index_dtype"] = str(_safe_attr(idx, "dtype", "?"))
        # Detect MultiIndex
        if _type_name(idx) == "MultiIndex":
            result["index_type"] = "MultiIndex"
            result["index_nlevels"] = _safe_attr(idx, "nlevels", None)
            names = _safe_attr(idx, "names", None)
            if names is not None:
                result["index_names"] = [str(n) if n is not None else None for n in names]

    with contextlib.suppress(Exception):
        result["memory_bytes"] = int(obj.memory_usage(deep=False).sum())

    return result


def _inspect_pandas_series(name: str, obj: Any) -> dict[str, Any]:
    result: dict[str, Any] = {
        "name": name,
        "type": "Series",
        "shape": list(_safe_attr(obj, "shape", ())),
        "dtype": str(_safe_attr(obj, "dtype", "?")),
    }
    series_name = _safe_attr(obj, "name", None)
    if series_name is not None:
        result["series_name"] = str(series_name)
    with contextlib.suppress(Exception):
        result["memory_bytes"] = int(obj.memory_usage(deep=False))
    return result


def _inspect_polars_dataframe(
    name: str, obj: Any, max_items: int, max_name_length: int | None = 60
) -> dict[str, Any]:
    shape = _safe_attr(obj, "shape", ())
    cols = list(islice(_safe_attr(obj, "columns", []), max_items))
    schema = _safe_attr(obj, "schema", None)

    col_info = []
    for c in cols:
        dt = "?"
        if schema is not None:
            with contextlib.suppress(Exception):
                dt = str(schema[c])
        col_info.append({"name": _truncate_name(c, max_name_length), "dtype": dt})

    total_cols = shape[1] if len(shape) > 1 else len(cols)
    result: dict[str, Any] = {
        "name": name,
        "type": "polars.DataFrame",
        "shape": list(shape),
        "columns": col_info,
    }
    if total_cols > max_items:
        result["columns_truncated"] = total_cols

    with contextlib.suppress(Exception):
        result["estimated_size_bytes"] = obj.estimated_size()

    return result


def _inspect_polars_lazyframe(
    name: str, obj: Any, max_items: int, max_name_length: int | None = 60
) -> dict[str, Any]:
    """Inspect polars LazyFrame. NEVER calls .collect()."""
    try:
        schema = obj.collect_schema()
        names = list(islice(schema.names(), max_items))
        col_info = []
        for n in names:
            with contextlib.suppress(Exception):
                col_info.append(
                    {"name": _truncate_name(n, max_name_length), "dtype": str(schema[n])}
                )
        total = len(schema.names())
        result: dict[str, Any] = {
            "name": name,
            "type": "polars.LazyFrame",
            "columns": col_info,
            "lazy": True,
        }
        if total > max_items:
            result["columns_truncated"] = total
        return result
    except Exception:
        return {"name": name, "type": "polars.LazyFrame", "lazy": True}


def _inspect_polars_series(name: str, obj: Any) -> dict[str, Any]:
    result: dict[str, Any] = {
        "name": name,
        "type": "polars.Series",
        "shape": list(_safe_attr(obj, "shape", ())),
        "dtype": str(_safe_attr(obj, "dtype", "?")),
    }
    series_name = _safe_attr(obj, "name", None)
    if series_name is not None:
        result["series_name"] = str(series_name)
    return result


def _inspect_numpy(name: str, obj: Any) -> dict[str, Any]:
    return {
        "name": name,
        "type": "ndarray",
        "shape": list(_safe_attr(obj, "shape", ())),
        "dtype": str(_safe_attr(obj, "dtype", "?")),
        "ndim": _safe_attr(obj, "ndim", None),
        "nbytes": _safe_attr(obj, "nbytes", None),
    }


def _inspect_xarray_dataset(
    name: str, obj: Any, max_items: int, max_name_length: int | None = 60
) -> dict[str, Any]:
    result: dict[str, Any] = {"name": name, "type": "xarray.Dataset"}
    sizes = _safe_attr(obj, "sizes", None)
    if sizes is not None:
        result["dims"] = dict(islice(sizes.items(), max_items))
    data_vars = _safe_attr(obj, "data_vars", None)
    if data_vars is not None:
        var_list = []
        for var_name in islice(data_vars, max_items):
            var_info = {"name": _truncate_name(var_name, max_name_length)}
            with contextlib.suppress(Exception):
                var_obj = data_vars[var_name]
                dtype = _safe_attr(var_obj, "dtype", None)
                if dtype is not None:
                    var_info["dtype"] = str(dtype)
            var_list.append(var_info)
        result["data_vars"] = var_list
        total = _safe_len(data_vars)
        if total is not None and total > max_items:
            result["data_vars_truncated"] = total
    coords = _safe_attr(obj, "coords", None)
    if coords is not None:
        result["coords"] = [_truncate_name(c, max_name_length) for c in islice(coords, max_items)]
    return result


def _inspect_xarray_dataarray(name: str, obj: Any) -> dict[str, Any]:
    result: dict[str, Any] = {"name": name, "type": "xarray.DataArray"}
    dims = _safe_attr(obj, "dims", None)
    shape = _safe_attr(obj, "shape", None)
    if dims is not None and shape is not None:
        result["dims"] = {str(d): int(s) for d, s in zip(dims, shape)}
    dtype = _safe_attr(obj, "dtype", None)
    if dtype is not None:
        result["dtype"] = str(dtype)
    return result


def _inspect_xarray_datatree(
    name: str, obj: Any, max_items: int, max_name_length: int | None = 60
) -> dict[str, Any]:
    result: dict[str, Any] = {"name": name, "type": "xarray.DataTree"}
    children = _safe_attr(obj, "children", {})
    if children:
        result["children"] = [
            _truncate_name(c, max_name_length) for c in islice(children.keys(), max_items)
        ]
        total = _safe_len(children)
        if total is not None and total > max_items:
            result["children_truncated"] = total
    ds = _safe_attr(obj, "dataset", None)
    if ds is not None:
        data_vars = _safe_attr(ds, "data_vars", None)
        if data_vars is not None:
            var_list = []
            for var_name in islice(data_vars, max_items):
                var_info = {"name": _truncate_name(var_name, max_name_length)}
                with contextlib.suppress(Exception):
                    var_obj = data_vars[var_name]
                    dtype = _safe_attr(var_obj, "dtype", None)
                    if dtype is not None:
                        var_info["dtype"] = str(dtype)
                var_list.append(var_info)
            result["data_vars"] = var_list
        sizes = _safe_attr(ds, "sizes", None)
        if sizes is not None:
            result["dims"] = dict(islice(sizes.items(), max_items))
    with contextlib.suppress(Exception):
        result["total_nodes"] = sum(1 for _ in obj.subtree)
    return result


def _inspect_dict(
    name: str, obj: Any, max_items: int, max_name_length: int | None = 60
) -> dict[str, Any]:
    """Dict inspection: keys + capped repr of first values. No recursion."""
    n = _safe_len(obj)
    keys = list(islice(obj.keys(), max_items))
    result: dict[str, Any] = {"name": name, "type": _type_name(obj), "length": n}
    result["keys"] = [_truncate_name(k, max_name_length) for k in keys]
    if n is not None and n > max_items:
        result["keys_truncated"] = n
    # Show type of each sampled value (cheap) + repr preview of first few
    values_preview: dict[str, str] = {}
    for k in keys[: min(5, len(keys))]:
        with contextlib.suppress(Exception):
            v = obj[k]
            type_name = _type_name(v)
            # For objects with shape (DataFrame, array), show shape not full repr
            shape = _safe_attr(v, "shape", None)
            if shape is not None:
                with contextlib.suppress(Exception):
                    values_preview[str(k)] = f"{type_name}: {tuple(shape)}"
                    continue
            values_preview[str(k)] = f"{type_name}: {_safe_repr(v, 80)}"
    if values_preview:
        result["values_preview"] = values_preview
    return result


def _inspect_generic(name: str, obj: Any) -> dict[str, Any]:
    """Fallback: type + repr + common attributes (shape, dtype, len)."""
    result: dict[str, Any] = {"name": name, "type": _type_name(obj)}
    mod = _module(obj)
    for prefix in ("pandas", "polars", "numpy", "xarray", "scipy", "sklearn", "torch"):
        if mod.startswith(prefix):
            result["type"] = f"{prefix}.{_type_name(obj)}"
            break

    shape = _safe_attr(obj, "shape", None)
    if shape is not None:
        with contextlib.suppress(Exception):
            result["shape"] = list(shape)
    dtype = _safe_attr(obj, "dtype", None)
    if dtype is not None:
        result["dtype"] = str(dtype)
    n = _safe_len(obj)
    if n is not None:
        result["length"] = n
    result["repr"] = _safe_repr(obj, 200)
    return result


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

_SCALAR_TYPES = (int, float, complex, str, bytes, bool, type(None))


def inspect_one(
    name: str, obj: Any, max_items: int = 20, max_name_length: int | None = 60
) -> dict[str, Any]:
    """
    Inspect a single variable. Returns a dict with type info and structural metadata.

    For DataFrames/arrays: structured column/dtype/shape info.
    For everything else: type + capped repr().

    Args:
        name: Variable name
        obj: Object to inspect
        max_items: Maximum number of columns/keys/variables to show (default 20)
        max_name_length: Maximum chars for column/key/variable names
            (default 60, None=unlimited)
    """
    mod = _module(obj)
    cls = _type_name(obj)

    # Scalars — repr is cheap and informative
    if isinstance(obj, _SCALAR_TYPES):
        return {"name": name, "type": cls, "value": _safe_repr(obj, 200)}

    # pandas
    if mod.startswith("pandas"):
        if cls == "DataFrame":
            return _inspect_pandas_dataframe(name, obj, max_items, max_name_length)
        if cls == "Series":
            return _inspect_pandas_series(name, obj)

    # polars
    if mod.startswith("polars"):
        if cls == "DataFrame":
            return _inspect_polars_dataframe(name, obj, max_items, max_name_length)
        if cls == "LazyFrame":
            return _inspect_polars_lazyframe(name, obj, max_items, max_name_length)
        if cls == "Series":
            return _inspect_polars_series(name, obj)

    # numpy
    if mod.startswith("numpy") and cls == "ndarray":
        return _inspect_numpy(name, obj)

    # xarray
    if mod.startswith("xarray"):
        if cls == "Dataset":
            return _inspect_xarray_dataset(name, obj, max_items, max_name_length)
        if cls == "DataArray":
            return _inspect_xarray_dataarray(name, obj)
        if cls == "DataTree":
            return _inspect_xarray_datatree(name, obj, max_items, max_name_length)

    # dict — show keys + value previews (no recursion)
    if isinstance(obj, dict):
        return _inspect_dict(name, obj, max_items, max_name_length)

    # list/tuple/set — length + repr (smart about large collections)
    if isinstance(obj, (list, tuple, set, frozenset)):
        n = _safe_len(obj)
        result: dict[str, Any] = {"name": name, "type": cls, "length": n}
        if n is not None and n > 20:
            # Large collection: show type of first few elements (cheap)
            if isinstance(obj, (list, tuple)):
                sample = [_type_name(obj[i]) for i in range(min(5, n))]
            else:
                sample = [_type_name(x) for x in islice(obj, 5)]
            result["element_types"] = sample
        else:
            result["repr"] = _safe_repr(obj, 200)
        return result

    # Callable
    if callable(obj) and isinstance(
        obj,
        (types.FunctionType, types.BuiltinFunctionType, type),
    ):
        return {"name": name, "type": cls, "callable_name": _safe_attr(obj, "__name__", "?")}

    # Everything else — generic
    return _inspect_generic(name, obj)


# ---------------------------------------------------------------------------
# One-line summaries — derived from inspect_one output, no duplicate dispatch
# ---------------------------------------------------------------------------


def _format_mem(nbytes: int) -> str:
    if nbytes >= 1_048_576:
        return f" {nbytes / 1_048_576:.2f}MB"
    if nbytes >= 1024:
        return f" {nbytes / 1024:.1f}KB"
    return f" {nbytes}B"


def summarize_one(
    name: str, obj: Any, max_items: int = 20, max_name_length: int | None = 60
) -> str:
    """One-line summary derived from inspect_one() output."""
    info = inspect_one(name, obj, max_items, max_name_length)
    return _format_summary(info)


def _format_summary(info: dict[str, Any]) -> str:
    name = info["name"]
    typ = info["type"]

    # Types with columns (pandas/polars DataFrames, LazyFrames)
    if "columns" in info:
        cols = info["columns"]
        col_parts = [f"{c['name']}:{c['dtype']}" for c in cols]
        trunc = info.get("columns_truncated")
        suffix = ", ..." if trunc and trunc > len(cols) else ""
        shape = info.get("shape")
        shape_str = f" ({shape[0]}\u00d7{shape[1]})" if shape and len(shape) >= 2 else ""
        return f"{name}: {typ}{shape_str} [{', '.join(col_parts)}{suffix}]"

    # ndarray
    if typ == "ndarray":
        dtype = info.get("dtype", "?")
        shape = tuple(info.get("shape", ()))
        nbytes = info.get("nbytes")
        mem = _format_mem(nbytes) if nbytes else ""
        return f"{name}: ndarray {dtype} {shape}{mem}"

    # xarray DataTree (check before Dataset since both may have children/dims)
    if "children" in info:
        total_nodes = info.get("total_nodes", "?")
        n_children = len(info["children"])
        return f"{name}: {typ} ({total_nodes} nodes, {n_children} children)"

    # xarray Dataset (has dims + data_vars)
    if "dims" in info and "data_vars" in info:
        dims = info["dims"]
        data_vars = info["data_vars"]
        dim_parts = [f"{k}:{v}" for k, v in dims.items()]
        # data_vars is now a list of dicts with 'name' and optionally 'dtype'
        if data_vars and isinstance(data_vars[0], dict):
            var_names = [v["name"] for v in data_vars]
        else:
            var_names = data_vars  # fallback for old format
        return f"{name}: {typ} dims=({', '.join(dim_parts)}) vars=[{', '.join(var_names)}]"

    # xarray DataArray (has dims + dtype, no data_vars)
    if "dims" in info and "dtype" in info and "data_vars" not in info:
        dims = info["dims"]
        dim_parts = [f"{k}:{v}" for k, v in dims.items()]
        return f"{name}: {typ} {info['dtype']} ({', '.join(dim_parts)})"

    # Series (pandas or polars)
    if "Series" in typ:
        shape = tuple(info.get("shape", ()))
        dtype = info.get("dtype", "?")
        return f"{name}: {typ} {shape} {dtype}"

    # dict (and subclasses like Counter, OrderedDict, defaultdict)
    if "keys" in info:
        n = info.get("length", "?")
        keys = info["keys"]
        trunc = info.get("keys_truncated")
        suffix = ", ..." if trunc else ""
        return f"{name}: {typ} ({n} keys) [{', '.join(keys)}{suffix}]"

    # Scalar with value
    if "value" in info:
        return f"{name}: {typ} = {info['value'][:80]}"

    # Generic — shape or length if available
    shape = info.get("shape")
    length = info.get("length")
    extra = ""
    if shape:
        extra = f" shape={tuple(shape)}"
    elif length is not None:
        extra = f" len={length}"
    return f"{name}: {typ}{extra}"


# ---------------------------------------------------------------------------
# Listing
# ---------------------------------------------------------------------------

_ALWAYS_SKIP = frozenset(
    {
        "In",
        "Out",
        "get_ipython",
        "exit",
        "quit",
        "open",
    }
)


def list_user_variables(
    ns: dict[str, Any],
    detail: str = "basic",
    max_variables: int = 50,
    max_items: int = 20,
    max_name_length: int | None = 60,
    filter_name: str | None = None,
    include_private: bool = False,
) -> list[dict[str, Any]] | list[str]:
    """
    List user-defined variables from a namespace dict.

    detail="basic": returns list of {"name", "type", "repr"} (current behavior)
    detail="schema": returns list of one-line summary strings
    detail="full": returns list of inspect_one() dicts
    """
    entries: list[tuple[str, Any]] = []
    for vname, obj in ns.items():
        if vname.startswith("_") and not include_private:
            continue
        if vname in _ALWAYS_SKIP:
            continue
        if isinstance(obj, types.ModuleType):
            continue
        if filter_name and filter_name.lower() not in vname.lower():
            continue
        entries.append((vname, obj))

    entries = entries[:max_variables]

    if detail == "schema":
        return [summarize_one(vname, obj, max_items, max_name_length) for vname, obj in entries]

    if detail == "full":
        return [inspect_one(vname, obj, max_items, max_name_length) for vname, obj in entries]

    # basic — current behavior
    result: list[dict[str, Any]] = []
    for vname, obj in entries:
        result.append({"name": vname, "type": _type_name(obj), "repr": _safe_repr(obj, 100)})
    return result
