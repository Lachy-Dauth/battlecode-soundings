# Soundings

Replay analysis for [UNSW Battlecode 2026](https://game.battlecode.au).

**https://lachy-dauth.github.io/battlecode-soundings/**

Drop in `.replay` files, a folder of them, or a `.zip`, and see how your dragons live, eat and die. Everything runs in your browser: replays are decoded and analysed locally and are never uploaded.

## What it shows

- **Where your length goes.** Each death is traced to one of:
  - kelp;
  - the dragon's own body;
  - a teammate's body, or a head-on crash with a teammate;
  - an enemy's body, or a head-on crash with an enemy;
  - an action the engine rejected (a sprint it couldn't pay for, an invalid split, no valid move, a timeout).

  Deaths are weighted by length and split into self-inflicted and enemy-inflicted.
- **Kills.** It lists enemy dragons that ran into your body and head-on trades, with the length you killed.
- **The pearl economy.** Every eaten pearl is traced to its source: a natural bed, your corpses or theirs. You can see how much of the enemy you ate and how much of you fed them.
- **Charts of every map.** The maps are drawn like hydrographic charts, with these heat layers:
  - territory (your share of body-time on each cell);
  - bodies;
  - head paths;
  - where you eat, die and kill, filterable by cause;
  - which side harvested each pearl bed.

  On symmetric maps, games can be mirrored so you always start on the same side.
- **Every game, replayed.** The board player has these panels:
  - a live scoreboard;
  - a death and split feed;
  - length, dragons-alive and pearls charts that are clickable and synced;
  - lifelines of every dragon from birth to death;
  - a compute histogram;
  - searchable bot logs, when the replay kept them.
- **Across many games.**
  - a results ribbon;
  - averages with the middle half of games shaded;
  - breakdowns by map, by your bot version, and by opponent.

### Map editor

Open `.map` files, a folder of them, or a zip, and edit them by dragging:

- **Tools:** kelp (drag along edges; a stroke follows its direction), pearl beds (paint a spawn gap, or Shift-click to fill a region enclosed by kelp), portals (click two edges), dragons for either team (drag from the head along the body), move and erase.
- **Mirroring:** every edit is mirrored across the map's symmetry by default, dragons swapping teams, so a map stays fair while you draw it.
- **Views:** spawn rate (the pattern a map's pearl beds draw), and who reaches each cell first (shortest path from each team's starting heads, around kelp and through portals).
- **Checks:** the side panel checks the map the way the engine's loader does (sizes, mirrored beds, portal pairs, dragon shapes). It also warns about unfair starts, asymmetric kelp, and pearls no dragon can reach.
- **Saving:** undo and redo; maps are kept in the browser (IndexedDB) and can be downloaded one at a time or all as a zip.

Exported files use the toolkit's own layout, so an unedited map round-trips byte for byte. Any map from your replays can be opened in the editor from the Maps view.

### Which side is you

- **Replays downloaded from the site** name only the downloader's bot (the server strips the other side), so that side is you. The name shown is your submission number, which lets you compare bot versions.
- **Replays from local toolkit runs** name both bots. The name that recurs across the batch is taken as you.
- You can also choose a bot, or team A or B, explicitly.

## How it works

```
js/replay.js     gzip → Cap'n Proto (packed) decoder for engine/replay.capnp
js/map.js        map parser and board geometry (torus, kelp, portals, symmetry)
js/analyse.js    replays the event stream on a rebuilt board: bodies, kills, pearl sources
js/worker.js     runs decode + analysis in a pool of Web Workers
js/zip.js        reads .zip files with the browser's DecompressionStream
js/ingest.js     files, folders and zips → replay sources → worker pool
js/aggregate.js  "you" detection, filters, per-map layers, averages
js/board.js      the chart renderer (canvas)
js/charts.js     SVG charts
js/mapmodel.js   editable maps: .map read/write, mirroring, loader checks, reachability
js/editor.js     map library and editor
js/mapstore.js   IndexedDB map library + zip writer
js/app.js        views
```

Death causes come straight from the engine. Who you hit, and where each pearl came from, are reconstructed by following the engine's rules turn by turn. The reconstruction was checked against the engine's own final standings on 340 replays (dragon count, longest dragon and total length for both teams all matched), and every derived cause adds up to the engine's raw death reasons.

There's no build step and no dependencies. To run it locally, serve the folder and open it:

```bash
python3 -m http.server 8000
```

Replay files are git-ignored so nobody commits one by accident.

## Credits

The replay format, game rules and the Autarky map on the landing page come from the MIT-licensed [UNSW Battlecode toolkit](https://github.com/unswcpmsoc/battlecode) by UNSW CPMSoc; see [THIRD-PARTY.md](THIRD-PARTY.md). This is an unofficial tool.
