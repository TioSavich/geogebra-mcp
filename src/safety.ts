// Input validation. We're deliberately conservative — GeoGebra commands are
// not arbitrary JS, but the command surface includes things like SetValue,
// SetCoords, and so on that can poke at construction internals. We don't
// try to sandbox semantics; we just constrain shape and size.

import { z } from "zod";

// Object names in GeoGebra are reasonably permissive (letters, digits,
// underscores, prime marks, subscripts via _). We accept letters/digits/
// underscores/primes and a few common Unicode letters. Length bounded.
export const ObjectName = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\p{L}_][\p{L}\p{N}_'′]*$/u, "Invalid GeoGebra object name");

// Bound command length to keep payloads sane.
export const CommandString = z.string().min(1).max(8192);
export const LongString = z.string().max(65536);
export const Base64String = z
  .string()
  .max(50 * 1024 * 1024) // 50 MB ceiling on .ggb payload
  .regex(/^[A-Za-z0-9+/=\s]+$/, "Not a base64 string");

export const ColorByte = z.number().int().min(0).max(255);
export const Scale = z.number().positive().max(20);
export const Dpi = z.number().int().min(36).max(600);

export const AppName = z.enum([
  "graphing",
  "geometry",
  "3d",
  "classic",
  "suite",
  "cas",
  "scientific",
  "evaluator",
  "notes",
]);
