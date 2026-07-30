export class UpstashError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'UpstashError';
  }
}
export class NetworkError extends UpstashError { constructor(cause?: unknown) { super('Network failure', cause); this.name = 'NetworkError'; } }
export class RateLimitError extends UpstashError { constructor() { super('Upstash rate limited'); this.name = 'RateLimitError'; } }
export class RoomNotFoundError extends UpstashError { constructor(code: string) { super(`Room ${code} not found`); this.name = 'RoomNotFoundError'; } }
export class ConcurrencyError extends UpstashError { constructor() { super('Concurrent update — version mismatch'); this.name = 'ConcurrencyError'; } }
