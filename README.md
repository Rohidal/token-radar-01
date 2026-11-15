# Launch Radar

A dashboard for protocols that record no token yet: it ranks them by what their own record says a
launch could be worth, and it gives each one a farm plan a reader can follow before a token exists.

## Run it

    node main.ts --input /input                     # the graded run
    MAKEFUN_OUTPUT_DIR=out node main.ts --input path/to/snapshot.json

Node 22.18 or later, standard library only: nothing to install, nothing to build. The program reads
the sealed snapshot, scores every rankable pre-token protocol, and writes `board.json`, `data.js`,
a copy of `dashboard/` and `screenshots/`, then `dossier.json` last.

## The model

    implied = TVL x multiple x (1 + growth x 0.35) x record

- `multiple` is what the snapshot's own token-bearing protocols trade at: market cap over TVL, taken
  as a category median when the category has at least four comparables, blended 65/35 with the whole
  snapshot's median, clamped to 0.04x..2.5x.
- `growth` is the protocol's seven-day TVL change, clamped to -60..+120 per cent.
- `record` is days since DefiLlama began tracking the protocol, up to four years, mapped into a
  0.75..1.20 factor: a longer un-tokenised record counts for more.

Every constant lives in `lib/model.ts` and is printed on the dashboard's method tab. No protocol
name is special-cased; one function scores every row.

## Layout

    main.ts               entrypoint: snapshot in, /output written
    lib/model.ts          comps, scoring, farm plans, board checks
    vendor/               make.fun's dossier library, copied from the kit
    dashboard/            index.html, app.css, app.js: the page, no network
    screenshots/          board, detail view, filtered view
