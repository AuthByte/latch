import { useEffect, useId, useRef, useState } from "react";
import { errorMessage } from "../api";
import { useDebounced } from "../hooks";

export type Check =
  | { state: "idle" }
  | { state: "invalid"; message: string }
  | { state: "checking" }
  | { state: "available" }
  | { state: "unavailable"; message: string }
  | { state: "error"; message: string };

type Verdict = { available: boolean; reason?: "invalid" | "taken" | "reserved" };

const REASONS: Record<NonNullable<Verdict["reason"]>, string> = {
  invalid: "That isn't a valid name.",
  taken: "Already taken. Try another.",
  reserved: "Reserved. Try another.",
};

/**
 * Debounced availability check for a handle, username or agent name. `problem` is the
 * local syntax check; `lookup` asks the server (only called once the syntax is valid).
 */
export function useAvailability(
  value: string,
  problem: (v: string) => string | null,
  lookup: (v: string, signal: AbortSignal) => Promise<Verdict>,
): Check {
  const debounced = useDebounced(value, 350);
  const [result, setResult] = useState<Check>({ state: "idle" });
  const problemRef = useRef(problem);
  problemRef.current = problem;
  const lookupRef = useRef(lookup);
  lookupRef.current = lookup;
  const localProblem = value ? problem(value) : null;

  useEffect(() => {
    if (!debounced) {
      setResult({ state: "idle" });
      return;
    }
    if (problemRef.current(debounced)) return;
    const ctl = new AbortController();
    setResult({ state: "checking" });
    lookupRef
      .current(debounced, ctl.signal)
      .then((a) => {
        setResult(
          a.available
            ? { state: "available" }
            : { state: "unavailable", message: REASONS[a.reason ?? "taken"] },
        );
      })
      .catch((e) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setResult({ state: "error", message: errorMessage(e) });
      });
    return () => ctl.abort();
  }, [debounced]);

  if (!value) return { state: "idle" };
  if (localProblem) return { state: "invalid", message: localProblem };
  // Typed past the debounce: don't show a stale verdict for a different string.
  if (debounced !== value) return { state: "checking" };
  return result;
}

type Props = {
  label: string;
  value: string;
  onChange: (v: string) => void;
  check: Check;
  /** Fixed text shown before the input, e.g. "@" or "@nebula.". */
  prefix: string;
  placeholder: string;
  /** Shown while nothing has been typed. */
  idleHint: string;
  /** Shown when available, e.g. "@nebula.capy is available." */
  availableText: string;
};

/** Text input with a fixed visible prefix and a live availability line. */
export function NameInput({ label, value, onChange, check, prefix, placeholder, idleHint, availableText }: Props) {
  const id = useId();
  const descId = `${id}-d`;
  const invalid = check.state === "invalid" || check.state === "unavailable";
  return (
    <div className="field">
      <label htmlFor={id} className="label">
        {label}
      </label>
      <div className={`handle-input ${invalid ? "is-invalid" : check.state === "available" ? "is-valid" : ""}`}>
        <span className="handle-at" aria-hidden="true" title={prefix}>
          {prefix}
        </span>
        <input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value.toLowerCase().replace(/\s+/g, ""))}
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          maxLength={40}
          placeholder={placeholder}
          aria-invalid={invalid}
          aria-describedby={descId}
        />
      </div>
      <p id={descId} className={`hint handle-status ${invalid ? "bad" : check.state === "available" ? "good" : ""}`} aria-live="polite">
        {check.state === "idle" && idleHint}
        {check.state === "checking" && "Checking availability…"}
        {check.state === "available" && availableText}
        {(check.state === "invalid" || check.state === "unavailable" || check.state === "error") && check.message}
      </p>
    </div>
  );
}
