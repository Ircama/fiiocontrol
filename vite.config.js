import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
	// The app is deployed to GitHub Pages at https://ircama.github.io/fiiocontrol/
	// (project pages), so every URL is based at the repository name.
	// The extracted production bundle was patched so that the Vue Router
	// history base is "/fiiocontrol/" too — keep the two in sync.
	base: "/fiiocontrol/",
	plugins: [vue()],
	build: {
		outDir: "dist",
	},
	server: {
		// Serve under the same base as production so dev == deployed behaviour.
		// The app is reachable at http://localhost:5173/fiiocontrol/
	},
});
