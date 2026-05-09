# Dashboard

The dashboard is a static app in `apps/dashboard/public`.

## Local

From the repo root:

```bash
npm run lab:report
python3 -m http.server 8080 --directory apps/dashboard/public
```

Open `http://localhost:8080`.

## GitHub

This repo is private. The current GitHub plan does not support GitHub Pages for this private repository, so the Pages workflow is manual-only and should be enabled only if the repo becomes public or the account already supports private Pages.

The free fallback is the `Build Dashboard Artifact` workflow. It uploads the dashboard as an Actions artifact named `fusion-dashboard-static`.

No paid upgrade is required for the artifact flow.
