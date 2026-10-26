// Flow control for the binary pty channel: the host pauses reading once too
// many bytes are unacked, so every byte xterm has finished writing must
// eventually be acked. Acks are batched below the host's low mark, and any
// remainder is flushed when the write queue drains - otherwise the host could
// stay paused with nothing left to trigger the final ack.
export const ACK_BATCH_BYTES = 5 * 1024;

export interface AckBatcher {
  // Call once per chunk before writing it; returns the write-completion callback.
  track(bytes: number): () => void;
}

export function createAckBatcher(ack: (bytes: number) => void, threshold = ACK_BATCH_BYTES): AckBatcher {
  let inflight = 0;
  let unacked = 0;
  return {
    track(bytes) {
      inflight++;
      return () => {
        inflight--;
        unacked += bytes;
        if (unacked >= threshold || inflight === 0) {
          const n = unacked;
          unacked = 0;
          if (n > 0) ack(n);
        }
      };
    },
  };
}
