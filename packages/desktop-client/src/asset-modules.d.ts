// Ambient types for Vite asset imports (`import x from '...?url'`).
// Force-committed: .d.ts is gitignored repo-wide, but this is a real source
// declaration the typecheck needs, not a build artifact.
declare module '*?url' {
  const url: string;
  export default url;
}
