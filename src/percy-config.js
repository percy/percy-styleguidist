// `.percy.yml` schema for the `styleguidist` key. Without this, @percy/config
// treats `styleguidist:` as an unknown property, warns, and *deletes* it — so
// every option below has to be declared here to be readable at runtime.
export const configSchema = {
  styleguidist: {
    type: 'object',
    unevaluatedProperties: false,
    properties: {
      // Number of browser pages used to capture components in parallel.
      concurrency: {
        type: 'integer',
        minimum: 1
      },
      // IntelliStory (SmartSnap): skip snapshots whose source cannot have
      // changed since the baseline build. The dependency graph is built and
      // the selection is made server-side; the SDK only collects data.
      intelliStory: {
        type: 'object',
        unevaluatedProperties: false,
        properties: {
          enabled: {
            type: 'boolean',
            default: false
          },
          // Git ref to diff against. Defaults to the base build's commit as
          // predicted by the API.
          baseline: {
            type: 'string'
          },
          // Patterns for files that should never mark a component as affected.
          untraced: {
            type: 'array',
            items: { type: 'string' }
          },
          // Patterns that force a full snapshot run when they change.
          bailOnChanges: {
            type: 'array',
            items: { type: 'string' }
          },
          // Write a `trace.html` dependency-graph report next to the invocation.
          trace: {
            type: 'boolean',
            default: false
          },
          // The bundler-emitted dependency graph. A bare filename is looked for
          // in the styleguide build directory and its `build/` subdirectory
          // (where Styleguidist points webpack's `output.path`); a path with
          // directories in it is resolved relative to the invocation directory.
          statsFile: {
            type: 'string',
            default: 'enriched-stats.json'
          },
          // Styleguidist's config file. A change to it can affect every
          // component, so IntelliStory bails on one. Defaults to the config
          // file that was actually loaded (`--config`, or the one Styleguidist
          // discovered), so this only needs setting in unusual layouts.
          configFile: {
            type: 'string'
          },
          // Fail the build instead of falling back to a full snapshot run.
          failBuildOnFailure: {
            type: 'boolean',
            default: false
          }
        }
      }
    }
  }
};

export default configSchema;
