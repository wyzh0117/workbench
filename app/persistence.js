function clone(value) {
  return structuredClone(value);
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(freeze);
  return Object.freeze(value);
}

export function normalizeProjectDir(value) {
  const path = String(value ?? "").trim().replaceAll("\\", "/");
  if (!path) return "";
  const normalized = path.replace(/\/+$/, "");
  if (!normalized && path.startsWith("/")) return "/";
  if (/^[A-Za-z]:$/.test(normalized)) return `${normalized}/`;
  return normalized;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function identityOf(request) {
  return {
    project_dir: normalizeProjectDir(request?.project_dir),
    expected_project_id: request?.expected_project_id ?? null,
    editor_generation: request?.editor_generation ?? null,
    lease_generation: request?.lease_generation ?? null,
  };
}

function identityKey(identity) {
  return stableJson(identityOf(identity));
}

const defaultSchedule = /** @type {(callback: () => void, delay: number) => number} */ (
  globalThis.setTimeout.bind(globalThis)
);
const defaultCancel = /** @type {(id: number) => void} */ (
  globalThis.clearTimeout.bind(globalThis)
);

function revisionOrder(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return ["number", value];
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return ["date", Date.parse(value)];
  throw new TypeError("save revision must be a positive safe integer or a valid timestamp");
}

function compareRevision(left, right) {
  const [leftKind, leftValue] = revisionOrder(left);
  const [rightKind, rightValue] = revisionOrder(right);
  if (leftKind !== rightKind) throw new TypeError("save revisions must use one monotonic format per project generation");
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function codedError(code, message) {
  const error = new Error(message);
  Object.defineProperty(error, "code", { value: code, enumerable: true });
  return error;
}

function requiresReconciliation(error) {
  const code = String(error?.code ?? "");
  const commitState = error?.commit_state ?? error?.details?.commit_state;
  return commitState !== "not_committed" || /external_modification_conflict|project_(?:not_open|lock_lost|lock_not_owned|locked)|save_response_binding_mismatch/.test(code);
}

function immutableRequest(value) {
  const request = clone(value);
  request.project_dir = normalizeProjectDir(request.project_dir);
  if (typeof request.operation_id !== "string" || !request.operation_id) {
    throw new TypeError("save request requires operation_id");
  }
  revisionOrder(request.revision);
  if (typeof request.expected_project_id !== "string" || !request.expected_project_id) {
    throw new TypeError("save request requires expected_project_id");
  }
  if (!Number.isSafeInteger(request.editor_generation) || request.editor_generation < 0) {
    throw new TypeError("save request requires a valid editor_generation");
  }
  if (
    request.lease_generation !== null && typeof request.lease_generation !== "string" &&
    !Number.isSafeInteger(request.lease_generation)
  ) throw new TypeError("save request requires a nullable lease_generation");
  if (!Object.hasOwn(request, "expected_fingerprint") || !request.project || typeof request.project !== "object") {
    throw new TypeError("save request requires a revision and immutable project snapshot");
  }
  if (request.project.project?.id !== request.expected_project_id) {
    throw new TypeError("save snapshot project id does not match expected_project_id");
  }
  return freeze(request);
}

function validateSaveResult(result, request) {
  const expected = {
    project_id: request.expected_project_id,
    lease_generation: request.lease_generation,
    editor_generation: request.editor_generation,
    operation_id: request.operation_id,
    revision: request.revision,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (!result || !Object.hasOwn(result, key) || result[key] !== value) {
      throw codedError("save_response_binding_mismatch", `save response ${key} does not match its request`);
    }
  }
  if (!(["written", "unchanged"].includes(result.outcome))) {
    throw codedError("save_response_binding_mismatch", "save response has no committed outcome");
  }
  if (!result.fingerprint || typeof result.fingerprint.exists !== "boolean") {
    throw codedError("save_response_binding_mismatch", "save response has no valid fingerprint");
  }
  return result;
}

/**
 * One active canonical write and one latest cumulative pending snapshot.
 * Timers are injectable so the save contract can be checked without sleeping.
 * @param {{write: (request: any) => Promise<any> | any, onResult?: ((result: any, request: any) => void) | null, onError?: ((error: Error, request: any) => void) | null, debounceMs?: number, maxWaitMs?: number, setTimeout?: (callback: () => void, delay: number) => number, clearTimeout?: (id: number) => void}} options
 */
export function createPersistenceScheduler({
  write,
  onResult = null,
  onError = null,
  debounceMs = 350,
  maxWaitMs = 2000,
  setTimeout: schedule = defaultSchedule,
  clearTimeout: cancel = defaultCancel,
} = {}) {
  if (typeof write !== "function") throw new TypeError("persistence scheduler requires write");
  let generation = 0;
  let currentIdentity = null;
  let currentIdentityKey = "";
  let acknowledgedInputFingerprint;
  let acknowledgedFingerprint;
  let acknowledgedGeneration = -1;
  let initialFingerprint;
  let highestRequest = null;
  let lastResult = null;
  let lastFailure = null;
  let paused = false;
  let trailingTimer = 0;
  let maxTimer = 0;
  let pending = null;
  let inflight = null;
  let closed = false;
  const drains = new Set();

  function clearTimers() {
    if (trailingTimer) cancel(trailingTimer);
    if (maxTimer) cancel(maxTimer);
    trailingTimer = 0;
    maxTimer = 0;
  }

  function settle(waiters, result, error = null) {
    for (const waiter of waiters) {
      if (error) waiter.reject(error);
      else waiter.resolve(result);
    }
  }

  function hasWork() {
    return Boolean(pending || inflight);
  }

  function resolveDrains() {
    if (hasWork()) return;
    for (const drain of drains) {
      drains.delete(drain);
      if (lastFailure) drain.reject(lastFailure);
      else drain.resolve();
    }
  }

  function schedulePending() {
    if (!pending || closed) return;
    if (trailingTimer) cancel(trailingTimer);
    pending.ready = pending.maxWaitReached;
    trailingTimer = schedule(() => {
      trailingTimer = 0;
      if (pending?.generation !== generation) return;
      pending.ready = true;
      pump();
    }, debounceMs);
    if (!pending.maxWaitReached && !maxTimer) {
      maxTimer = schedule(() => {
        maxTimer = 0;
        if (pending?.generation !== generation) return;
        pending.maxWaitReached = true;
        pending.ready = true;
        pump();
      }, maxWaitMs);
    }
  }

  function pump() {
    if (closed || paused || inflight || !pending || !pending.ready || pending.generation !== generation) return;
    const item = pending;
    pending = null;
    clearTimers();
    const request = clone(item.request);
    if (
      acknowledgedGeneration === item.generation &&
      (
        stableJson(request.expected_fingerprint) === stableJson(initialFingerprint) ||
        stableJson(request.expected_fingerprint) === stableJson(acknowledgedInputFingerprint)
      )
    ) request.expected_fingerprint = clone(acknowledgedFingerprint);
    const flight = {
      generation: item.generation,
      request,
      previousFingerprint: request.expected_fingerprint,
      waiters: item.waiters,
    };
    inflight = flight;
    Promise.resolve().then(() => write(freeze(request))).then((result) => {
      validateSaveResult(result, request);
      if (
        flight.generation === generation &&
        (result?.outcome === "written" || result?.outcome === "unchanged") &&
        result?.fingerprint !== undefined
      ) {
        // Carry this successful CAS forward to the next cumulative write in the
        // same editor lease. The bridge still checks the resulting fingerprint.
        acknowledgedInputFingerprint = flight.previousFingerprint;
        acknowledgedFingerprint = result.fingerprint;
        acknowledgedGeneration = flight.generation;
        lastFailure = null;
        lastResult = result;
      }
      if (flight.generation === generation && !closed) {
        try { onResult?.(result, request); } catch { /* A UI callback cannot undo a committed write. */ }
      }
      settle(flight.waiters, result);
    }).catch((error) => {
      if (flight.generation === generation) {
        lastFailure = error;
        paused = requiresReconciliation(error);
      }
      if (flight.generation === generation && !closed) {
        try { onError?.(error, request); } catch { /* Preserve the storage error as the request result. */ }
      }
      settle(flight.waiters, null, error);
    }).finally(() => {
      if (inflight === flight) inflight = null;
      pump();
      resolveDrains();
    });
  }

  function changeGeneration(identity) {
    const nextIdentity = identity ? identityOf(identity) : null;
    const nextKey = nextIdentity ? identityKey(nextIdentity) : "";
    if (nextKey === currentIdentityKey) return generation;
    if (pending) throw codedError("save_drain_required", "flush pending saves before changing project generation");
    if (lastFailure) throw codedError("save_drain_required", "resolve the failed save before changing project generation");
    if (
      currentIdentity && nextIdentity &&
      nextIdentity.editor_generation <= currentIdentity.editor_generation
    ) throw codedError("save_generation_required", "project identity or lease changes require a newer editor_generation");
    generation++;
    currentIdentity = nextIdentity;
    currentIdentityKey = nextKey;
    acknowledgedInputFingerprint = undefined;
    acknowledgedFingerprint = undefined;
    acknowledgedGeneration = -1;
    initialFingerprint = undefined;
    highestRequest = null;
    lastResult = null;
    paused = false;
    clearTimers();
    resolveDrains();
    return generation;
  }

  function reconcileGeneration(identity) {
    if (inflight) throw codedError("save_drain_required", "wait for the active save before reconciling its result");
    clearTimers();
    if (pending) {
      settle(pending.waiters, { suppressed: true, reason: "reconciled" });
      pending = null;
    }
    lastFailure = null;
    paused = false;
    const nextIdentity = identity ? identityOf(identity) : null;
    const nextKey = nextIdentity ? identityKey(nextIdentity) : "";
    if (nextKey === currentIdentityKey) {
      // Explicit disk reconciliation in the same lease still invalidates late
      // editor callbacks and starts a fresh revision chain.
      if (currentIdentity && nextIdentity && nextIdentity.editor_generation <= currentIdentity.editor_generation) {
        throw codedError("save_generation_required", "reconciliation requires a newer editor_generation");
      }
    }
    return changeGeneration(identity);
  }

  function enqueue(value) {
    if (closed) return Promise.resolve({ suppressed: true });
    const request = immutableRequest(value);
    const identity = identityOf(request);
    if (!currentIdentityKey) changeGeneration(identity);
    else if (identityKey(identity) !== currentIdentityKey) {
      return Promise.reject(codedError("save_generation_mismatch", "save request does not match the active project lease"));
    }
    const epoch = generation;
    if (highestRequest) {
      const order = compareRevision(request.revision, highestRequest.revision);
      if (order < 0) return Promise.resolve({ suppressed: true, reason: "stale_revision" });
      if (order === 0) {
        if (stableJson(request.project) !== stableJson(highestRequest.project)) {
          return Promise.reject(codedError("save_revision_conflict", "different project snapshots share one revision"));
        }
        if (pending?.generation === epoch && pending.request.revision === request.revision) {
          return new Promise((resolve, reject) => pending.waiters.push({ resolve, reject }));
        }
        if (inflight?.generation === epoch && inflight.request.revision === request.revision) {
          return new Promise((resolve, reject) => inflight.waiters.push({ resolve, reject }));
        }
        if (lastResult) return Promise.resolve(lastResult);
        return Promise.resolve({ suppressed: true, reason: "duplicate_revision" });
      }
    } else {
      initialFingerprint = clone(request.expected_fingerprint);
    }
    highestRequest = request;
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      if (!pending || pending.generation !== epoch) {
        pending = { request, waiters: [waiter], generation: epoch, ready: false, maxWaitReached: false };
      } else {
        pending.request = request;
        pending.waiters.push(waiter);
      }
      schedulePending();
    });
  }

  function flush() {
    if (closed) return Promise.reject(codedError("save_scheduler_closed", "save scheduler is closed"));
    if (paused || (lastFailure && !pending && !inflight)) {
      return Promise.reject(lastFailure || codedError("save_reconciliation_required", "reconcile project state before saving again"));
    }
    if (pending?.generation === generation) {
      clearTimers();
      pending.ready = true;
      pump();
    }
    if (!hasWork()) return lastFailure ? Promise.reject(lastFailure) : Promise.resolve();
    return new Promise((resolve, reject) => drains.add({ resolve, reject }));
  }

  function close() {
    if (hasWork()) throw codedError("save_drain_required", "flush pending saves before closing the scheduler");
    if (lastFailure) throw codedError("save_drain_required", "resolve the failed save before closing the scheduler");
    closed = true;
    clearTimers();
    generation++;
    currentIdentity = null;
    currentIdentityKey = "";
    resolveDrains();
  }

  return { enqueue, flush, changeGeneration, reconcileGeneration, close };
}
