import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { copy } from "../lib/format";
import { toast } from "../lib/toast";
import { update } from "../lib/state";
import { ICopy } from "./icons";

const HUES = [152, 205, 28, 262, 340, 96, 182, 8];
export function Avatar({ pk, name, size = 34 }: { pk: string; name?: string; size?: number }) {
  const h = HUES[parseInt(pk.slice(0, 2), 16) % HUES.length];
  const initials = (name ?? "")
    .split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || pk.slice(0, 2).toUpperCase();
  return <span class="avatar" style={{ background: `oklch(0.55 0.09 ${h})`, width: size, height: size, fontSize: size * 0.36 }}>{initials}</span>;
}

export function CopyButton({ text, label = "Copy", done = "Copied", class: cls = "btn sm" }: { text: string; label?: string; done?: string; class?: string }) {
  const [ok, set] = useState(false);
  return (
    <button type="button" class={cls} onClick={async () => {
      if (await copy(text)) { set(true); setTimeout(() => set(false), 1600); } else toast("Copy failed. Select the text and copy it manually.", "error");
    }}><ICopy size={15} />{ok ? done : label}</button>
  );
}

export function Dialog({ title, children, onClose, actions }: { title: string; children: ComponentChildren; onClose: () => void; actions: ComponentChildren }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("input, textarea, button.primary, button")?.focus();
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    addEventListener("keydown", k);
    return () => { removeEventListener("keydown", k); prev?.focus?.(); };
  }, []);
  return (
    <div class="dialog-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="dialog" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <h2>{title}</h2>
        {children}
        <div class="actions">{actions}</div>
      </div>
    </div>
  );
}

/** Imperative confirm dialog. */
export function useConfirm() {
  const [st, set] = useState<null | { title: string; body: ComponentChildren; cta: string; danger?: boolean; resolve: (v: boolean) => void }>(null);
  const ask = (title: string, body: ComponentChildren, cta: string, danger = false) =>
    new Promise<boolean>((resolve) => set({ title, body, cta, danger, resolve }));
  const close = (v: boolean) => { st?.resolve(v); set(null); };
  const node = st && (
    <Dialog title={st.title} onClose={() => close(false)} actions={<>
      <button class="btn" onClick={() => close(false)}>Cancel</button>
      <button class={st.danger ? "btn danger solid" : "btn primary"} onClick={() => close(true)}>{st.cta}</button>
    </>}>
      <div class="stack muted">{st.body}</div>
    </Dialog>
  );
  return { ask, node };
}

export function Busy({ on, children }: { on: boolean; children: ComponentChildren }) {
  return <>{on ? "Working…" : children}</>;
}

export function Skeleton({ lines = 5 }: { lines?: number }) {
  return <div class="entries" aria-busy="true" aria-label="Loading">{Array.from({ length: lines }, (_, i) => <div key={i} class="skeleton sk-card" style={{ opacity: 1 - i * 0.13 }} />)}</div>;
}

export function Empty({ title, children, action }: { title: string; children?: ComponentChildren; action?: ComponentChildren }) {
  return <div class="empty"><h3>{title}</h3>{children && <p>{children}</p>}{action}</div>;
}

/** Runs an async action with busy flag + error toast. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const run = async <T,>(fn: () => Promise<T>, ok?: string): Promise<T | undefined> => {
    setBusy(true);
    try {
      const r = await fn();
      update(); // core applies our own writes locally without firing live(); re-render explicitly
      if (ok) toast(ok, "ok");
      return r;
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
      console.error(e);
      return undefined;
    } finally { setBusy(false); }
  };
  return { busy, run };
}

export function useDebounced<T>(value: T, ms = 180): T {
  const [v, set] = useState(value);
  useEffect(() => { const t = setTimeout(() => set(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}
