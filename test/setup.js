jasmine.DEFAULT_TIMEOUT_INTERVAL = 60000;

// Dump logs on failure for debugging
if (process.env.DUMP_FAILED_TEST_LOGS) {
  let helpers = await import('@percy/cli-command/test/helpers');
  let reporter = {
    specDone(result) {
      if (result.status === 'failed') helpers.logger.dump();
    }
  };
  jasmine.getEnv().addReporter(reporter);
}
