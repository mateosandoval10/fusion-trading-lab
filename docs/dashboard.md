# Dashboard

The dashboard is a static app in `apps/dashboard/public`.

## Local

From the repo root:

```bash
npm run lab:report
python3 -m http.server 8080 --directory apps/dashboard/public
```

Open `http://localhost:8080`.

## GitHub Pages

This repo is public so GitHub Pages can deploy without a paid private-Pages plan.

The `Deploy Dashboard` workflow publishes `apps/dashboard/public` through GitHub Pages whenever dashboard/model/report files change on `main`.

The free fallback is still the `Build Dashboard Artifact` workflow. It uploads the dashboard as an Actions artifact named `fusion-dashboard-static`.
