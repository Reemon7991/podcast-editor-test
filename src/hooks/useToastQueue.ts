"use client";

import { useCallback, useState } from "react";
import type { ToastMessage } from "../components/ui/Toast";

const DEFAULT_CAPACITY = 3;

/**
 * Small FIFO queue in front of ui/Toast.tsx's single-slot display — lets
 * multiple independent async features (silence removal, noise reduction, and
 * any future one) each report their own outcome via `push` without one
 * clobbering the other mid-display if two happen to finish close together.
 * See NOISE_REDUCTION_PLAN.md.
 *
 * `current` is just `queue[0]` — no separate state to keep in sync, so
 * there's nothing that needs an effect to "advance" it (an earlier version
 * did, via a setState call inside a useEffect body; this repo's
 * eslint-plugin-react-hooks config flags that as cascading-render-prone, and
 * it's also just unnecessary indirection over a value that's already
 * derivable). `dismiss` shifts the queue, which is the same action as
 * "reveal the next one" by construction — no separate advance step exists to
 * forget.
 */
export function useToastQueue(capacity = DEFAULT_CAPACITY) {
  const [queue, setQueue] = useState<ToastMessage[]>([]);
  const current = queue[0] ?? null;

  const push = useCallback(
    (message: ToastMessage) => {
      setQueue((q) => (q.length >= capacity ? q : [...q, message]));
    },
    [capacity]
  );

  const dismiss = useCallback(() => setQueue((q) => q.slice(1)), []);

  return { current, push, dismiss };
}
