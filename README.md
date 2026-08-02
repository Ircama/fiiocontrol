# FiiO Control (Equalizer / Custom) — offline Vue/Vite build

This repository is a self-contained, offline copy of the [FiiO Control web app](https://fiiocontrol.fiio.com/equalizer/custom) (`https://fiiocontrol.fiio.com/equalizer/custom`) wrapped in a **Vue 3 + Vite** project so it can be run locally in VS Code and deployed to **GitHub Pages**.

The app lets you control FiiO USB DACs / headphones (equalizer presets, firmware update, etc.) directly in the browser. **A real FiiO device connected over USB / WebHID is required to use most functions** — the welcome / device-connection flow is part of the original app.

## Stack

- [Vite](https://vitejs.dev/) (project scaffold and build, inspired by the
- [Vue 3](https://vuejs.org/) + Element Plus (the original app is a Vue 3 SPA)
- The application itself is the **prebuilt production bundle** extracted from fiiocontrol.fiio.com (all lazy-loaded chunks, CSS, images, sounds and firmware `.bin` files are vendored under `public/static/`).

## Getting started

```bash
npm install        # install Vite / Vue toolchain
npm run dev        # start the dev server
```

Then open **http://localhost:5173/fiiocontrol/** (the base path mirrors the production URL `https://ircama.github.io/fiiocontrol/`).

## Build

```bash
npm run build      # outputs a static site in dist/
npm run preview    # serve the production build locally
```

The `dist/` folder is a fully static site that can be hosted anywhere.

## Deploy to GitHub Pages

Pushing to `main` triggers [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml), which runs `npm ci && npm run build` and publishes `dist/` via GitHub Pages (`https://ircama.github.io/fiiocontrol/`).

To enable it:

1. Go to **Settings → Pages** of the repository.
2. Under *Build and deployment → Source* select **GitHub Actions**.
3. Push to `main` (or run the workflow manually via *Actions*).

## How the offline copy was made

The production bundle is lazy-loaded, so a simple "Save As" of `index.html` is **not enough**. The complete set of assets was fetched from `https://fiiocontrol.fiio.com/`:

| Directory            | Contents                                              |
| -------------------- | ----------------------------------------------------- |
| `public/static/js/`  | main bundle + 55 lazy-loaded route/shared chunks      |
| `public/static/css/` | main stylesheet + 33 route-specific stylesheets       |
| `public/static/png/` | product images, logos, banners                        |
| `public/static/wav/` | sweep-frequency tone (room EQ)                        |
| `public/static/bin/` | official device firmware files (firmware update page) |
| `public/FiiO.ico`    | favicon                                               |

The prebuilt bundle expects to be served from a domain root, but this project is deployed under `/fiiocontrol/`. Three surgical patches were applied to the vendored files so every URL resolves under that base:

1. **Vue Router base** — `createWebHistory("/")` → `createWebHistory("/fiiocontrol/")`
   (in `public/static/js/index-WZB3nC8k.js`).
2. **Chunk/CSS preload resolver** — `Yve=function(e){return"/"+e}` →
   `Yve=function(e){return"/fiiocontrol/"+e}` so lazy chunks and their CSS are
   preloaded from the correct base.
3. **Root-relative asset literals** — every quoted `/static/...` string
   (images, sounds, firmware `.bin`) → `/fiiocontrol/static/...`.

> If the repository is renamed (or deployed to a custom domain), the base path `/fiiocontrol/` must be updated in **three places**: `vite.config.js`, `public/static/js/index-WZB3nC8k.js` (the two patches above) and `public/404.html` / `index.html`.

`public/404.html` is an SPA fallback so GitHub Pages serves the app for deep links (e.g. `/fiiocontrol/equalizer/custom`) instead of a 404.

## EQ curve mathematics (the `myChart` class)

The equalizer curve rendered in the `myChart` element (an ECharts graph) is the **real frequency response of the RBJ biquad filters** — not an interpolation.  The math below was reverse-engineered from the production bundle (`public/static/js/index-WZB3nC8k.js`, `eq-bands-card` chunk).

**1. Biquad coefficients — `i3e(gain, freq, q, filterType, fs)`** (RBJ Audio EQ
Cookbook):

$$\omega_0 = \frac{2\pi f_0}{f_s}, \qquad A = 10^{G/40}, \qquad \alpha = \frac{\sin\omega_0}{2Q}$$

with the full cookbook formulas for **Peak**, **Low Shelf**, **High Shelf**, **Band-Pass**, **Low-Pass**, **High-Pass** and **All-Pass**. Unknown types fall back to a bypass / identity section `{a0:1, a1:0, a2:0, b0:1, b1:0, b2:0}`.

**2. Magnitude response — `a6e(sections, fs, f)`**:

$$H_i(z) = \frac{b_0 + b_1 z^{-1} + b_2 z^{-2}}{a_0 + a_1 z^{-1} + a_2 z^{-2}}, \qquad z = e^{-j\omega}, \quad \omega = \frac{2\pi f}{f_s}$$

$$dB(f) = 20\log_{10}\left|\prod_i H_i\!\left(e^{j\omega}\right)\right|$$

**3. Sampling**: 128 log-spaced points from **10 Hz** to **24 kHz** (`n6e(128, 10, 24e3)`, i.e. $f = 10^{\log_{10}10 + (\log_{10}24000 - \log_{10}10)\cdot i/127}$), evaluated at the hardcoded **48 kHz** sample rate (`FS_48000`).

> **Key simplification** — because $|\prod_i H_i| = \prod_i |H_i|$, the total is simply the **sum of the per-band dB**, so no complex-number products are needed:
>
> $$dB(f) = \sum_i 20\log_{10}\left|H_i\!\left(e^{j\omega}\right)\right|$$

### Verification
A standalone Node test comparing this math against fiiocontrol's exact
complex-section product (`i3e` + `a6e`) reports a maximum error of **≈1e-9 dB**
across the whole 10 Hz – 24 kHz range for typical EQ settings (the residual is
pure floating-point noise).

> **Fixed quirk (patch in the vendored bundle)**: the small `eq-chart-mini` preview inside `eq-bands-card` used to pass the *raw band list* (`{filterType, frequency, gain, qValue}`) straight into `a6e`, which expects biquad sections (`{a0,a1,a2,b0,b1,b2}`), so that preview rendered no valid curve (NaN). `public/static/js/eq-bands-card-CTGfWnlO.js` is patched so the mini-chart now maps each raw band to an identity-prepended RBJ section (the same math as the main editor chart) before calling `a6e`. Verified bit-identical to the reference (max error 0 dB).

## Remote hidws backend

[`public/hidws.js`](public/hidws.js) adds an optional **Remote** connection mode that talks to a [`hidws`](https://github.com/Ircama/hidws) WebSocket backend instead of (or in addition to) WebHID — the same transport used by kt02h20-control / Audiocular-Aura.

> The dialog body id (e.g. `el-id-6042-13`) is auto-generated by Element Plus
> and changes between renders, so `hidws.js` locates the dialog via its
> `.dialog-content` / `.radio-item` structure, not by id.

## Auto-EQ panel overlay

On the **Auto EQ** page the app renders `#eq-panel` inside a narrow grid cell
(`div1`, ~211 px) whose content needs more room, so it overflowed into
`#eq-slider-list` (`div3`) and required a horizontal scrollbar. `hidws.js`
converts it into a **toggleable, 100%-opaque overlay**:

- `#eq-panel` becomes a fixed overlay (~440 px wide) using the active theme
  colors (`--el-bg-color-overlay`, `--el-text-color-primary`,
  `--el-border-color`, …), so the `div3` controls never show through it.
- A **"⚙ EQ panel" / "✕ Close panel"** toggle button is added at the
  top-right (below the header, in empty space — it does not overlap other
  controls). Open/closed state persists in `localStorage`.
- The hidden state uses `visibility:hidden` + `opacity:0` (NOT `display:none`):
  `display:none` zero-sizes the slider content the app observes with
  `ResizeObserver`, which caused an infinite feedback loop that froze the page.

## Notes

- **No Fiio backend**: the original app talks to `fiiocontrol.fiio.com` API endpoints (login, cloud presets, etc.). Those calls are not available offline and will fail gracefully; local-device (WebHID) features do not depend on them.
- **WebHID**: a WebHID-capable browser (Chrome / Edge / Opera) and a connected FiiO device are required for device control.
- Navigating straight to a deep route redirects to the **Welcome** screen — that is the original app's "connect your device first" flow.

## License

The original FiiO Control web application and its assets are © FiiO Electronics Technology Co., Ltd. This repository only vendors them for offline testing / study purposes; do not redistribute commercially.

