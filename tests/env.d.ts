// convex-test needs every Convex module handed to it, and Vite's import.meta.glob
// is how that is done. The Next tsconfig covers this directory too, so without
// this declaration the production build fails type-checking on the test suite.
interface ImportMeta {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}
