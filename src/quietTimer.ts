// Fires onQuiet once output has been silent for quietMs. Output calls touch()
// per chunk; that only stamps the time, and a single timer re-arms itself for
// the remaining gap, so a chatty process costs one Date.now() per chunk
// instead of a clearTimeout/setTimeout pair.
export interface QuietTimer {
  touch(): void;
  cancel(): void;
}

export function createQuietTimer(quietMs: number, onQuiet: () => void): QuietTimer {
  let lastOutputAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const arm = (delay: number) => {
    timer = setTimeout(() => {
      timer = null;
      const elapsed = Date.now() - lastOutputAt;
      if (elapsed < quietMs) arm(quietMs - elapsed);
      else onQuiet();
    }, delay);
  };

  return {
    touch() {
      lastOutputAt = Date.now();
      if (!timer) arm(quietMs);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
