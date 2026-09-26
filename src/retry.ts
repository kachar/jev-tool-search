// Retries one model call with exponential backoff and reports each failure, so a search that makes
// a dozen calls survives a provider at capacity - and the refusals still get counted.

export const CALL_ATTEMPTS = 5;
export const CALL_DELAY_MS = 500;

export async function withRetry<RESULT>(
  call: () => Promise<RESULT>,
  {
    attempts = CALL_ATTEMPTS,
    delayMs = CALL_DELAY_MS,
    onFailure = () => {},
  }: { attempts?: number; delayMs?: number; onFailure?: (error: unknown) => void } = {}
): Promise<RESULT> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      onFailure(error);
      if (attempt === attempts) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs * 2 ** (attempt - 1)));
    }
  }
}
