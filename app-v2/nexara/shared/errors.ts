/**
 * Provider-agnostic error model. Provider implementations are responsible for
 * translating their native errors (PostgrestError, Cloudflare exceptions, etc.)
 * into one of these so business logic only ever sees AppError.
 */
export type AppErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "VALIDATION"
  | "DATABASE"
  | "PLATFORM"
  | "PROVIDER"
  | "UNKNOWN";

export class AppError extends Error {
  readonly code: AppErrorCode;
  override readonly cause?: unknown;

  constructor(code: AppErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.cause = cause;
  }

  static unauthenticated(message = "Not authenticated"): AppError {
    return new AppError("UNAUTHENTICATED", message);
  }
  static forbidden(message = "Permission denied"): AppError {
    return new AppError("FORBIDDEN", message);
  }
  static notFound(message = "Resource not found"): AppError {
    return new AppError("NOT_FOUND", message);
  }
  static validation(message: string): AppError {
    return new AppError("VALIDATION", message);
  }
  static database(message: string, cause?: unknown): AppError {
    return new AppError("DATABASE", message, cause);
  }
  static platform(message: string, cause?: unknown): AppError {
    return new AppError("PLATFORM", message, cause);
  }
  static provider(message: string, cause?: unknown): AppError {
    return new AppError("PROVIDER", message, cause);
  }
}
