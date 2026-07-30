import type { Effect } from "effect";
import type { RuntimeId, RuntimeWorkContext } from "../runtime/types";

export type RuntimeSignalChannel = string & { readonly __brand: "Runtime.SignalChannel" };

export type RuntimeSignal = {
  readonly channel: RuntimeSignalChannel;
  readonly name: string;
  readonly payload: unknown;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
};

export type RuntimeSignalRecord = {
  readonly runtimeId: RuntimeId;
  readonly sequence: number;
  readonly recordedAt: number;
  readonly signal: RuntimeSignal;
};

export type RuntimeSignalPolicy =
  | {
      readonly retention: "none";
    }
  | {
      readonly retention: "bounded";
      readonly bufferSize?: number | undefined;
    };

/**
 * What one channel can carry: a map from signal name to payload type.
 *
 * Types only. There is no effect `Schema` here and no runtime artifact per
 * event, because a signal payload is built by the same application that consumes
 * it — it does not cross a trust boundary on its way to the bus. Validating at
 * publish would buy a decode on every publish to re-discover a mistake the
 * compiler already refused to compile, and it would push a value into the
 * program (the schema) where a type is enough.
 *
 * A `Schema` map is a strict superset of this, so it can arrive later as an
 * opt-in for the channels that do read payloads off a wire, without the
 * type-only form growing a runtime dependency to accommodate it.
 *
 * `object` and not the `Record<string, unknown>` it reads as, which will look
 * like something to tighten and is not: a TypeScript `interface` gets no implicit
 * index signature, so `interface CheckoutEvents { ... }` does not satisfy
 * `Record<string, unknown>` — and an interface is exactly how an event map gets
 * declared, being the only form that merges across modules.
 *
 * What the looser constraint gives up is narrow. `object` admits shapes
 * `Record<string, unknown>` rejected — `string[]` among them, whose
 * `keyof TEvents & string` is `"at" | "length" | ...` rather than the empty set
 * it would be convenient to assume. But names come out of that intersection
 * either way, so a wrong type argument yields a channel whose declared names are
 * useless, not one that types a payload it cannot carry: the publisher and the
 * subscriber read the same `TEvents`, so they are wrong about the same names in
 * the same direction. The constraint was never what made that agree.
 */
export type SignalEventMap = object;

/**
 * One signal on a channel typed by `TEvents`, as a union over the event names.
 *
 * A union of single-name records rather than the flatter
 * `{ name: keyof TEvents; payload: TEvents[keyof TEvents] }`: the flat form
 * accepts every name paired with every payload, which is the mistake this type
 * exists to reject. Being a discriminated union is also what makes
 * `switch (signal.name)` narrow the payload in each branch — the same shape the
 * runtime's own event types use, for the same reason.
 */
export type RuntimeSignalOf<TEvents extends SignalEventMap> = {
  readonly [K in keyof TEvents & string]: {
    readonly channel: RuntimeSignalChannel;
    readonly name: K;
    readonly payload: TEvents[K];
    readonly metadata?: Readonly<Record<string, unknown>> | undefined;
  };
}[keyof TEvents & string];

export type RuntimeSignalRecordOf<TEvents extends SignalEventMap> = {
  readonly runtimeId: RuntimeId;
  readonly sequence: number;
  readonly recordedAt: number;
  readonly signal: RuntimeSignalOf<TEvents>;
};

/**
 * The trailing arguments of a `signal(name, ...)` call, from the payload type.
 *
 * An event declared `void` carries nothing, so `signal("app.opened")` is the
 * whole call and handing it a payload anyway is the mistake worth catching. Its
 * payload slot narrows to `undefined` rather than disappearing, which is the one
 * concession here: dropping the slot would read better at the call site but
 * would also take `metadata` with it, and correlation metadata is no less useful
 * on an event that has no payload of its own.
 *
 * The comparison is bracketed because a bare `TPayload extends void` distributes
 * over unions, so `string | void` would take the void branch for its `void`
 * member and quietly drop the string.
 *
 * A payload that already admits `undefined` keeps the argument optional, and
 * that clause is what preserves the untyped channel: with no event map every
 * name carries `unknown`, `undefined` is one of its inhabitants, and
 * `signal("name")` with no payload has always been legal there.
 */
