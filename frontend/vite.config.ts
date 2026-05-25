import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 8080,
    hmr: {
      overlay: false,
    },
    proxy: {
      "/api": {
        target: "http://127.0.0.1:7999",
        changeOrigin: true,
      },
    },
  },
  build: {
    commonjsOptions: {
      // Ketcher (via ketcher-core) runs `require("raphael")` guarded by
      // `typeof window !== "undefined"`. That require lives inside an ES-module
      // file, so without this flag Rollup leaves it untransformed and the
      // production bundle throws "require is not defined" at load time, dropping
      // the editor into its manual-SMILES fallback. Transforming mixed modules
      // rewrites the require into a real import so Raphael is bundled normally.
      // (Dev works regardless because esbuild pre-bundling shims CJS requires.)
      transformMixedEsModules: true,
    },
  },
  plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "nmrium/lib": path.resolve(__dirname, "./node_modules/nmrium/lib"),
    },
    dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime", "@tanstack/react-query", "@tanstack/query-core"],
  },
}));
