# Inkland

An offline territory-capture arcade game. You steer a little ink blob around a paper arena. Leave your land to draw a trail, then get back home to claim everything the loop encloses. Cut a rival's trail to knock them out, but don't let anyone touch yours.

Everything runs locally: no accounts, no ads, no network.

## Play

| How | Command | Notes |
| --- | --- | --- |
| Single file | `npm run build`, then open `dist/inkland.html` | Double-click to play. Works from disk, USB stick or phone storage. |
| Local server | `npm start`, then open http://localhost:8080 | Adds the shared local leaderboard. You can install it as an app (PWA) and it keeps working offline afterwards. |
| Android APK | `npm run build:apk`, then install `dist/inkland.apk` | Fullscreen app for Android 7.0+. No internet permission; everything ships inside the APK. |

Requires Node 18+ for the server, build and tests. There are no npm dependencies.

### Controls
- **Mouse**: the blob heads toward the cursor.
- **Touch**: drag anywhere (floating joystick).
- **Keyboard**: arrow keys / WASD (8 directions).
- **Esc / P**: pause.

### Modes
- **Classic**: one life. Grow until you own 90% of the map.
- **Time Rush**: two minutes. Hold the most land when the clock stops.

Rival difficulty (Easy / Normal / Hard) sets how many bots play, how fast they move, and how bold they are. Extra colours unlock as you set records.

## Architecture

```
src/engine/        Game "backend": pure simulation, no DOM (runs in the browser and Node)
  arena.js         Circular grid of cells: territory owner + trail owner, flood-fill capture
  game.js          Players, movement, collisions, kills, spawning, modes, results
  bot.js           Bot AI: plan loops, BFS path home around own trail, flee threats, hunt trails
  util.js          Seeded RNG and math helpers
src/client/        Frontend
  renderer.js      Canvas renderer (layered cell bitmaps, blobs, particles, minimap)
  input.js         Mouse / touch joystick / keyboard steering
  ui.js            Menu, HUD, leaderboard, pause and game-over screens
  storage.js       localStorage saves + optional sync with the local server
  audio.js         Procedural WebAudio sound effects (no audio files)
  palette.js       Colours and unlockable skins
  main.js          Game loop and wiring
server/server.js   Local Node server: static files + leaderboard API (JSON file storage)
scripts/build.js   Bundles everything into a single offline HTML file
sw.js              Service worker for offline play when served over HTTP
```

### Local API
| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/health` | Lets the client detect the server |
| GET | `/api/scores?mode=classic\|rush` | Top 20 scores |
| POST | `/api/scores` | `{name, score, kills, mode, time}`. Validated, saved to `server/data/scores.json` |

Environment variables: `PORT` (default 8080), `HOST` (default `0.0.0.0`, so phones on the same Wi-Fi can join the leaderboard), `INKLAND_DATA` (data directory).

## Android build

`android/build-apk.sh` builds the APK **without the Android SDK**, using only a JDK (17+), Node, Python 3 and curl:

1. Bundles the game into a single HTML file and ships it as `assets/index.html`.
2. Compiles `android/src/.../MainActivity.java` (a fullscreen WebView with immersive mode, keep-screen-on and Back-button handling) against the Android 14 framework jar.
3. Converts it to `classes.dex` with dx.
4. Encodes `AndroidManifest.xml` and `android/res/` into binary form with [ARSCLib](https://github.com/REAndroid/ARSCLib).
5. Signs it with apksig (APK Signature Scheme v2) and verifies the signature.

The build downloads its tools once from Maven Central into `android/.tools/` and checks each one against its published SHA-1.

**Signing key.** By default the first build generates a key at `android/.tools/inkland-local.p12`. Back it up: Android only installs an update over an existing install if the update is signed with the same key. To use your own key, set:

```
INKLAND_KEYSTORE=/path/key.p12 INKLAND_KEYSTORE_PASS=... INKLAND_KEY_ALIAS=... npm run build:apk
```

**Installing.** Copy the APK to the phone and open it (allow "Install unknown apps" for your file manager or browser), or run `adb install dist/inkland.apk`.

## Development

```
npm test        # engine rules, bot simulation soak test, server API tests
npm run build   # dist/inkland.html
```

The engine is deterministic for a given seed (`new Game({ seed })`), so you can simulate it headlessly in tests.
