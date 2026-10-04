import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { Fingerprints } from "../api";

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <span className="spinner" role="status">
      <span className="spinner-dot" aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </span>
  );
}

export function PageLoading({ label = "Loading" }: { label?: string }) {
  return (
    <div className="page-loading">
      <Spinner label={label} />
      <p className="muted mono">{label}…</p>
    </div>
  );
}

/** Error text surfaced from the API `hint`. Announced to screen readers. */
export function ErrorNote({ message, onRetry }: { message: string | null; onRetry?: () => void }) {
  return (
    <div aria-live="assertive" className="live">
      {message ? (
        <p className="note note-error" role="alert">
          <span>{message}</span>
          {onRetry ? (
            <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>
              Try again
            </button>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

export function InfoNote({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "warn" | "ok" }) {
  return <p className={`note note-${tone}`}>{children}</p>;
}

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2000);
  }
  return (
    <>
      <button type="button" className="btn btn-ghost btn-sm" onClick={copy}>
        {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : label}
      </button>
      <span className="sr-only" aria-live="polite">
        {state === "copied" ? "Copied to clipboard" : state === "failed" ? "Copy failed, select the text manually" : ""}
      </span>
    </>
  );
}

/** A labelled, copyable, selectable command/URL block. */
export function CopyField({ label, value, hint }: { label: string; value: string; hint?: string }) {
  const id = useId();
  return (
    <div className="copyfield">
      <div className="copyfield-head">
        <span id={id} className="label">
          {label}
        </span>
        <CopyButton value={value} />
      </div>
      <pre className="code" tabIndex={0} aria-labelledby={id}>
        <code>{value}</code>
      </pre>
      {hint ? <p className="hint">{hint}</p> : null}
    </div>
  );
}

export function Fingerprint({ label, value, tone }: { label: string; value?: string; tone?: "pinned" | "current" | "bad" }) {
  return (
    <div className={`fp ${tone ? `fp-${tone}` : ""}`}>
      <span className="fp-label">{label}</span>
      <code className="fp-value">{value ?? "—"}</code>
    </div>
  );
}

export function FingerprintPair({ fp, label }: { fp: Fingerprints; label?: string }) {
  return (
    <div className="fp-pair" aria-label={label}>
      <Fingerprint label="signing" value={fp.signing} />
      <Fingerprint label="age" value={fp.age} />
    </div>
  );
}

export function Badge({ tone, children }: { tone: "ok" | "warn" | "bad" | "idle"; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

type ModalProps = {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  tone?: "default" | "danger";
};

/** Accessible modal on the native <dialog> element (focus trap + Esc for free). */
export function Modal({ open, title, onClose, children, tone = "default" }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={`modal ${tone === "danger" ? "modal-danger" : ""}`}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {open ? (
        <div className="modal-body">
          <h2 id={titleId}>{title}</h2>
          {children}
        </div>
      ) : null}
    </dialog>
  );
}