// biome-ignore lint/suspicious/noConfusingVoidType: `void` is the payload an event map declares to mean "carries nothing", so detecting it is the point.
export type SignalPayloadArgs<TPayload> = [TPayload] extends [void]
  ? [payload?: undefined, metadata?: Readonly<Record<string, unknown>> | undefined]
  : [undefined] extends [TPayload]
    ? [payload?: TPayload, metadata?: Readonly<Record<string, unknown>> | undefined]
    : [payload: TPayload, metadata?: Readonly<Record<string, unknown>> | undefined];

/**
 * What registering a channel at boot actually needs: where it goes, and how much
 * of it is kept.
 *
 * Split out of {@link RuntimeSignalChannelDefinition} so that a set of channels
 * typed by different event maps is registrable at all. `signal` and `subscriber`
 * are contravariant in the event map, so a checkout channel is not assignable to
 * a definition of some other channel's events, and `RuntimeOptions.channels` is
 * by nature a heterogeneous list. The registration is the part every channel
 * agrees on and the only part `signalPoliciesFromChannels` reads, so widening the
 * field to it makes the list type-check for the right reason.
 *
 * The alternative was a variance escape hatch on the definition — bivariant
 * method syntax, or an `any` in the event map constraint — which buys the same
 * list at the cost of weakening the type that catches payload mistakes, for every
 * consumer, to satisfy one registry that never looks at the members in question.
 */
export type RuntimeSignalChannelRegistration = {
  readonly name: string;
  readonly channel: RuntimeSignalChannel;
  readonly policy: RuntimeSignalPolicy;
};

/**
 * A channel, its retention policy, and the factories typed by its event map.
 *
 * `TEvents` defaults to the map that types nothing — any name, an `unknown`
 * payload — which is what {@link defineChannel} produces when it is called
 * without a type argument, and what the bare `RuntimeSignalChannelDefinition`
 * means anywhere it is still written by hand.
 */
export interface RuntimeSignalChannelDefinition<
  TEvents extends SignalEventMap = Record<string, unknown>,
> extends RuntimeSignalChannelRegistration {
  readonly signal: <K extends keyof TEvents & string>(
    name: K,
    ...args: SignalPayloadArgs<TEvents[K]>
  ) => RuntimeSignalOf<TEvents>;
  /**
   * A subscriber that only sees this channel, with its records narrowed.
   *
   * There is no `channels` field to pass, because the delivery filter is what
   * makes the narrowing true rather than a claim: see {@link defineChannel}. The
   * corollary is worth stating — a subscriber written as a plain object literal
   * gets `RuntimeSignalRecord`, and a hand-rolled one that omits `channels`
   * receives every channel's traffic, so the wide record is the correct type for
   * it.
   */
  readonly subscriber: (input: {
    readonly name: string;
    readonly handle: (record: RuntimeSignalRecordOf<TEvents>) => Effect.Effect<void, unknown>;
  }) => RuntimeSignalSubscriber;
}

export type RuntimeSignalQuery = {
  readonly channel?: RuntimeSignalChannel | undefined;
  readonly limit?: number | undefined;
};

export interface RuntimeSignalSubscription {
  readonly unsubscribe: () => void;
}

export interface RuntimeSignalSubscriber {
  readonly name: string;
  readonly channels?: ReadonlyArray<RuntimeSignalChannel> | undefined;
  readonly handle: (record: RuntimeSignalRecord) => Effect.Effect<void, unknown>;
}

export interface RuntimeSignalAccess {
  readonly publish: (
    signal: RuntimeSignal,
    work?: RuntimeWorkContext | undefined
  ) => Effect.Effect<void>;
  readonly readRetained: (
    query?: RuntimeSignalQuery | undefined
  ) => Effect.Effect<ReadonlyArray<RuntimeSignalRecord>>;
  readonly subscribe: (
    subscriber: RuntimeSignalSubscriber
  ) => Effect.Effect<RuntimeSignalSubscription>;
}

