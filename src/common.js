// Shared flag definitions used by both `percy styleguidist` (capture against
// an existing build/URL) and `percy styleguidist-start` (spawn the styleguide
// dev server then capture).
export const flags = [{
  name: 'include',
  description: 'Pattern matching component names to include in snapshots',
  type: 'pattern',
  multiple: true,
  short: 'i'
}, {
  name: 'exclude',
  description: 'Pattern matching component names to exclude from snapshots',
  type: 'pattern',
  multiple: true,
  short: 'e'
}, {
  name: 'config',
  description: 'Path to styleguide.config.js',
  type: 'string'
}];
