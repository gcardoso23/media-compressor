import { main } from '../engine/cli.ts';

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`\n${(error as Error).message}`);
    process.exitCode = 1;
  },
);
