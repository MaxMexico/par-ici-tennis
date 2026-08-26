#!/bin/bash
# Collecte l'état de la machine et du bot pour diagnostic.
# Lecture seule : ce script ne modifie rien.
# Les identifiants sont expurgés — la sortie est conçue pour être partagée.

APP_DIR="${APP_DIR:-$HOME/par-ici-tennis}"
LOG_FILE="${LOG_FILE:-$HOME/tennis.log}"
CONFIG_FILE="${CONFIG_FILE:-$APP_DIR/config.json}"

section() { printf '\n===== %s =====\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }

echo "Diagnostic par-ici-tennis — $(date -Is)"

section "SYSTÈME"
have lsb_release && lsb_release -ds || cat /etc/os-release 2>/dev/null | grep PRETTY_NAME
echo "noyau  : $(uname -sr)"
echo "uptime : $(uptime -p 2>/dev/null)"
echo "mémoire:"; free -h 2>/dev/null | head -2
echo "disque :"; df -h "$HOME" 2>/dev/null | tail -1

section "HORLOGE — critique : le bot vise 08:00:00.000"
timedatectl 2>/dev/null || { echo "timedatectl absent"; date; }
if have chronyc; then echo "--- chrony ---"; chronyc tracking 2>/dev/null | grep -E "Reference|System time|Last offset"; fi
# Dérive par rapport à l'horloge du serveur cible : c'est elle qui fait foi pour l'ouverture.
if have curl; then
  REMOTE=$(curl -sSI --max-time 10 https://tennis.paris.fr/ 2>/dev/null | grep -i '^date:' | cut -d' ' -f2-)
  if [ -n "$REMOTE" ]; then
    R=$(date -d "$REMOTE" +%s 2>/dev/null); L=$(date +%s)
    echo "horloge tennis.paris.fr : $REMOTE"
    echo "horloge locale          : $(date -R)"
    echo "écart local - serveur   : $((L - R)) s"
  else
    echo "en-tête Date non récupérée (site injoignable ?)"
  fi
fi

section "RUNTIME"
have node && echo "node : $(node --version)" || echo "node : ABSENT"
have npm  && echo "npm  : $(npm --version)"  || echo "npm  : ABSENT"
echo "navigateurs Playwright :"
ls -1 ~/.cache/ms-playwright 2>/dev/null || echo "  aucun dans ~/.cache/ms-playwright"

section "DÉPÔT"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" log --oneline -1
  echo "branche : $(git -C "$APP_DIR" rev-parse --abbrev-ref HEAD)"
  echo "modifications locales non commitées :"
  git -C "$APP_DIR" status --short | head -20
else
  echo "pas de dépôt git dans $APP_DIR"
fi

section "PLANIFICATION — quand le bot part-il réellement ?"
echo "--- timers systemd ---"
systemctl list-timers --all 2>/dev/null | grep -iE "tennis|NEXT" || echo "aucun timer tennis"
echo "--- crontab utilisateur ---"
crontab -l 2>/dev/null || echo "aucune crontab utilisateur"
echo "--- cron système ---"
grep -rils tennis /etc/cron* /etc/crontab 2>/dev/null || echo "aucune entrée système"
echo "--- conteneurs docker ---"
have docker && (docker ps -a --format '{{.Names}}\t{{.Status}}\t{{.Image}}' 2>/dev/null || echo "docker inaccessible sans sudo") || echo "docker absent"

section "CONFIG (expurgée)"
if [ -f "$CONFIG_FILE" ]; then
  if have jq; then
    # account et ntfy.topic sont retirés : ils ne doivent pas sortir de la machine.
    jq 'del(.account) | if .ntfy then .ntfy |= (del(.topic) + {topic: "<masqué>"}) else . end' "$CONFIG_FILE"
    echo "--- contrôles ---"
    jq -r 'if .account then "⚠️  config.json contient un bloc account (identifiants en clair sur disque)" else "✅ pas d_identifiants dans config.json" end' "$CONFIG_FILE"
  else
    echo "jq absent — champs présents :"
    grep -oE '"[a-zA-Z]+"[[:space:]]*:' "$CONFIG_FILE" | tr -d '":' | sort -u | tr '\n' ' '; echo
  fi
else
  echo "config.json ABSENT dans $CONFIG_FILE"
fi
echo "identifiants en variables d'environnement :"
for v in ACCOUNT_EMAIL ACCOUNT_PASSWORD NTFY_TOPIC; do
  [ -n "${!v:-}" ] && echo "  $v : défini" || echo "  $v : non défini dans ce shell"
done
[ -f "$HOME/.par-ici-tennis.env" ] && echo "  fichier ~/.par-ici-tennis.env présent (permissions: $(stat -c %a "$HOME/.par-ici-tennis.env"))"

section "JOURNAL — chronologie des derniers runs"
if [ -f "$LOG_FILE" ]; then
  echo "taille : $(wc -l < "$LOG_FILE") lignes, dernière écriture $(date -r "$LOG_FILE" -Is)"
  echo "--- verdicts par jour (30 derniers) ---"
  grep -hoE "^[0-9]{4}-[0-9]{2}-[0-9]{2}|Réservation faite|Aucun créneau|ÉCHEC|Failed to find" "$LOG_FILE" 2>/dev/null | tail -60
  echo "--- 60 dernières lignes ---"
  tail -n 60 "$LOG_FILE"
else
  echo "aucun journal en $LOG_FILE"
fi

section "TRACES D'ÉCHEC"
ls -lh "$APP_DIR/img" 2>/dev/null || echo "aucun dossier img/ (normal si la version corrigée n'est pas déployée)"

section "RÉSEAU"
if have curl; then
  echo "tennis.paris.fr :"
  curl -sS -o /dev/null --max-time 15 \
    -w "  code=%{http_code} dns=%{time_namelookup}s tls=%{time_appconnect}s total=%{time_total}s\n" \
    https://tennis.paris.fr/tennis/jsp/site/Portal.jsp?page=recherche 2>&1 || echo "  INJOIGNABLE"
  echo "IP sortante : $(curl -sS --max-time 10 https://api.ipify.org 2>/dev/null || echo inconnue)"
fi

echo
echo "===== FIN — vérifiez l'absence de données sensibles avant de partager ====="
