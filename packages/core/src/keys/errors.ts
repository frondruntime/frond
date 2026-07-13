export type KeyErrorTag =
  | "KeyNonFiniteNumberError"
  | "KeyTooLongError"
  | "KeyUnsupportedJsonValueError";

class FrondKeyErrorBase<TTag extends KeyErrorTag, TFields extends object> extends Error {
  readonly _tag: TTag;

  constructor(fields: { readonly _tag: TTag; readonly message: string } & TFields) {
    super(fields.message);
    this.name = fields._tag;
    this._tag = fields._tag;
    Object.assign(this, fields);
  }
}

export class KeyNonFiniteNumberError extends FrondKeyErrorBase<
  "KeyNonFiniteNumberError",
  { readonly path: string; readonly value: number }
> {}

export class KeyTooLongError extends FrondKeyErrorBase<
  "KeyTooLongError",
  { readonly maxLength: number; readonly actualLength: number }
> {}

export class KeyUnsupportedJsonValueError extends FrondKeyErrorBase<
  "KeyUnsupportedJsonValueError",
  { readonly path: string }
> {}

export type KeyError = KeyNonFiniteNumberError | KeyTooLongError | KeyUnsupportedJsonValueError;

const keyErrorTags = {
  KeyNonFiniteNumberError: true,
  KeyTooLongError: true,
  KeyUnsupportedJsonValueError: true,
} satisfies Record<KeyErrorTag, true>;

export function isKeyError(value: unknown): value is KeyError {
  return (
    typeof value === "object" &&
    value !== null &&
    "_tag" in value &&
    typeof value._tag === "string" &&
    value._tag in keyErrorTags
  );
}
