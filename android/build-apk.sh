#!/usr/bin/env bash
# Builds dist/inkland.apk without the Android SDK.
#
# Pipeline: bundle the game (npm run build) -> javac the WebView activity
# against the Android 14 framework jar -> dex it with dx -> encode the binary
# manifest + resources with ARSCLib -> sign (APK Signature Scheme v2) with apksig.
# Build tools come from Maven Central and are checked against their .sha1 files.
#
# Signing: set INKLAND_KEYSTORE / INKLAND_KEYSTORE_PASS / INKLAND_KEY_ALIAS to use
# your own PKCS12 keystore. Otherwise a local key is generated once in
# android/.tools/ (keep it to be able to install updates over an existing install).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
TOOLS="$HERE/.tools"
WORK="$HERE/.build"
OUT="$ROOT/dist/inkland.apk"
MAVEN="https://repo1.maven.org/maven2"
export JAVA_TOOL_OPTIONS="${JAVA_TOOL_OPTIONS:-}"

log() { printf '\033[1m==> %s\033[0m\n' "$*"; }

fetch() { # <maven path> <file name>
  local url="$MAVEN/$1" dest="$TOOLS/$2" sum=""
  [ -f "$dest" ] && return
  log "Downloading $2"
  curl -fsSL --retry 4 --retry-delay 3 -o "$dest.part" "$url"
  for i in 1 2 3 4 5; do
    sum="$(curl -fsS "$url.sha1" 2>/dev/null | cut -c1-40)" && [ -n "$sum" ] && break
    sleep $((i * 3))
  done
  [ -n "$sum" ] || { echo "Could not fetch checksum for $2" >&2; exit 1; }
  echo "$sum  $dest.part" | sha1sum -c --quiet
  mv "$dest.part" "$dest"
}

mkdir -p "$TOOLS"
fetch org/robolectric/android-all/14-robolectric-10818077/android-all-14-robolectric-10818077.jar android-all.jar
fetch com/google/android/tools/dx/1.7/dx-1.7.jar dx.jar
fetch io/github/reandroid/ARSCLib/1.4.0/ARSCLib-1.4.0.jar arsclib.jar
fetch com/android/tools/build/apksig/2.3.0/apksig-2.3.0.jar apksig.jar

log "Bundling the game"
(cd "$ROOT" && node scripts/build.js)

rm -rf "$WORK"
mkdir -p "$WORK/classes" "$WORK/tools"

log "Compiling activity"
javac --release 8 -nowarn -Xlint:-options -cp "$TOOLS/android-all.jar" -d "$WORK/classes" \
  $(find "$HERE/src" -name '*.java')
# dx 1.7 only reads class files up to Java 6/7. The activity uses no Java 8
# features (no lambdas / invokedynamic), so the version stamp can be lowered.
if javap -c -p -cp "$WORK/classes" $(cd "$WORK/classes" && find . -name '*.class' | sed 's#^\./##; s#\.class$##; s#/#.#g') 2>/dev/null | grep -q invokedynamic; then
  echo "Activity code must not use lambdas or other invokedynamic features" >&2
  exit 1
fi
python3 - "$WORK/classes" <<'PY'
import pathlib, sys
for f in pathlib.Path(sys.argv[1]).rglob('*.class'):
    b = bytearray(f.read_bytes())
    b[6:8] = (50).to_bytes(2, 'big')
    f.write_bytes(b)
PY

log "Dexing"
java -cp "$TOOLS/dx.jar" com.android.dx.command.Main --dex --output="$WORK/classes.dex" "$WORK/classes"

log "Staging module"
MOD="$WORK/module"
mkdir -p "$MOD/resources/package_1" "$MOD/root/assets"
cp "$HERE/AndroidManifest.xml" "$MOD/"
cp -r "$HERE/res" "$MOD/resources/package_1/"
echo '{"package_id":127,"package_name":"com.inkland.game"}' > "$MOD/resources/package_1/package.json"
cp "$ROOT/dist/inkland.html" "$MOD/root/assets/index.html"
cp "$WORK/classes.dex" "$MOD/root/"

KEYSTORE="${INKLAND_KEYSTORE:-$TOOLS/inkland-local.p12}"
STOREPASS="${INKLAND_KEYSTORE_PASS:-inkland-local}"
ALIAS="${INKLAND_KEY_ALIAS:-inkland}"
if [ ! -f "$KEYSTORE" ]; then
  log "Generating local signing key ($KEYSTORE)"
  keytool -genkeypair -keystore "$KEYSTORE" -storetype PKCS12 -storepass "$STOREPASS" -keypass "$STOREPASS" \
    -alias "$ALIAS" -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Inkland" >/dev/null
fi

log "Packaging and signing"
CP="$TOOLS/arsclib.jar:$TOOLS/apksig.jar"
javac -nowarn -cp "$CP" -d "$WORK/tools" "$HERE/tools/ApkPackager.java"
mkdir -p "$(dirname "$OUT")"
java --add-exports java.base/sun.security.x509=ALL-UNNAMED \
     --add-exports java.base/sun.security.pkcs=ALL-UNNAMED \
     --add-exports java.base/sun.security.util=ALL-UNNAMED \
     -cp "$WORK/tools:$CP" ApkPackager "$MOD" "$WORK/unsigned.apk" "$OUT" "$KEYSTORE" "$STOREPASS" "$ALIAS" \
  | grep -vE '^\s+(Scan|Encoding|Add manifest|Building dex|Sorting|Refreshing|TableBlock|Buffering|Writing|Initializ|Can not read|Set main|Main package)'

log "Done: $OUT ($(du -h "$OUT" | cut -f1))"
