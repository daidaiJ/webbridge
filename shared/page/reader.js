import { readFileSync } from 'node:fs';

export const READER_SOURCE = readFileSync(new URL('./reader.fn.js', import.meta.url), 'utf8');
