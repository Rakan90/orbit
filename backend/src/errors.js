export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

// Turns database refusals into answers a person can act on.
export function fromDb(err) {
  if (err instanceof HttpError) return err;
  switch (err.code) {
    case '23P01':
      return new HttpError(409, 'This plan would put a room or a surgeon in two places at once (Constraint 3). Nothing was saved.',
        { constraint: err.constraint });
    case '23505': return new HttpError(409, 'That already exists.', { constraint: err.constraint });
    case '23503': return new HttpError(422, 'That refers to something that does not exist.', { constraint: err.constraint });
    case '23514': case '23502': case '22P02': case '22007': case '22008':
      return new HttpError(422, `The data does not meet a rule: ${err.message}`, { constraint: err.constraint });
    case 'P0001': return new HttpError(422, err.message);
    default: return null;
  }
}

export function errorHandler(err, req, res, _next) {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request body is not valid JSON.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'The file is too large.' });
  const e = fromDb(err);
  if (e) return res.status(e.status).json({ error: e.message, ...(e.details ? { details: e.details } : {}) });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
}
