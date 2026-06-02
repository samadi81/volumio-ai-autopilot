#!/usr/bin/env bash
# Deploy the AI Autopilot plugin to a Volumio device over SSH.
#
# Usage:
#   ./deploy.sh volumio@volumio.local           # install (first time) or update
#   ./deploy.sh volumio@192.168.1.50 reinstall  # force a clean reinstall
#   ./deploy.sh volumio@volumio.local fast      # just sync files + restart (no npm install)
#   ./deploy.sh volumio@volumio.local logs      # tail plugin logs
#
# Requirements on the Mac side:
#   - rsync (preinstalled)
#   - ssh  (preinstalled)
# Requirements on the Pi side:
#   - Volumio 3 or 4
#   - user 'volumio' with default password OR your SSH key in authorized_keys

set -euo pipefail

TARGET="${1:-}"
MODE="${2:-install}"

if [[ -z "$TARGET" ]]; then
  echo "usage: $0 <user@host> [install|reinstall|fast|logs]" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_NAME="ai_autopilot"

case "$MODE" in
  logs)
    ssh -t "$TARGET" "journalctl -f -u volumio | grep --line-buffered ${PLUGIN_NAME}"
    exit 0
    ;;
  fast)
    echo "[deploy] fast sync to $TARGET"
    rsync -avz --delete \
      --exclude node_modules \
      --exclude .git \
      --exclude 'history.json' \
      --exclude 'feedback.json' \
      --exclude 'system_prompt.txt' \
      --exclude 'hints.txt' \
      --exclude 'package-lock.json' \
      --exclude '*.log' \
      "$SCRIPT_DIR"/ "$TARGET:/data/plugins/music_service/$PLUGIN_NAME/"
    ssh "$TARGET" "volumio vrestart >/dev/null 2>&1 || sudo systemctl restart volumio"
    echo "[deploy] done. tail logs with:  $0 $TARGET logs"
    exit 0
    ;;
  reinstall)
    echo "[deploy] uninstall + install on $TARGET"
    ssh "$TARGET" "volumio plugin uninstall $PLUGIN_NAME || true"
    ;;
  install)
    ;;
  *)
    echo "unknown mode: $MODE" >&2
    exit 2
    ;;
esac

echo "[deploy] staging sources to $TARGET:/home/volumio/$PLUGIN_NAME"
ssh "$TARGET" "mkdir -p /home/volumio/$PLUGIN_NAME"
rsync -avz --delete --exclude node_modules --exclude .git \
  "$SCRIPT_DIR"/ "$TARGET:/home/volumio/$PLUGIN_NAME/"

echo "[deploy] running 'volumio plugin install'"
ssh -t "$TARGET" "cd /home/volumio/$PLUGIN_NAME && volumio plugin install"

echo ""
echo "[deploy] done."
echo "         - Open Volumio UI -> Plugins -> Installed Plugins -> enable AI Autopilot"
echo "         - Then tail logs:   $0 $TARGET logs"
