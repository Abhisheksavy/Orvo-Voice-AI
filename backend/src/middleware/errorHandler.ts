import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger';

export class AppError extends Error {
  constructor(public message: string, public statusCode: number = 500) {
    super(message);
    this.name = 'AppError';
  }
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    logger.warn(err.message, { statusCode: err.statusCode });
    res.status(err.statusCode).json({ success: false, message: err.message });
    return;
  }
  const message = err instanceof Error ? err.message : 'Internal server error';
  logger.error(message, { err });
  res.status(500).json({ success: false, message: 'Internal server error' });
}
