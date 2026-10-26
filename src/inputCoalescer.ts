// Keeps keystrokes in order: pty_write runs each call on its own host task, so
// two quick writes could land swapped. Only one write is in flight at a time;
// input typed meanwhile is buffered and sent together when it resolves.
export interface InputCoalescer {
  push(data: string): void;
}

export function createInputCoalescer(
  send: (data: string) => Promise<void>,
  onError: (err: unknown) => void,
): InputCoalescer {
  let inflight = false;
  let buffered = "";

  const pump = (data: string) => {
    inflight = true;
    send(data)
      .catch(onError)
      .finally(() => {
        if (buffered) {
          const next = buffered;
          buffered = "";
          pump(next);
        } else {
          inflight = false;
        }
      });
  };

  return {
    push(data) {
      if (inflight) buffered += data;
      else pump(data);
    },
  };
}
