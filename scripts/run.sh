#!/bin/bash
# Lanceur pour exécution sur serveur/VM : exécute le bot, journalise, met à jour le
# dashboard, et propage le code de sortie (0 = réservé, 1 = erreur, 2 = aucun créneau).
set -uo pipefail

APP_DIR="${APP_DIR:-$HOME/par-ici-tennis}"
LOG_FILE="${LOG_FILE:-$HOME/tennis.log}"
MAX_LOG_LINES="${MAX_LOG_LINES:-2000}"

cd "$APP_DIR" || exit 1

# Rotation simple : sans ça le log grossit indéfiniment et le dashboard devient illisible.
if [ -f "$LOG_FILE" ] && [ "$(wc -l < "$LOG_FILE")" -gt "$MAX_LOG_LINES" ]; then
    tail -n "$MAX_LOG_LINES" "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
fi

npm start >> "$LOG_FILE" 2>&1
EXIT_CODE=$?

case $EXIT_CODE in
    0) echo "$(date -Is) - run terminé : réservation effectuée" >> "$LOG_FILE" ;;
    2) echo "$(date -Is) - run terminé : aucun créneau" >> "$LOG_FILE" ;;
    *) echo "$(date -Is) - run terminé : ÉCHEC (code $EXIT_CODE)" >> "$LOG_FILE" ;;
esac

if [ -x "$APP_DIR/scripts/update_site.sh" ]; then
    "$APP_DIR/scripts/update_site.sh" || echo "$(date -Is) - mise à jour du dashboard en échec" >> "$LOG_FILE"
fi

exit $EXIT_CODE