/**
 * Brands a runtime signal channel name.
 *
 * Use for ad hoc channels when retention policy is configured elsewhere. Prefer
 * `defineChannel` when the channel and policy should travel together.
 */
export const channel = (channel: string): RuntimeSignalChannel => channel as RuntimeSignalChannel;

/**
 * Defines a signal channel with its retention policy and signal factory.
 *
 * Runtime options can register the returned definition so publishing code does
 * not carry retention configuration around separately.
 *
 * Pass a {@link SignalEventMap} to type the channel by the events it carries:
 * `defineChannel<CheckoutEvents>({ name, policy })` gives a `signal` that only
 * accepts declared names with the payload each one declares, and a
 * {@link RuntimeSignalChannelDefinition.subscriber} whose records narrow by name.
 * Omitting it is the untyped channel this has always returned, which is why the
 * type parameter defaults rather than being required.
 *
 * ## The one cast
 *
 * The definition is built erased and asserted into its typed view, because there
 * are no two objects here to build: payload types are gone before anything runs,
 * and `signal` copies the name it was handed onto a record the event map already
 * says that name carries. What the assertion is needed for is `handle`, which is
 * contravariant in the event map. A subscriber that accepts only checkout records
 * is not assignable to one the bus may hand any record to, and the bus is
 * heterogeneous on purpose — one `Set` of subscribers across every channel.
 *
 * The routing half of that narrowing is enforced rather than asserted:
 * `subscriber` pins `channels` to this channel, and `acceptsSignal` in the signal
 * bus filters delivery by exactly that field. So "records from this channel only"
 * is a projection of an invariant the bus already tests, not a promise this module
 * makes on its own. The corollary follows and is the right behavior: a subscriber
 * assembled by hand, with no `channels` filter, receives every channel's traffic
 * and gets no narrowing.
 *
 * The payload half is not enforced, and the difference matters. Channel equality
 * is not payload equality: {@link signal} takes `name: string` and
 * `payload?: unknown`, so
 * `Signals.signal({ channel: Checkout.channel, name: "checkout.started", payload: 42 })`
 * compiles with no cast, routes to this channel's subscribers, and reaches a
 * handler that has been told the payload is a cart. What holds the types together
 * is that `definition.signal` is the way publishers build records — it is the
 * narrow constructor, and going around it gives the wide one. That is a
 * convention, so the escape hatch stays open for adapters bridging a wire, and
 * the untyped `signal` is where a channel's typing ends rather than where it is
 * enforced.
 */
export const defineChannel = <TEvents extends SignalEventMap = Record<string, unknown>>(input: {
  readonly name: string;
  readonly policy: RuntimeSignalPolicy;
}): RuntimeSignalChannelDefinition<TEvents> => {
  const signalChannel = channel(input.name);
  const definition: RuntimeSignalChannelDefinition = {
    name: input.name,
    channel: signalChannel,
    policy: input.policy,
    signal: (
      name: string,
      payload?: unknown,
      metadata?: Readonly<Record<string, unknown>> | undefined
    ) =>
      signal({
        channel: signalChannel,
        name,
        payload,
        metadata,
      }),
    subscriber: (subscriberInput) => ({
      name: subscriberInput.name,
      channels: [signalChannel],
      handle: subscriberInput.handle,
    }),
  };

  return definition as RuntimeSignalChannelDefinition<TEvents>;
};

/**
 * Creates a runtime signal record payload.
 *
 * Signals are best-effort runtime messages. Publish them for domain events,
 * diagnostics, or adapter communication; do not use them as graph dependencies.
 */
export const signal = (input: {
  readonly channel: string | RuntimeSignalChannel;
  readonly name: string;
  readonly payload?: unknown;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}): RuntimeSignal => ({
  channel: input.channel as RuntimeSignalChannel,
  name: input.name,
  payload: input.payload,
  metadata: input.metadata,
});

export const Signals = {
  channel,
  defineChannel,
  signal,
} as const;
