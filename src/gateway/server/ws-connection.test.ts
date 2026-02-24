import { describe, expect, it, vi } from "vitest";
import { MAX_BUFFERED_BYTES } from "../server-constants.js";
import { __createBackpressureGuardedJsonSendForTest } from "./ws-connection.js";

describe("gateway ws send backpressure guard", () => {
  it("closes without stringifying when bufferedAmount already exceeds the limit", () => {
    const socket = {
      bufferedAmount: MAX_BUFFERED_BYTES + 1,
      send: vi.fn(),
    };
    const close = vi.fn();
    const setCloseCause = vi.fn();

    const send = __createBackpressureGuardedJsonSendForTest({
      socket: socket as never,
      close,
      setCloseCause,
    });

    const obj = {
      toJSON() {
        throw new Error("should not stringify");
      },
    };

    expect(() => send(obj)).not.toThrow();
    expect(socket.send).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledWith(1008, "slow consumer");
    expect(setCloseCause).toHaveBeenCalledWith(
      "ws-backpressure",
      expect.objectContaining({
        maxBufferedBytes: MAX_BUFFERED_BYTES,
        bufferedAmount: MAX_BUFFERED_BYTES + 1,
        phase: "pre-stringify",
      }),
    );
  });

  it("closes when the next send would exceed the limit", () => {
    const maxBufferedBytes = 64;
    const socket = {
      bufferedAmount: 60,
      send: vi.fn(),
    };
    const close = vi.fn();
    const setCloseCause = vi.fn();

    const send = __createBackpressureGuardedJsonSendForTest({
      socket: socket as never,
      close,
      setCloseCause,
      maxBufferedBytes,
    });

    send({ data: "x".repeat(256) });

    expect(socket.send).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledWith(1008, "slow consumer");
    expect(setCloseCause).toHaveBeenCalledWith(
      "ws-backpressure",
      expect.objectContaining({
        maxBufferedBytes,
        bufferedAmount: 60,
        phase: "pre-send",
        frameBytes: expect.any(Number),
      }),
    );
  });
});
