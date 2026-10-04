import { useEffect, useState } from "preact/hooks";
import { dismiss, onToasts, type Toast } from "../lib/toast";
import { IX } from "./icons";

export function Toasts() {
  const [list, set] = useState<Toast[]>([]);
  useEffect(() => onToasts(set), []);
  return (
    <div class="toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} class={`toast ${t.kind}`}>
          <span>{t.text}</span>
          <button aria-label="Dismiss" onClick={() => dismiss(t.id)}><IX size={14} /></button>
        </div>
      ))}
    </div>
  );
}
