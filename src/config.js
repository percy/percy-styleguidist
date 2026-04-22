// Match a component name against a pattern (string, glob, or /regex/).
function matchPattern(name, pattern) {
  if (typeof pattern === 'string') {
    let [, regex, flags] = /^\/(.+)\/(\w+)?$/.exec(pattern) || [];
    if (regex) return new RegExp(regex, flags).test(name);
    if (pattern.includes('*')) {
      return new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(name);
    }
    return name === pattern;
  }
  return false;
}

// Check if a component should be included based on CLI flags.
export function shouldIncludeComponent(name, flags) {
  let include = [].concat(flags?.include).filter(Boolean);
  let exclude = [].concat(flags?.exclude).filter(Boolean);
  if (include.length && !include.some(p => matchPattern(name, p))) return false;
  if (exclude.length && exclude.some(p => matchPattern(name, p))) return false;
  return true;
}
