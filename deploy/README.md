# Déploiement sur VM (Google Cloud, VPS, Raspberry…)

Un timer systemd est préférable à `cron` ici : il gère nativement `Europe/Paris` et le
passage heure d'été / heure d'hiver, là où cron impose de jongler avec deux horaires UTC.

## Installation

```sh
# 1. Le code et les dépendances
git clone https://github.com/MaxMexico/par-ici-tennis.git ~/par-ici-tennis
cd ~/par-ici-tennis && npm ci
chmod +x scripts/run.sh scripts/update_site.sh

# 2. La config (SANS les identifiants)
cp config.json.sample config.json && "$EDITOR" config.json

# 3. Les identifiants, hors du dépôt et hors de config.json
cat > ~/.par-ici-tennis.env <<'EOF'
ACCOUNT_EMAIL=vous@exemple.fr
ACCOUNT_PASSWORD=...
NTFY_TOPIC=votre-topic-difficile-a-deviner
EOF
chmod 600 ~/.par-ici-tennis.env

# 4. Le timer
sudo cp deploy/tennis-bot.service /etc/systemd/system/tennis-bot@.service
sudo cp deploy/tennis-bot.timer   /etc/systemd/system/tennis-bot.timer
sudo systemctl daemon-reload
sudo systemctl enable --now tennis-bot.timer
```

Le service est templaté sur l'utilisateur : le timer doit déclencher `tennis-bot@<user>`.
Si vous préférez un service simple, remplacez `%i` par votre nom d'utilisateur et
`%h` par votre home dans `tennis-bot.service`.

## Vérifications

```sh
systemctl list-timers tennis-bot.timer     # prochain déclenchement
timedatectl                                # "System clock synchronized: yes" — indispensable
journalctl -u tennis-bot@$USER -n 50       # dernier run
tail -f ~/tennis.log
```

L'horloge est critique : le bot vise `08:00:00.000`. Sur GCE, `systemd-timesyncd` ou
`chrony` se synchronise sur `metadata.google.internal` par défaut ; vérifiez que
`timedatectl` affiche bien `System clock synchronized: yes`.

## Codes de sortie

| Code | Signification |
|------|---------------|
| `0`  | Réservation effectuée |
| `1`  | Erreur (identifiants, site injoignable, sélecteur cassé…) |
| `2`  | Aucun créneau disponible |
| `3`  | Compte bloqué par une réservation déjà en cours (voir `replaceExistingReservation`) |
| `4`  | Demande envoyée mais confirmation non détectée — **vérifiez avant de relancer** |

## Diagnostic d'un échec

Chaque échec écrit une trace dans `~/par-ici-tennis/img/` :

- `failure.png` / `failure.html` — état de la page au moment de l'erreur
- `no-slot-found.png` / `.html` — page de résultats quand aucun créneau n'est trouvé
- `slot-click-failed-*.html` — créneau cliqué sans arrivée sur le tunnel de réservation
- `confirmation-uncertain.html` — demande envoyée sans page de confirmation détectée

Le `.html` est le plus utile : il permet de vérifier si les sélecteurs du site ont changé
sans avoir à reproduire la situation à 08:00 du matin.

## Test à blanc

```sh
cd ~/par-ici-tennis && npm run start-dry
```

En dry-run, le bot ne respecte pas la barrière d'ouverture si elle est déjà passée : il
cherche immédiatement et annule toute réservation entamée. À lancer régulièrement pour
détecter un changement du site **avant** le jour où vous en avez besoin.
