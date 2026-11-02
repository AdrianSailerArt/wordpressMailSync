#!/bin/sh
# Startet das Dashboard automatisch beim Anmelden am Mac (LaunchAgent).
#   Einrichten:  sh scripts/autostart-macos.sh
#   Entfernen:   sh scripts/autostart-macos.sh --remove
# Logs: data/server.log
set -e

LABEL="de.adriansailerart.wordpress-mail-sync"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUN="${BUN:-$(command -v bun || echo "$HOME/.bun/bin/bun")}"

if [ "$1" = "--remove" ]; then
  launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Autostart entfernt."
  exit 0
fi

[ -f "$DIR/.env" ] || { echo "Bitte zuerst .env anlegen (cp .env.example .env)."; exit 1; }
[ -x "$BUN" ] || { echo "Bun nicht gefunden – siehe https://bun.sh"; exit 1; }

mkdir -p "$DIR/data" "$HOME/Library/LaunchAgents"
"$BUN" run --cwd "$DIR" build >/dev/null

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$BUN</string><string>run</string><string>server/index.ts</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DIR/data/server.log</string>
  <key>StandardErrorPath</key><string>$DIR/data/server.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Autostart eingerichtet – Dashboard: http://127.0.0.1:3000"
