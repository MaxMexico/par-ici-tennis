#!/bin/bash

set -euo pipefail

# --- CONFIGURATION (surchargeable par variables d'environnement) ---
APP_DIR="${APP_DIR:-$HOME/par-ici-tennis}"
WWW_DIR="${WWW_DIR:-$HOME/www}"
OUTPUT="$WWW_DIR/index.html"
LOG_FILE="${LOG_FILE:-$HOME/tennis.log}"
CONFIG_FILE="${CONFIG_FILE:-$APP_DIR/config.json}"
NEXT_RUN="${NEXT_RUN:-07:55}"
DATE=$(date "+%d/%m/%Y à %H:%M")
TODAY=$(date "+%Y-%m-%d")

mkdir -p "$WWW_DIR"

# --- ANALYSE DES DONNÉES ---
COURTS=$(jq -r 'if (.locations | type) == "array" then .locations | join(", ") else .locations | keys | join(", ") end' "$CONFIG_FILE")
COURTS=${COURTS//&/&amp;}
COURTS=${COURTS//</&lt;}
COURTS=${COURTS//>/&gt;}

# --- DÉTERMINATION DU STATUT ---
# Le log est cumulatif : on ne regarde que les lignes du jour, sinon un succès ancien
# fige le dashboard sur "RÉSERVÉ !" indéfiniment et masque les échecs suivants.
TODAY_LOG=""
if [ -s "$LOG_FILE" ]; then
    TODAY_LOG=$(grep "^$TODAY" "$LOG_FILE" || true)
fi

STATUS="En attente"
COLOR_BG="#f2f2f7"
COLOR_TXT="#1c1c1e"
ICON="💤"

if [ -z "$TODAY_LOG" ]; then
    STATUS="Prêt"
elif grep -q "Réservation faite" <<< "$TODAY_LOG"; then
    STATUS="RÉSERVÉ !"
    COLOR_BG="#34c759"
    COLOR_TXT="#ffffff"
    ICON="🎾"
elif grep -q "a repondu en erreur (502)" <<< "$TODAY_LOG"; then
    STATUS="Site en panne"
    COLOR_BG="#ff3b30"
    COLOR_TXT="#ffffff"
    ICON="🔌"
elif grep -q "confirmation non détectée" <<< "$TODAY_LOG"; then
    STATUS="À vérifier"
    COLOR_BG="#ff9500"
    COLOR_TXT="#ffffff"
    ICON="❓"
elif grep -q "déjà une réservation en cours" <<< "$TODAY_LOG"; then
    STATUS="Déjà réservé"
    COLOR_BG="#5856d6"
    COLOR_TXT="#ffffff"
    ICON="🔒"
elif grep -q "ÉCHEC" <<< "$TODAY_LOG"; then
    STATUS="Erreur"
    COLOR_BG="#ff3b30"
    COLOR_TXT="#ffffff"
    ICON="❌"
elif grep -q "Aucun créneau trouvé" <<< "$TODAY_LOG"; then
    STATUS="Aucun créneau"
    COLOR_BG="#ff9500"
    COLOR_TXT="#ffffff"
    ICON="⚠️"
else
    STATUS="En cours"
    ICON="⏳"
fi

# --- GÉNÉRATION HTML ---
cat <<EOF > $OUTPUT
<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Tennis Dashboard</title>
    <style>
        :root { --bg-color: #f2f2f7; --card-bg: #ffffff; --text-main: #000000; --text-sec: #8e8e93; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background-color: var(--bg-color); margin: 0; padding: 20px; display: flex; justify-content: center; color: var(--text-main); -webkit-font-smoothing: antialiased; }
        .container { width: 100%; max-width: 500px; display: flex; flex-direction: column; gap: 15px; }

        .header { text-align: center; margin-bottom: 10px; }
        .header h1 { margin: 0; font-size: 22px; font-weight: 700; }
        .header p { margin: 5px 0 0; color: var(--text-sec); font-size: 13px; }

        .status-card { background-color: $COLOR_BG; color: $COLOR_TXT; padding: 30px; border-radius: 22px; text-align: center; box-shadow: 0 8px 20px rgba(0,0,0,0.12); }
        .status-icon { font-size: 40px; margin-bottom: 10px; display: block; }
        .status-text { font-size: 28px; font-weight: 800; margin: 0; letter-spacing: -0.5px; }
        .status-sub { opacity: 0.9; font-size: 14px; margin-top: 5px; font-weight: 500; }

        .card { background: var(--card-bg); padding: 15px; border-radius: 18px; box-shadow: 0 2px 10px rgba(0,0,0,0.05); }
        .card-label { font-size: 11px; text-transform: uppercase; color: var(--text-sec); font-weight: 600; margin-bottom: 5px; letter-spacing: 0.5px; }
        .card-value { font-size: 15px; font-weight: 600; overflow-wrap: break-word; }

        .logs-container { background: #1c1c1e; border-radius: 18px; padding: 20px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
        .logs-title { color: #8e8e93; font-size: 12px; font-weight: 600; margin-bottom: 10px; text-transform: uppercase; display: flex; justify-content: space-between; }
        .logs-content { font-family: "SF Mono", "Menlo", monospace; font-size: 11px; color: #32d74b; white-space: pre-wrap; line-height: 1.4; max-height: 300px; overflow-y: auto; }

        .footer { text-align: center; margin-top: 20px; font-size: 11px; color: #c7c7cc; }
    </style>
</head>
<body>

<div class="container">
    <div class="header">
        <h1>Mon Tennis Bot</h1>
        <p>Mise à jour : $DATE</p>
    </div>

    <div class="status-card">
        <span class="status-icon">$ICON</span>
        <h2 class="status-text">$STATUS</h2>
        <div class="status-sub">Prochain tir : $NEXT_RUN (Europe/Paris)</div>
    </div>

    <div class="card">
        <div class="card-label">Terrains surveillés</div>
        <div class="card-value">$COURTS</div>
    </div>

    <div class="card">
        <div class="card-label">Serveur</div>
        <div class="card-value">En ligne 🟢</div>
    </div>

    <div class="logs-container">
        <div class="logs-title">
            <span>TERMINAL</span>
            <span>LIVE</span>
        </div>
        <div class="logs-content">$(if [ -s "$LOG_FILE" ]; then tail -n 25 "$LOG_FILE" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g'; else echo "En attente du prochain lancement..."; fi)</div>
    </div>

    <div class="footer">
        Propulsé par Google Cloud & Docker
    </div>
</div>

</body>
</html>
EOF
