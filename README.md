# cost-predictor-site

Static site for [Cost Predictor](https://github.com/GrayBeamTechnology/cost-predictor) — a research POC that forecasts realized medical revenue (cash that arrives) versus gross billed (invoice amounts) for primary-care clinics in Harris County, TX. Built to be hosted on GitHub Pages.

Five pages: Overview, Methodology, Use cases, Live demo, Install. The live demo is a pure-JS Monte-Carlo simulator (no framework, no build step) using per-payer denial / paid-claim realization priors copied from `config/adjudication_params.yaml` upstream.

Editorial / NEJM-meets-Stripe visual direction. Cream paper, deep ink, single muted-claret accent, system serif (Iowan Old Style) and system sans. No third-party fonts, no analytics, no CDN dependencies. Hand-rolled SVG diagrams and charts.

## Local preview

```sh
python -m http.server 8000
# open http://localhost:8000
```

## Deploy

Push to a repo under `GrayBeamTechnology/cost-predictor-site` and enable GitHub Pages on `main`. The `.nojekyll` file is included so files are served literally.
