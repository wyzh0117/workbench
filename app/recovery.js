/**
 * @template T
 * @returns {(task: () => T | PromiseLike<T>) => Promise<T>}
 */
export function createSerialQueue() {
  /** @type {Promise<any>} */
  let tail = Promise.resolve();
  return (task) => {
    const run = tail.then(task, task);
    tail = run.catch(() => {});
    return run;
  };
}

export function recoveryWarning(value) {
  if (typeof value === "string") {
    try {
      return recoveryWarning(JSON.parse(value));
    } catch {
      return /recovery|恢复日志/i.test(value) ? value : "";
    }
  }
  if (!value || typeof value !== "object") return "";
  if (Array.isArray(value)) {
    return value.map((child) => recoveryWarning(child)).find(Boolean) || "";
  }
  for (const key of [
    "recovery_warning",
    "recoveryWarning",
    "recovery_warning_message",
    "recoveryWarningMessage",
  ]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    if (candidate && typeof candidate === "object") {
      const nested = recoveryWarning(candidate);
      if (nested) return nested;
    }
  }
  for (const key of ["warning", "warnings"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && /recovery|恢复日志/i.test(candidate)) return candidate.trim();
    const nested = recoveryWarning(candidate);
    if (nested) return nested;
  }
  for (const key of ["value", "result", "data"]) {
    const nested = recoveryWarning(value[key]);
    if (nested) return nested;
  }
  return "";
}
