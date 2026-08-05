import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { copyFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// GitHub Pages SPA fallback: every unknown path (e.g. /welcome) serves
// 404.html, so it must be a byte-for-byte copy of the built index.html
// (same hashed bundles, same pre-load scripts, same localstorage.js).
// Generating it from the build output guarantees it can never drift out of
// sync — the old hand-maintained public/404.html was missing
// localstorage.js, which made direct deep routes like /welcome run in
// remote (login) mode instead of local mode ("Person Center").
function spa404() {
	return {
		name: "spa-404",
		closeBundle() {
			const index = resolve(process.cwd(), "dist/index.html");
			const notFound = resolve(process.cwd(), "dist/404.html");
			if (!existsSync(index)) return;
			copyFileSync(index, notFound);
		},
	};
}

export default defineConfig({
	// The app is deployed to GitHub Pages at https://ircama.github.io/fiiocontrol/
	// (project pages), so every URL is based at the repository name.
	// The extracted production bundle was patched so that the Vue Router
	// history base is "/fiiocontrol/" too — keep the two in sync.
	base: "/fiiocontrol/",
	plugins: [vue(), spa404()],
	build: {
		outDir: "dist",
	},
	server: {
		// Serve under the same base as production so dev == deployed behaviour.
		// The app is reachable at http://localhost:5173/fiiocontrol/
	},
});
