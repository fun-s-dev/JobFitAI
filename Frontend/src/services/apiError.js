/**
 * Turns an Axios error into a message that is safe and useful to show a user.
 * Backend errors look like { message, error: { code, message, requestId } }.
 */
export function getApiErrorMessage(err, fallback = 'Something went wrong. Please try again.') {
  const data = err?.response?.data;

  if (typeof data?.error?.message === 'string' && data.error.message) return data.error.message;
  if (typeof data?.message === 'string' && data.message) return data.message;

  const status = err?.response?.status;
  if (status === 401) return 'Your session has expired. Please log in again.';
  if (status === 429) return 'Too many requests. Please wait a moment and try again.';
  if (status === 413) return 'The upload is too large.';
  if (!err?.response) return 'Cannot reach the server. Check your connection and try again.';

  return fallback;
}
