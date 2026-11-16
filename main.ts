// Driver for the markdown-render-speed entry. The harness runs
// `node /bot/main.ts`: read every case from cases.json in the input
// directory (an array of {id, markdown}), render each case on its own
// with parse() from ./parse.js, and write the HTML strings, in the
// cases' order, as a JSON array to html.json in the output directory.
// MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR stand in for /input and
// /output outside a container.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

interface Case {
  id: string;
  markdown: string;
}

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as Case[];
const html: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  html[i] = parse(cases[i].markdown);
}
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
