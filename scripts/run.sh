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
    0) VERDICT="réservation effectuée" ;;
    2) VERDICT="aucun créneau" ;;
    3) VERDICT="compte bloqué par une réservation déjà en cours" ;;
    4) VERDICT="ATTENTION : demande envoyée, confirmation non détectée — vérifiez sur tennis.paris.fr" ;;
    *) VERDICT="ÉCHEC (code $EXIT_CODE)" ;;
esac
echo "$(date -Is) - run terminé : $VERDICT" >> "$LOG_FILE"

# Sous cron, stdout/stderr partent en mail : ces lignes finissent dans le journal via
# la redirection de l'appelant. En lancement manuel, elles évitent un run muet dont on
# ne sait rien d'autre que le code de sortie.
echo "run terminé : $VERDICT" >&2
if [ "$EXIT_CODE" -ne 0 ] && [ "$EXIT_CODE" -ne 2 ] && [ "$EXIT_CODE" -ne 3 ] && [ "$EXIT_CODE" -ne 4 ]; then
    echo "--- 20 dernières lignes de $LOG_FILE ---" >&2
    tail -n 20 "$LOG_FILE" >&2
fi

if [ -x "$APP_DIR/scripts/update_site.sh" ]; then
    "$APP_DIR/scripts/update_site.sh" || echo "$(date -Is) - mise à jour du dashboard en échec" >> "$LOG_FILE"
fi

exit $EXIT_CODE
