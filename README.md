# Inkland

An offline territory-capture arcade game. You steer a little ink blob around a paper arena. Leave your land to draw a trail, then get back home to claim everything the loop encloses. Cut a rival's trail to knock them out, but don't let anyone touch yours.

Everything runs locally: no accounts, no ads, no internet needed.

## Play

| How | Command | Notes |
| --- | --- | --- |
| Single file | `npm run build`, then open `dist/inkland.html` | Double-click to play. Works from disk, USB stick or phone storage. |
| Local server | `npm start`, then open http://localhost:8080 | Adds the shared leaderboard and same-Wi-Fi multiplayer. Installable as an app (PWA); keeps working offline. |
| Android APK | `npm run build:apk`, then install `dist/inkland.apk` | Fullscreen app for Android 7.0+. See [Android](#android). |

Requires Node 18+ for the server, build and tests. There are no npm dependencies.

### Controls
- **Mouse**: the blob heads toward the cursor.
- **Touch**: drag anywhere (floating joystick; sensitivity in Settings).
- **Keyboard**: arrow keys / WASD (8 directions).
- **Esc / P / Android Back**: pause.

### Modes
- **Classic**: one life. Grow until you own 90% of the map.
- **Time Rush**: two minutes. Hold the most land when the clock stops.
- **Ink Storm**: the arena shrinks and nobody respawns. Be the last blob standing, or hold the most land at the end.
- **Wi-Fi**: a shared, endless room hosted by `npm start` (see below).

### Rules worth knowing
- Crossing your own trail knocks you out.
- **Head-on crash**: the blob with the shorter trail wins (a blob at home has none); equal trails knock both out.
- **Power-ups** appear on the map: ⚡ speed burst, 🛡 shield (your trail can't be cut for 6 s, and you win head-on crashes), 💣 ink bomb (instantly claims land around you). They can be turned off in Settings.

### Rivals
Bots have personalities: **farmers** draw small, safe loops; **hunters** go after exposed trails; **explorers** draw big, greedy loops. On Normal and Hard, a named rival, the **Grand Smudge** 👑, joins and gets stronger as your best score rises.

### Progression
- **Daily challenges**: three new missions each day (for example "Reach 8% without leaving the left half"), plus a streak bonus.
- **Career achievements**: one-off goals such as "Chain a ×5 combo" or "Beat the Grand Smudge 5 times".
- Missions award ★ stars, which unlock cosmetics: land patterns, trail effects, hats and faces. Colours unlock through records.
- **Replays**: every game can be watched again (1×/2×/4×). Your best run per mode is kept and shown as a **ghost** you race against, with a live "vs best" readout.

### Feel and accessibility
Combo counter, slow motion on knockouts, capture flashes, vibration, and danger warnings: an alert when a rival is heading for your trail, a flashing trail when you're out too long, and an arrow home when your land is off-screen. Settings include low graphics (switched on automatically if a phone struggles), left-handed layout, joystick sensitivity, sound and vibration.

## Multiplayer on the same Wi-Fi

1. One person runs `npm start` on a computer. It prints the address friends should use, for example `http://192.168.1.20:8080`.
2. Friends open that address in a browser, or in the Android app tap **Play with friends (Wi-Fi)** and enter `192.168.1.20:8080`.
3. Everyone shares one endless room with bots filling the gaps. Knocked out? Tap **Respawn**.

The server runs the real game engine and sends snapshots 20 times a second; devices only send their steering. It is meant for a trusted home or office network: there are no accounts and no encryption (plain `ws://`).

## Architecture

```
src/engine/        Game "backend": pure, deterministic simulation (browser, Node tests, multiplayer server)
  arena.js         Circular grid: territory + trail owners, flood-fill capture, shrinking storm ring
  game.js          Players, movement, collisions, head-on rule, power-ups, modes, multi-human slots
  bot.js           Bot AI: personalities, turn-aware collision checks, BFS path home, threat & prey logic
  constants.js     Speeds, fixed step, power-up tuning
src/client/        Frontend
  renderer.js      Canvas renderer: smoothed marching-squares outlines, cosmetics, power-ups, storm,
                   ghost, capture flashes, danger arrows, minimap
  main.js          Fixed-step game loop, slow motion, sessions (local / replay / online)
  ui.js            Menu tabs (Play, Style, Missions, Records, Settings), HUD, results
  missions.js      Per-game stat tracking, daily challenges, career achievements
  replay.js        Input recorder, replay driver and best-run ghost
  net.js           Wi-Fi client: mirrors the server game for the renderer
  storage.js       localStorage saves/replays + optional sync with the local server
  palette.js       Colours and cosmetics; audio.js, haptics.js, input.js
server/
  server.js        Static files, leaderboard API, WebSocket upgrade on /ws
  room.js          The shared multiplayer room (authoritative engine at 60 Hz, snapshots at 20 Hz)
  ws.js            Minimal WebSocket implementation (no dependencies)
scripts/build.js   Bundles everything into a single offline HTML file
android/           Android wrapper (see below)
```

### Local API
| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/health` | Lets the client detect the server |
| GET | `/api/scores?mode=classic\|rush\|storm` | Top 20 scores |
| POST | `/api/scores` | `{name, score, kills, mode, time}`. Validated, saved to `server/data/scores.json` |
| WS | `/ws` | Multiplayer room (`join`, `in`, `respawn` → `welcome`, `roster`, snapshot `s`) |

Environment variables: `PORT` (default 8080), `HOST` (default `0.0.0.0`, so phones on the same Wi-Fi can connect), `INKLAND_DATA` (data directory).

## Android

The app is a fullscreen WebView around the single-file game, with:
- immersive fullscreen and keep-screen-on;
- a vibration bridge (`window.InklandNative.vibrate`), since WebView ignores `navigator.vibrate`;
- Back handled through `OnBackInvokedCallback` on Android 13+ (predictive-back ready) and `onBackPressed` before that;
- navigation locked to the bundled game.

**Permissions:** `VIBRATE`, and `INTERNET` with cleartext allowed, used only to reach a Wi-Fi multiplayer server you type in. The game itself never goes online.

### APK without the Android SDK (`npm run build:apk`)

`android/build-apk.sh` needs only a JDK (17+), Node, Python 3 and curl:

1. Bundles the game and ships it as `assets/index.html`.
2. Compiles `MainActivity.java` against the Android 14 framework jar.
3. Converts it to `classes.dex` with dx.
4. Encodes `AndroidManifest.xml` and `android/res/` into binary form with [ARSCLib](https://github.com/REAndroid/ARSCLib).
5. Signs it with apksig (APK Signature Scheme v2) and verifies the signature.

Tools are downloaded once from Maven Central into `android/.tools/` and checked against their published SHA-1.

**Signing key.** The first build generates `android/.tools/inkland-local.p12`. Back it up: Android only installs an update over an existing install if it is signed with the same key. To use your own key:

```
INKLAND_KEYSTORE=/path/key.p12 INKLAND_KEYSTORE_PASS=... INKLAND_KEY_ALIAS=... npm run build:apk
```

**Installing.** Copy the APK to the phone and open it (allow "Install unknown apps" for your file manager or browser), or run `adb install dist/inkland.apk`.

### Play Store bundle (Gradle, needs the Android SDK)

Google Play requires an app bundle (`.aab`) built with the official toolchain. `android/` is also a standard Gradle project sharing the same activity and resources:

```
cd android
INKLAND_KEYSTORE=/path/upload-key.p12 INKLAND_KEYSTORE_PASS=... INKLAND_KEY_ALIAS=... ./gradlew bundleRelease
# -> android/app/build/outputs/bundle/release/app-release.aab
```

Open `android/` in Android Studio or set `sdk.dir` in `android/local.properties`. Before publishing:
- create a permanent upload key and enrol in Play App Signing;
- check Google's current target API requirement and raise `targetSdk` in `app/build.gradle` and `AndroidManifest.xml` if needed;
- bump `versionCode` for every upload.

The Gradle project was written without access to the Android SDK and has not been built yet; the SDK-free APK build is the tested path.

## Development

```
npm test          # engine rules, replays, storm, power-ups, bots soak test, server API, multiplayer room
npm run build     # dist/inkland.html
npm run build:apk # dist/inkland.apk
```

The engine is deterministic for a given seed and input sequence (`new Game({ seed })`, fixed `STEP`), which is what replays and headless tests rely on.
