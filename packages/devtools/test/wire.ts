import { Schema } from "effect";
import { RpcSerialization } from "effect/rpc";

/**
 * Sends one RPC payload through the transport the attachment really uses.
 *
 * The NDJSON serialization `attachRuntime` provides, end to end: its JSON
 * codec for the payload schema, its framing, and the decode the hub runs. A bare
 * `JSON.stringify` is no stand-in: it turns a non-finite number into `null`
 * without complaint, where the codec refuses the whole payload with
 * `Expected JSON value` and the batch never leaves the app.
 */
export function acrossTheWire<S extends Schema.Codec<unknown, unknown, never, never>>(
  schema: S,
  payload: S["Type"]
): S["Type"] {
  const codec = RpcSerialization.ndjson.codecFor(schema);
  const parser = RpcSerialization.ndjson.makeUnsafe();
  const frame = parser.encode({
    _tag: "Request",
    id: "1",
    tag: "probe",
    payload: Schema.encodeUnknownSync(codec)(payload),
    headers: [],
  });
  const [message] = parser.decode(frame ?? "") as ReadonlyArray<{ readonly payload: unknown }>;

  return Schema.decodeUnknownSync(codec)(message?.payload);
}
