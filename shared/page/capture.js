import { readFileSync } from 'node:fs';

export const CAPTURE_SOURCE = readFileSync(new URL('./capture.fn.js', import.meta.url), 'utf8');
