# Planning de réservations

Application web autonome (Node.js + Express, stockage en fichier JSON) pour gérer un planning
partagé de créneaux d'1h, du lundi au vendredi 10h–13h et 18h–21h, et le
samedi 10h–13h uniquement (fermeture à 13h), avec un
maximum de 4 personnes par créneau. Fonctionne pour tout le monde sans compte
Claude — juste un lien vers le site.

## Fonctionnement

- **Utilisateurs** : choisissent leur nom dans une liste déroulante (gérée par
  l'admin), voient qui est déjà inscrit sur chaque créneau, réservent ou
  annulent leur propre réservation. Si un créneau a déjà 4 personnes, il
  passe automatiquement en "Complet" et il faut choisir un autre horaire.
- **Semaine** : la semaine affichée se calcule automatiquement (numéro de
  semaine ISO) et se réinitialise toute seule chaque lundi. On peut naviguer
  vers la semaine suivante/précédente pour réserver à l'avance.
- **Administrateur** : bouton "Administration" protégé par mot de passe.
  Permet d'ajouter/retirer des personnes de la liste, de forcer l'ajout ou le
  retrait de n'importe qui sur n'importe quel créneau (même au-delà de la
  limite de 4), et de changer le mot de passe admin.
- **Données** : stockées dans un simple fichier JSON (`data/db.json`), créé
  automatiquement au premier démarrage. Aucune base de données à installer, et
  aucune compilation native requise (contrairement à des libs comme
  `better-sqlite3`) — c'est voulu, pour que `npm install` fonctionne du premier
  coup sur n'importe quelle machine, y compris Windows sans Python ni outils de
  compilation.

## Lancer en local

Prérequis : [Node.js](https://nodejs.org) version 18 ou plus.

```bash
npm install
npm start
```

Puis ouvrez `http://localhost:3000` dans un navigateur.

Le mot de passe administrateur par défaut est `admin1234`. Changez-le dès la
première connexion (bouton Administration → section "Mot de passe
administrateur"), ou définissez-le au démarrage avec une variable
d'environnement :

```bash
ADMIN_PASSWORD=motdepasse_perso npm start
```

## Déployer en ligne pour que tout le monde y accède

Il faut un hébergeur qui garde un disque **persistant** (le fichier JSON
doit survivre aux redémarrages). Trois options simples, du plus facile au
plus flexible :

### Option A — Railway.app (recommandé, le plus simple)

1. Créez un compte sur [railway.app](https://railway.app).
2. "New Project" → "Deploy from GitHub repo" (poussez d'abord ce dossier sur
   un dépôt GitHub), ou "Empty Project" puis glissez-déposez le dossier.
3. Railway détecte `package.json` et lance `npm start` automatiquement.
4. Dans l'onglet **Variables**, ajoutez `ADMIN_PASSWORD` avec votre mot de
   passe.
5. Dans l'onglet **Volumes**, ajoutez un volume monté sur `/app/data` pour
   que les réservations ne soient pas perdues à chaque redéploiement.
6. Railway fournit une URL publique (`xxxx.up.railway.app`) — c'est le lien
   à envoyer aux 50-70 personnes.

### Option B — Render.com

1. Créez un compte sur [render.com](https://render.com), "New +" →
   "Web Service", connectez votre dépôt GitHub.
2. Build Command : `npm install` — Start Command : `npm start`.
3. Ajoutez un **Persistent Disk** (payant, ~1$/mois) monté sur `/opt/render/project/src/data`,
   sinon les réservations repartent à zéro à chaque déploiement/redémarrage.
4. Ajoutez la variable d'environnement `ADMIN_PASSWORD`.

### Option C — Un petit VPS (le plus robuste, nécessite un peu plus de mise en place)

Sur un serveur Linux (OVH, Scaleway, etc.) avec Node.js installé :

```bash
git clone <votre-repo> planning-app
cd planning-app
npm install
npm install -g pm2
ADMIN_PASSWORD=motdepasse_perso pm2 start server.js --name planning
pm2 save
pm2 startup
```

Mettez ensuite un reverse proxy (nginx) devant, avec un certificat HTTPS
gratuit via Let's Encrypt/Certbot, pour avoir une URL propre du type
`https://planning.votredomaine.fr`.

## Structure du projet

```
planning-app/
├── server.js          # API Express
├── store.js            # Stockage JSON (lecture/écriture de data/db.json)
├── package.json
├── public/
│   ├── index.html      # page principale
│   ├── style.css
│   └── app.js           # logique du planning (grille, réservations, admin)
└── data/                # créé automatiquement, contient db.json
```

## En cas de problème à l'installation

Si un `npm install` a déjà échoué une fois chez vous (par exemple à cause
d'une ancienne version qui utilisait une librairie nécessitant une
compilation), le dossier peut rester dans un état à moitié installé. Dans ce
cas, repartez propre :

```bash
# Supprimez le dossier node_modules et le fichier de verrouillage
rmdir /s /q node_modules      (Windows, invite de commandes)
rm -rf node_modules           (Mac/Linux, ou PowerShell avec rm)
del package-lock.json         (Windows)
rm package-lock.json          (Mac/Linux)

# Puis réinstallez
npm install
npm start
```

Ce projet n'utilise volontairement **aucune librairie nécessitant une
compilation native** (pas de Python, pas de Visual Studio Build Tools
requis) — `npm install` doit toujours se dérouler en quelques secondes, sans
erreur `node-gyp` ni `EPERM`. Si une erreur de ce type apparaît malgré tout,
c'est probablement un résidu d'une installation précédente : suivez les
étapes ci-dessus.

## Personnalisation rapide

- **Horaires/jours** : modifiez `DAYS`, `MORNING_HOURS`, `EVENING_HOURS` en
  haut de `public/app.js` (et `VALID_HOURS` dans `server.js` en conséquence).
- **Limite par créneau** : `MAX_PER_SLOT` dans `public/app.js` et
  `server.js`.
- **Couleurs/style** : variables CSS en haut de `public/style.css`.
