// Checks noda-js's API shape against NodaTime's public API (test/api/nodatime-api.generated.ts, by
// reflection): every type exists, C# properties are getters (not methods), methods are methods, statics
// are static. Deliberate differences are listed in ./differences.ts (and docs/api-differences.md).

import { describe, expect, it } from "vitest";
import * as noda from "../../src/noda-js/internal.ts";
import { NodaTimeApi } from "./nodatime-api.generated.ts";
import { notPorted, renamed, renamedTypes } from "./differences.ts";
import type { ApiMember, ApiType } from "./types.ts";

// How C# operators appear in noda-js (docs/porting-conventions.md).
const operatorNames: Readonly<Record<string, { name: string; isStatic: boolean } | null>> = {
  op_Addition: { name: "Add", isStatic: true },
  op_Subtraction: { name: "Subtract", isStatic: true },
  op_Multiply: { name: "Multiply", isStatic: true },
  op_Division: { name: "Divide", isStatic: true },
  op_UnaryNegation: { name: "Negate", isStatic: true },
  op_Equality: { name: "Equals", isStatic: false },
  op_Inequality: { name: "Equals", isStatic: false },
  op_LessThan: { name: "CompareTo", isStatic: false },
  op_LessThanOrEqual: { name: "CompareTo", isStatic: false },
  op_GreaterThan: { name: "CompareTo", isStatic: false },
  op_GreaterThanOrEqual: { name: "CompareTo", isStatic: false },
  op_UnaryPlus: null,
  op_Implicit: null,
  op_Explicit: null,
};

function findDescriptor(target: object, name: string | symbol): PropertyDescriptor | undefined {
  for (let o: object | null = target; o !== null && o !== Object.prototype && o !== Function.prototype; o = Object.getPrototypeOf(o)) {
    const descriptor = Object.getOwnPropertyDescriptor(o, name);
    if (descriptor) {
      return descriptor;
    }
  }
  return undefined;
}

/** The noda-js export name of a NodaTime type: the C# name (exceptions included; docs/porting-conventions.md), unless renamed. */
function tsTypeName(type: ApiType): string {
  return renamedTypes[type.name] ?? type.name;
}

/** Extension classes (static classes of C# extension methods) are exported as plain functions. */
function isExtensionClass(type: ApiType): boolean {
  return type.kind === "static class" && type.name.endsWith("Extensions") && (noda as any)[type.name] === undefined;
}

function checkMember(type: ApiType, tsType: any, member: ApiMember): void {
  const key = `${type.name}.${member.csName}`;
  let name: string | symbol = renamed[key] ?? member.name;
  if (member.kind === "indexer") {
    name = "Get"; // indexers are Get(key) (and Set(key, value)) methods
  }
  if (member.csName === "GetEnumerator") {
    name = Symbol.iterator; // IEnumerable<T> → [Symbol.iterator]
  }
  if (member.csName === "ToString") {
    name = "toString"; // JS built-ins keep their JS names (toString, toJSON, valueOf)
  }
  let isStatic = member.isStatic;
  if (member.kind === "operator") {
    const mapped = operatorNames[member.csName];
    if (mapped === null || mapped === undefined) {
      return;
    }
    ({ name, isStatic } = mapped);
  }
  if (member.kind === "constructor") {
    expect(typeof tsType, `${type.name} should be constructible`).toBe("function");
    return;
  }
  const target = isStatic ? tsType : tsType.prototype;
  expect(target, `${type.name} has no ${isStatic ? "static side" : "prototype"}`).toBeDefined();
  const descriptor = findDescriptor(target, name);
  expect(descriptor, `${key} → ${isStatic ? "static " : ""}${String(name)} is missing`).toBeDefined();
  switch (member.kind) {
    case "property":
      // A getter, or (for static members) a readonly static value. Never a method.
      expect(descriptor!.get !== undefined || (isStatic && "value" in descriptor! && typeof descriptor!.value !== "function"),
        `${key} is a C# property, so ${String(name)} must be a getter, not a method or plain field`).toBe(true);
      break;
    case "indexer":
      expect(typeof descriptor!.value, `${key} → Get(...)`).toBe("function");
      break;
    case "field":
    case "const":
      expect(typeof (descriptor!.get ?? descriptor!.value) !== "undefined", `${key} → ${String(name)} has no value`).toBe(true);
      break;
    case "method":
      expect(typeof descriptor!.value, `${key} is a C# method, so ${String(name)} must be a method`).toBe("function");
      break;
  }
}

for (const type of NodaTimeApi) {
  describe(type.fullName, () => {
    const typeReason = notPorted[type.name];
    if (typeReason !== undefined) {
      it.skip(`not ported: ${typeReason}`, () => {});
      return;
    }
    if (type.kind === "interface" || type.kind === "delegate") {
      // Compile-time only in TS (interfaces and function types); checked by tsc, not at runtime.
      it.skip(`${type.kind}: compile-time only`, () => {});
      return;
    }
    if (isExtensionClass(type)) {
      for (const member of type.members) {
        const reason = member.bclInterop ? "BCL interop (not ported: docs/api-differences.md)" : notPorted[`${type.name}.${member.csName}`];
        if (reason !== undefined) {
          it.skip(`function ${member.csName} — not ported: ${reason}`, () => {});
          continue;
        }
        it(`function ${member.csName}`, () => {
          expect(typeof (noda as any)[member.name], `extension method ${type.name}.${member.csName} → exported function ${member.name}`).toBe("function");
        });
      }
      return;
    }
    it("exists", () => {
      expect((noda as any)[tsTypeName(type)], `${tsTypeName(type)} is not exported`).toBeDefined();
    });
    for (const member of type.members) {
      const key = `${type.name}.${member.csName}`;
      // Renamed types (noda-js/system's) are ported with their BCL interop (noda-js's port of TimeZoneInfo).
      const reason = member.bclInterop && renamedTypes[type.name] === undefined ? "BCL interop (not ported: docs/api-differences.md)" : notPorted[key];
      const label = `${member.kind} ${member.isStatic ? "static " : ""}${member.csName}`;
      if (reason !== undefined) {
        it.skip(`${label} — not ported: ${reason}`, () => {});
        continue;
      }
      it(label, () => {
        const tsType = (noda as any)[tsTypeName(type)];
        expect(tsType, `${tsTypeName(type)} is not exported`).toBeDefined();
        checkMember(type, tsType, member);
      });
    }
  });
}
