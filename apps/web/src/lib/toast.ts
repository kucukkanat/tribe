export type Toast = { id: number; kind: "info" | "error" | "ok"; text: string };
let seq = 0;
let toasts: Toast[] = [];
const subs = new Set<(t: Toast[]) => void>();
const emit = () => subs.forEach((f) => f(toasts));

export function toast(text: string, kind: Toast["kind"] = "info", ms = kind === "error" ? 6000 : 3200) {
  const t = { id: ++seq, kind, text };
  toasts = [...toasts, t].slice(-4);
  emit();
  setTimeout(() => dismiss(t.id), ms);
}
export const toastError = (e: unknown, prefix?: string) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(e);
  toast(prefix ? `${prefix}: ${msg}` : msg, "error");
};
export function dismiss(id: number) { toasts = toasts.filter((t) => t.id !== id); emit(); }
export function onToasts(f: (t: Toast[]) => void) { subs.add(f); return () => { subs.delete(f); }; }
