/** Structured service errors are safe to show in the UI.  Technical details
 * stay in logs and are never used as the user-facing message. */
export interface ErrorObject {
  code: string;
  user_message: string;
  technical_message: string;
  /** A fatal error is persisted to the recovery journal before the shell exits. */
  severity?: "recoverable" | "blocking" | "fatal";
  recoverable: boolean;
  recommended_action: string | null;
  details: Record<string, unknown>;
}

const REDACTED = "[REDACTED]";

const SECRET_KEY =
  /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|bearer[_-]?token|token|cookie|password|passphrase|secret|private[_-]?key|client[_-]?secret|authorization|credentials?|credential[_-]?reference|auth[_-]?reference)/i;

/** Credential-bearing names, matched case-insensitively. */
const SECRET_LABELS = [
  "x[_-]?goog[_-]?api[_-]?key",
  "x[_-]?api[_-]?key",
  "api[_-]?key",
  "api[_-]?secret",
  "access[_-]?token",
  "refresh[_-]?token",
  "id[_-]?token",
  "auth[_-]?token",
  "bearer[_-]?token",
  "private[_-]?key",
  "client[_-]?secret",
  "secret[_-]?key",
  "passphrase",
  "password",
  "authorization",
  "bearer",
  "credentials?",
  "cookie",
  "secret",
  "token",
].join("|");

/**
 * `name: value` / `name=value` where the WHOLE value is a credential.  The
 * value runs to the next delimiter (newline, `,`, `;`, `&`, or a quote), so
 * `Authorization: Bearer sk-abc` is removed as one unit.  Matching only the
 * first whitespace-delimited token would leave the key itself behind.
 */
const SECRET_VALUE = new RegExp(
  `((?:${SECRET_LABELS})["']?\\s*[:=]\\s*)("(?:[^"\\n]*)"|'(?:[^'\\n]*)'|[^\\n,;&"']+)`,
  "gi",
);

/** A bare `Bearer <token>` that no header name introduced. */
const BEARER_VALUE = /\bBearer\s+[^\s,;&"']+/gi;

/** Provider key shapes that are recognisable on their own. */
const PREFIXED_SECRET = /\bsk-[A-Za-z0-9_-]{6,}/g;

/** Under-redaction is a security bug; over-redaction is only cosmetic. */
function redactString(value: string): string {
  return value
    .replace(SECRET_VALUE, `$1${REDACTED}`)
    .replace(BEARER_VALUE, REDACTED)
    .replace(PREFIXED_SECRET, REDACTED);
}

/** Keep diagnostics useful without allowing credentials to cross a service boundary. */
export function redactSecrets(value: unknown, key = ""): unknown {
  if (SECRET_KEY.test(key)) return REDACTED;
  if (typeof value === "string") {
    return redactString(value);
  }
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item));
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [childKey, child] of Object.entries(value)) {
    output[childKey] = redactSecrets(child, childKey);
  }
  return output;
}

function severityFor(
  error: Partial<Pick<ErrorObject, "recoverable" | "severity">>,
): ErrorObject["severity"] {
  if (error.severity) return error.severity;
  return error.recoverable ? "recoverable" : "blocking";
}

export class ServiceError extends Error {
  readonly error: ErrorObject;

  constructor(error: Partial<ErrorObject> & Pick<ErrorObject, "code">) {
    super(
      String(
        redactSecrets(
          error.technical_message ?? error.user_message ?? error.code,
        ),
      ),
    );
    this.name = "ServiceError";
    this.error = {
      code: error.code,
      user_message: String(
        redactSecrets(error.user_message ?? "这项操作没有完成。工作台仍可继续使用，请重试。"),
      ),
      technical_message: String(
        redactSecrets(
          error.technical_message ?? error.user_message ?? error.code,
        ),
      ),
      severity: severityFor(error),
      recoverable: error.recoverable ?? true,
      recommended_action: error.recommended_action ?? null,
      details: redactSecrets(error.details ?? {}) as Record<string, unknown>,
    };
  }
}

/** Build one stable error shape for command, job and connector boundaries. */
export function structuredError(
  code: string,
  userMessage: string,
  technicalMessage = userMessage,
  options: Partial<
    Pick<
      ErrorObject,
      "severity" | "recoverable" | "recommended_action" | "details"
    >
  > = {},
): ServiceError {
  const severity = options.severity ??
    (options.recoverable === false ? "blocking" : "recoverable");
  return new ServiceError({
    code,
    user_message: userMessage,
    technical_message: technicalMessage,
    severity,
    recoverable: options.recoverable ?? severity === "recoverable",
    recommended_action: options.recommended_action ?? null,
    details: options.details ?? {},
  });
}

export function asErrorObject(
  error: unknown,
  fallbackCode = "unexpected_error",
): ErrorObject {
  if (error instanceof ServiceError) return error.error;
  if (error && typeof error === "object" && "error" in error) {
    const value = (error as { error?: unknown }).error;
    if (value && typeof value === "object" && "code" in value) {
      const candidate = value as Partial<ErrorObject> & { code: string };
      return {
        code: candidate.code,
        user_message: String(
          redactSecrets(candidate.user_message ?? "这项操作没有完成。工作台仍可继续使用，请重试。"),
        ),
        technical_message: String(
          redactSecrets(
            candidate.technical_message ?? candidate.user_message ??
              candidate.code,
          ),
        ),
        severity: severityFor(candidate),
        recoverable: candidate.recoverable ?? true,
        recommended_action: candidate.recommended_action ?? null,
        details: redactSecrets(candidate.details ?? {}) as Record<
          string,
          unknown
        >,
      };
    }
  }
  const message = error instanceof Error
    ? error.message
    : String(error ?? "未知错误");
  return {
    code: fallbackCode,
    user_message: "这项操作没有完成。工作台仍可继续使用，请重试。",
    technical_message: String(redactSecrets(message)),
    severity: "recoverable",
    recoverable: true,
    recommended_action: "请重试；如果问题持续，请重新打开项目。",
    details: {},
  };
}

export function error(
  code: string,
  user_message: string,
  technical_message = user_message,
  options: Pick<
    ErrorObject,
    "severity" | "recoverable" | "recommended_action" | "details"
  > = {
    recoverable: true,
    recommended_action: null,
    details: {},
  },
): ServiceError {
  return new ServiceError({
    code,
    user_message,
    technical_message,
    ...options,
  });
}
