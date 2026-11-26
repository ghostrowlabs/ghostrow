#!/usr/bin/env node
import { run } from "../cli/program.js";

void run(process.argv).then(({ code }) => {
  process.exitCode = code;
});
