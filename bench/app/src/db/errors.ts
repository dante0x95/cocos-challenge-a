// SQLSTATE → HTTP. Los APPxx los define bench/sql/21_functions.sql.
export interface HttpError {
  status: number;
  code: string;
  message: string;
  retryAfter?: number;
}

export function mapDbError(err: unknown): HttpError {
  const e = err as { code?: string; message?: string };
  const msg = e.message ?? 'error';
  switch (e.code) {
    case 'APP01': return { status: 422, code: 'NO_PRICE', message: msg };
    case 'APP02': return { status: 400, code: 'BAD_REQUEST', message: msg };
    case 'APP03': return { status: 422, code: 'IDEMPOTENCY_MISMATCH', message: msg };
    case 'APP04': return { status: 503, code: 'VERSION_MISMATCH', message: msg, retryAfter: 1 };
    case 'APP05': return { status: 422, code: 'LIMIT', message: msg };
    case '55P03': return { status: 503, code: 'LOCK_TIMEOUT', message: 'lock timeout', retryAfter: 1 };
    case '57014': return { status: 503, code: 'TIMEOUT', message: 'statement cancelled', retryAfter: 1 };
    case '40P01': return { status: 503, code: 'DEADLOCK', message: 'deadlock (bug: reportar)', retryAfter: 1 };
    case '42501': return { status: 500, code: 'PRIVILEGES', message: 'la API no tiene permiso para esa operación' };
    default:      return { status: 500, code: 'INTERNAL', message: msg };
  }
}
