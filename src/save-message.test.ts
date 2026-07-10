import { describe, it, expect } from "vitest";
import { encodeVarUint, encodeVarString, decodeVarUint } from "./connection.js";

// The jupyter-collaboration RAW "save" control message is:
//   var_uint(MessageType.RAW=2) ++ var_string("save") ++ var_uint(saveId)
// and the reply is var_uint(2) ++ var_string(json). These tests pin the wire
// format so a codec regression can't silently break save_notebook.

describe("lib0 var-uint codec", () => {
  it("encodes small values as a single byte", () => {
    expect(encodeVarUint(0)).toEqual([0x00]);
    expect(encodeVarUint(2)).toEqual([0x02]);
    expect(encodeVarUint(127)).toEqual([0x7f]);
  });

  it("encodes >=128 as multi-byte continuation form", () => {
    expect(encodeVarUint(128)).toEqual([0x80, 0x01]);
    expect(encodeVarUint(300)).toEqual([0xac, 0x02]);
  });

  it("round-trips through decodeVarUint at an offset", () => {
    for (const n of [0, 1, 2, 127, 128, 255, 300, 16384, 1_000_000]) {
      const buf = Buffer.from([0xff, ...encodeVarUint(n)]); // leading junk byte
      const [value, next] = decodeVarUint(buf, 1);
      expect(value).toBe(n);
      expect(next).toBe(buf.length);
    }
  });
});

describe("save control message wire format", () => {
  it("produces the exact bytes the server's on_message expects", () => {
    const RAW = 2;
    const saveId = 1;
    const bytes = Buffer.from([
      ...encodeVarUint(RAW),
      ...encodeVarString("save"),
      ...encodeVarUint(saveId),
    ]);
    // 0x02 (RAW), 0x04 (len "save"), 's','a','v','e', 0x01 (saveId)
    expect([...bytes]).toEqual([0x02, 0x04, 0x73, 0x61, 0x76, 0x65, 0x01]);
  });

  it("decodes a server save reply (RAW + json)", () => {
    const json = JSON.stringify({ type: "save", responseTo: 1, status: "success" });
    const reply = Buffer.from([
      ...encodeVarUint(2),
      ...encodeVarString(json),
    ]);
    const [type, o1] = decodeVarUint(reply, 0);
    expect(type).toBe(2);
    const [len, o2] = decodeVarUint(reply, o1);
    const obj = JSON.parse(reply.subarray(o2, o2 + len).toString("utf8"));
    expect(obj).toEqual({ type: "save", responseTo: 1, status: "success" });
  });
});
