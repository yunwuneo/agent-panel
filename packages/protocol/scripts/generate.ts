import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { EnvelopeSchema, namedSchemas } from "../src/index";

const root = resolve(import.meta.dir, "../../..");
const out = resolve(root, "apps/apple/AgentPanel/Generated");
await mkdir(out, { recursive: true });
await mkdir(resolve(root, "packages/protocol/generated"), { recursive: true });
type Schema = Record<string, any>;
const schemas = Object.fromEntries(
  Object.entries(namedSchemas).map(([name, schema]) => [
    name,
    z.toJSONSchema(schema, { cycles: "ref", unrepresentable: "any" }) as Schema,
  ]),
);
await Bun.write(
  resolve(root, "packages/protocol/generated/protocol.schema.json"),
  `${JSON.stringify({ version: 1, envelope: z.toJSONSchema(EnvelopeSchema, { cycles: "ref" }), models: schemas }, null, 2)}\n`,
);
const shape = (s: Schema): string =>
  JSON.stringify(s, (key, value) => (["$schema", "$id"].includes(key) ? undefined : value));
const shapes = new Map(Object.entries(schemas).map(([name, schema]) => [shape(schema), name]));
function swiftType(s: Schema, own?: string): string {
  if (Array.isArray(s.type)) {
    const nonNull = s.type.filter((value: string) => value !== "null");
    if (nonNull.length === 1)
      return swiftType({ ...s, type: nonNull[0] }, own) + (s.type.includes("null") ? "?" : "");
    return "JSONValue";
  }
  const known = shapes.get(shape(s));
  if (known && known !== own) return known;
  if (s.$ref) return "JSONValue";
  if (s.anyOf || s.oneOf) {
    const alts = (s.anyOf || s.oneOf) as Schema[];
    const nonNull = alts.filter((v) => v.type !== "null");
    if (nonNull.length === 1 && nonNull.length < alts.length) return `${swiftType(nonNull[0]!)}?`;
    return "JSONValue";
  }
  if (s.type === "string") return "String";
  if (s.type === "boolean") return "Bool";
  if (s.type === "integer") return "Int";
  if (s.type === "number") return "Double";
  if (s.type === "array") return `[${swiftType(s.items ?? {})}]`;
  if (s.type === "object") return "[String: JSONValue]";
  return "JSONValue";
}
let swift = `// Generated from packages/protocol Zod schemas via protocol.schema.json. DO NOT EDIT.\nimport Foundation\n\n`;
for (const [name, schema] of Object.entries(schemas)) {
  const required = new Set(schema.required ?? []);
  const fields = Object.entries(schema.properties as Record<string, Schema>).map(([key, s]) => {
    let type = swiftType(s, name);
    if (!required.has(key) && !type.endsWith("?")) type += "?";
    return { key, type };
  });
  swift += `public struct ${name}: Codable, Sendable {\n`;
  for (const f of fields) swift += `    public var ${f.key}: ${f.type}\n`;
  swift += `    public init(${fields.map((f) => `${f.key}: ${f.type}${f.type.endsWith("?") ? " = nil" : ""}`).join(", ")}) {\n`;
  for (const f of fields) swift += `        self.${f.key} = ${f.key}\n`;
  swift += "    }\n}\n\n";
}
swift += `public enum JSONValue: Codable, Sendable, Equatable {
    case null, bool(Bool), number(Double), string(String), array([JSONValue]), object([String: JSONValue])
    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode([JSONValue].self) { self = .array(v) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .object(let v): try c.encode(v)
        }
    }
    public var stringValue: String? { if case .string(let v) = self { return v }; return nil }
    public var numberValue: Double? { if case .number(let v) = self { return v }; return nil }
    public var boolValue: Bool? { if case .bool(let v) = self { return v }; return nil }
    public var arrayValue: [JSONValue]? { if case .array(let v) = self { return v }; return nil }
    public var objectValue: [String: JSONValue]? { if case .object(let v) = self { return v }; return nil }
    public subscript(_ key: String) -> JSONValue { objectValue?[key] ?? .null }
    public func decoded<T: Decodable>(_ type: T.Type) throws -> T { try JSONDecoder().decode(type, from: JSONEncoder().encode(self)) }
    public static func encoded<T: Encodable>(_ value: T) throws -> JSONValue { try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value)) }
    public var pretty: String { let e = JSONEncoder(); e.outputFormatting = [.prettyPrinted, .sortedKeys]; return (try? String(data: e.encode(self), encoding: .utf8)) ?? "" }
}
`;
await Bun.write(resolve(out, "Protocol.generated.swift"), swift);
console.log(`Generated ${Object.keys(schemas).length} Swift models and protocol.schema.json`);
