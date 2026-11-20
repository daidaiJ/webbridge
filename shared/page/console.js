import { readFileSync } from 'node:fs';

export const CONSOLE_SOURCE = readFileSync(new URL('./console.fn.js', import.meta.url), 'utf8');
