import { readFileSync } from 'node:fs';

export const EXTRACT_SOURCE = readFileSync(new URL('./extract.fn.js', import.meta.url), 'utf8');
