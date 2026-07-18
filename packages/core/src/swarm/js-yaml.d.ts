/**
 * Minimal typed declaration for js-yaml (the package ships no bundled types and @types/js-yaml
 * is not installed). We only use `load`, which is safe-by-default in js-yaml v4 (no executable
 * tags). The result is treated as `unknown` and validated by swarm/frontmatter.ts.
 */
declare module "js-yaml" {
  export interface LoadOptions {
    schema?: unknown;
    json?: boolean;
    listener?: unknown;
  }
  export function load(input: string, options?: LoadOptions): unknown;
  const _default: { load: typeof load };
  export default _default;
}
