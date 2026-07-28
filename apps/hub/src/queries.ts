import type { HubCommand, QueryOutcome, StateQuery, ValuePolicy } from "@frondruntime/devtools";
import { Data, Deferred, Duration, Effect, Queue } from "effect";

/**
 * How long a query waits for its answer.
 *
 * Sized for "the app is alive but busy", not for "the app might come back".
 * Building a snapshot is synchronous work in the attached process, so the honest
 * upper bound is one long garbage collection plus a socket round trip. Waiting
 * longer would not turn a dead attachment into a live one; it would only leave
 * the caller — usually an agent, sometimes an MCP client with its own deadline —
 * holding an open request with nothing to show for it.
 */
export const QUERY_TIMEOUT: Duration.Input = "5 seconds";

/**
 * How many queries one attachment may have outstanding at once.
 *
 * The bound exists because the outbound queue is unbounded, and something has to
 * stop a half-open socket — one that accepts writes and never answers — from
 * accumulating commands until the timeout sweeps them. Refusing the thirty-third
 * says so immediately, which is more useful than a queue that silently drops.
 */
const MAX_IN_FLIGHT = 32;

/**
 * A query that never got an answer.
 *
 * Deliberately not the same thing as a `QueryOutcome` of `Failed`. That one is
 * the app replying that it could not build the snapshot, which is a fact about
 * the runtime; this one is the app not replying at all, which is a fact about
 * the connection. Collapsing them would let "the graph is broken" and "the
 * socket is gone" arrive as the same sentence.
 */
export class QueryUnanswered extends Data.TaggedError("QueryUnanswered")<{
  readonly reason: string;
}> {}

type Channel = {
  /**
   * Commands waiting to go down this attachment's `Attach` stream.
   *
   * Owned by the stream, not by the broker: the handler creates it, merges it
   * into what it returns, and the broker only ever writes. That ordering is
   * what keeps a command from being queued for a stream that was never built.
   */
  readonly outbound: Queue.Queue<HubCommand>;
  readonly pending: Map<string, Deferred.Deferred<QueryOutcome, QueryUnanswered>>;
};

/**
 * Turns the hub's one-way command stream into request/response.
 *
 * The hub is the RPC server and the app is the client, so the hub cannot call
 * the app — see `protocol.ts`. A query therefore travels as a command on the
 * `Attach` response stream and comes back as a separate unary `Frond.Reply`,
 * with a `requestId` as the only thing tying the two halves together. This class
 * is that tie: it mints the id, parks the caller on a `Deferred`, and resolves it
 * when the matching reply arrives.
 *
 * A plain class rather than a node or a service, for the same reason `EventRing`
 * is one: it holds per-attachment state that nothing renders. It is not
 * observable and is not meant to be.
 */
export class QueryBroker {
  private readonly channels = new Map<string, Channel>();

  constructor(private readonly timeout: Duration.Input = QUERY_TIMEOUT) {}

  /** Registers an attachment's outbound queue. Called once, as it attaches. */
  open(attachmentId: string, outbound: Queue.Queue<HubCommand>): void {
    this.channels.set(attachmentId, { outbound, pending: new Map() });
  }

  /**
   * Forgets an attachment and fails everything still waiting on it.
   *
   * The failing is the whole point. A socket that drops mid-query would
   * otherwise leave the caller parked until the timeout, reporting a five-second
   * silence for something the hub already knew about the instant the stream
   * ended.
   */
  close(attachmentId: string): void {
    const channel = this.channels.get(attachmentId);

    if (channel === undefined) {
      return;
    }

    this.channels.delete(attachmentId);

    for (const deferred of channel.pending.values()) {
      Deferred.doneUnsafe(
        deferred,
        Effect.fail(new QueryUnanswered({ reason: "the attachment detached before it answered" }))
      );
    }

    channel.pending.clear();
  }

  /**
   * Hands a reply to whoever asked for it.
   *
   * A reply with no waiting request is dropped rather than treated as an error:
   * that is what a query that already timed out looks like when its answer
   * finally arrives, and it is the app being slow, not the app being wrong. The
   * `attachmentId` is checked as well as the `requestId` so a reply can only
   * ever settle a request made on the same attachment.
   */
  settle(attachmentId: string, requestId: string, outcome: QueryOutcome): void {
    const deferred = this.channels.get(attachmentId)?.pending.get(requestId);

    if (deferred === undefined) {
      return;
    }

    Deferred.doneUnsafe(deferred, Effect.succeed(outcome));
  }

  /** True while the attachment can be queried. */
  has(attachmentId: string): boolean {
    return this.channels.has(attachmentId);
  }

  /**
   * Asks one attachment for a snapshot and waits for the answer.
   *
   * `values` is what the hub would like; the app clamps it against its own
   * ceiling before answering, and the policy it actually applied comes back on
   * the snapshot. Asking for more than an app will give is not an error here —
   * it is the ordinary case.
   */
  ask(
    attachmentId: string,
    query: StateQuery,
    values: ValuePolicy
  ): Effect.Effect<QueryOutcome, QueryUnanswered> {
    const channels = this.channels;
    const timeout = this.timeout;

    return Effect.gen(function* () {
      const channel = channels.get(attachmentId);

      if (channel === undefined) {
        return yield* new QueryUnanswered({
          reason: `attachment ${attachmentId} is not connected`,
        });
      }

      if (channel.pending.size >= MAX_IN_FLIGHT) {
        return yield* new QueryUnanswered({
          reason: `attachment ${attachmentId} already has ${MAX_IN_FLIGHT} queries outstanding and is not answering`,
        });
      }

      const requestId = crypto.randomUUID();
      const deferred = Deferred.makeUnsafe<QueryOutcome, QueryUnanswered>();

      // Registered before the offer, not after: the stream is drained on another
      // fiber, so the reply can be back before `Queue.offer` returns.
      channel.pending.set(requestId, deferred);

      return yield* Effect.ensuring(
        Effect.flatMap(
          Queue.offer(channel.outbound, { _tag: "Query", requestId, query, values }),
          (accepted) =>
            accepted
              ? Effect.timeoutOrElse(Deferred.await(deferred), {
                  duration: timeout,
                  orElse: () =>
                    Effect.fail(
                      new QueryUnanswered({
                        reason: `attachment ${attachmentId} did not answer within ${Duration.toMillis(timeout)}ms`,
                      })
                    ),
                })
              : Effect.fail(
                  new QueryUnanswered({ reason: `attachment ${attachmentId} stopped listening` })
                )
        ),
        // Runs on timeout and on interruption too, which is the case that
        // matters: an MCP client that hangs up mid-read would otherwise leave an
        // entry behind, and enough of those reach `MAX_IN_FLIGHT` on an
        // attachment that is perfectly healthy.
        Effect.sync(() => {
          channel.pending.delete(requestId);
        })
      );
    });
  }
}
