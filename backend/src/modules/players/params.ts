import { z } from 'zod';

// Roblox UserIds in paths: digits only, no leading zero, at most 16 digits, and a safe integer.
// "1e3", "007", "-5" and "0" are refused instead of being coerced into some other player's id.
export const userIdParam = z
  .string()
  .regex(/^[1-9][0-9]{0,15}$/)
  .transform(Number)
  .refine(Number.isSafeInteger, 'userId is too large');

export const userIdParams = z.object({ userId: userIdParam });

export const userIdBody = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
