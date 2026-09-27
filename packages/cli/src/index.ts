#!/usr/bin/env node
import { run } from "./cli";

// `up`, `status` and `doctor` are async; `validate`, `render`, `init`
// and `down` are not. Awaiting either shape keeps the entry point one
// line and the commands free to be whichever suits them.
void Promise.resolve(run(process.argv.slice(2))).then((code) => {
  process.exitCode = code;
});
