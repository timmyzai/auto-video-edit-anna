// Thrown by route handlers / the run registry to produce a specific HTTP
// status instead of the dispatcher's generic 500 fallback.
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
