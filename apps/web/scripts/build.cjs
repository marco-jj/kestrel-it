const { createRequire } = require('node:module');
const run = require('@angular/cli').default;
const requireFromBuilder = createRequire(require.resolve('@angular/build/package.json'));

async function build() {
  try {
    process.exitCode = await run({ cliArgs: ['build', ...process.argv.slice(2)] });
  } finally {
    // Angular can leave its esbuild subprocess running after the CLI finishes.
    await requireFromBuilder('esbuild').stop();
  }
}

build().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
