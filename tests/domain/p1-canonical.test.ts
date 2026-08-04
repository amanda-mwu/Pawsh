import { describe,expect,it } from "vitest";
import { canonicalize,digest } from "../../scripts/qa/p1/canonical.js";
describe("P1 RFC 8785 canonicalization",()=>{
  it("uses deterministic property ordering and ECMAScript primitive serialization",()=>{
    expect(canonicalize({z:null,a:[3,true,"x"]})).toBe('{"a":[3,true,"x"],"z":null}');
    expect(digest({b:2,a:1})).toBe(digest({a:1,b:2}));
  });
  it("rejects values outside the I-JSON/JCS domain",()=>{
    expect(()=>canonicalize({value:undefined})).toThrow(/undefined/);
    expect(()=>canonicalize(Number.NaN)).toThrow(/non-finite/);
    expect(()=>canonicalize("\ud800")).toThrow(/surrogates/);
  });
});
