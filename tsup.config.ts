import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/main.ts", "src/sheet-sync.ts"],
  clean: true,
  publicDir: true,
  treeshake: "smallest",
  format: "cjs",
})
