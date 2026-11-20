# Hidden Magic — Marché MTG de Rouyn-Noranda

Application web en français pour acheter et vendre des cartes **Magic: The Gathering**
entre joueurs de Rouyn-Noranda. Échange en personne, **aucun paiement en ligne**.

## Fonctionnalités

- **Comptes** : inscription (nom d’utilisateur, courriel, mot de passe), connexion,
  sessions par jeton dans un cookie HttpOnly. Le **premier compte créé devient
  administrateur**.
- **Annonces** : photo (redimensionnée côté client, stockée en base64 dans la base),
  nom, édition, état (Neuf, Comme neuf, Excellent, Bon, Usé), prix en $ CA, langue
  (FR/EN), foil. Visible immédiatement dans le marché. Le vendeur peut marquer
  vendu ou supprimer sa propre annonce.
- **Recherche** : par nom, édition ou vendeur, avec filtre par état.
- **Messagerie privée** : l’acheteur contacte le vendeur depuis une annonce ;
  conversations listées par utilisateur, avec le contexte de l’annonce.
- **Échange** : chaque joueur publie sa collection à échanger (cartes
  possédées) et ses cartes recherchées, consultables par tous les visiteurs.
  On peut aussi ajouter une carte à la main. Bouton « Proposer un
  échange » sur chaque carte : il ouvre une conversation privée avec le
  joueur, dans la messagerie existante.
- **Collection** (privée) : toutes les cartes importées du joueur, visibles
  par lui seul. Import en un clic depuis un export CSV **ManaBox** (onglet
  Collection → menu en haut à droite → Exporter → CSV), dans la section
  Collection du site : les classeurs rejoignent la Collection (ils ne sont
  proposés en échange que si le joueur les sélectionne), les listes
  deviennent des cartes « Recherché ». L’import remplace la collection
  actuelle, donc on réimporte pour la mettre à jour ; les choix d’échange
  sont conservés lors d’un réimport. Tri (prix, nom, édition, rareté, plus
  récents), filtres (type, rareté, foil, état, langue, proposées ou non) et
  valeur totale affichée. Bouton « Publier » sur chaque carte pour créer
  une annonce pré-remplie, avec l’image officielle de la carte.
- **Signalements** : tout membre peut signaler une annonce, un message ou un
  utilisateur (motif facultatif). Un même membre ne peut pas signaler deux fois
  le même élément, ni se signaler lui-même.
- **Modération (admin)** : file des signalements en attente, annonces signalées
  en tête de liste avec un badge rouge indiquant le nombre de signalements.
  Pour chaque signalement : rejeter, supprimer l’annonce/le message, ou bloquer
  l’utilisateur. Liste des membres avec blocage/déblocage.
- **Compte bloqué** : ne peut plus publier d’annonces, ouvrir de conversation
  ni envoyer de messages, et voit un bandeau explicatif.

## Technique

- **Pile** : Node.js + Express, un seul service qui sert l’API et le site statique
  (aucune étape de compilation côté client).
- **Base de données** : SQLite via `@libsql/client`. En production, Turso
  (SQLite dans le nuage, offre gratuite) ; en local, un fichier
  `./data/hidden-magic.db` quand `TURSO_DATABASE_URL` est absent.
- **Photos** : redimensionnées côté client (900 px max, JPEG 0,75) puis stockées
  en base64 dans la base — le disque des services gratuits de Render est
  éphémère, on ne stocke donc jamais de fichiers sur le disque.
- **Sécurité** : mots de passe hachés (scrypt + sel), requêtes préparées partout,
  vérifications d’autorisation côté serveur (routes admin, propriété des
  annonces, garde-fou « compte bloqué » en tête de la publication, de l’ouverture
  de conversation et de l’envoi de message).

## Développement local

```bash
npm install
cp .env.example .env   # puis ajustez SESSION_SECRET
npm start              # http://localhost:3000
```

Sans `TURSO_DATABASE_URL`, le serveur crée et utilise `./data/hidden-magic.db`.
Pour tester contre Turso en local, renseignez `TURSO_DATABASE_URL` et
`TURSO_AUTH_TOKEN` dans `.env` (ne commettez jamais ce fichier).

## Déploiement (Render gratuit + Turso gratuit)

### 1. Créer la base de données Turso

Installez l’interface Turso (une seule fois, sur votre ordinateur) :

```bash
curl -sSfL https://get.tur.so/install.sh | bash
turso auth signup   # ou : turso auth login
turso db create hidden-magic
```

Récupérez l’URL et créez un jeton :

```bash
turso db show hidden-magic          # copiez « URL » → TURSO_DATABASE_URL
turso db tokens create hidden-magic # copiez le jeton → TURSO_AUTH_TOKEN
```

### 2. Mettre le code dans un dépôt Git

```bash
git init
git add .
git commit -m "Hidden Magic v1"
```

Poussez le dépôt sur GitHub (ou GitLab). Le fichier `render.yaml` à la racine
décrit le service pour Render.

### 3. Créer le service web sur Render

1. Sur [render.com](https://render.com), créez un compte gratuit.
2. **New → Blueprint**, connectez votre dépôt : Render détecte `render.yaml`
   et crée le service web gratuit (`hidden-magic`).
   - Sinon : **New → Web Service**, choisissez le dépôt, puis :
     - **Build Command** : `npm install`
     - **Start Command** : `npm start`
3. Dans **Environment**, ajoutez les variables :
   - `TURSO_DATABASE_URL` : l’URL copiée à l’étape 1
   - `TURSO_AUTH_TOKEN` : le jeton copié à l’étape 1
   - `SESSION_SECRET` : une longue chaîne aléatoire (Render peut la générer
     avec « Generate » ; avec le Blueprint, elle est générée automatiquement)
   - `NODE_ENV` : `production`
4. **Deploy** : Render construit puis démarre le service. L’adresse sera du type
   `https://hidden-magic.onrender.com`.

### 4. Créer le compte administrateur

Ouvrez l’adresse du site et créez le **tout premier compte** : il devient
automatiquement administrateur. Faites-le avant de partager l’adresse, pour
que personne d’autre ne prenne ce rôle.

### 5. Partager le site

Partagez l’adresse Render aux joueurs de Rouyn-Noranda. Ils créent leur compte,
publient leurs annonces et se contactent par messagerie privée.

## À savoir sur l’offre gratuite de Render

- **Mise en veille** : après 15 minutes sans visite, le service gratuit
  s’endort. La première visite suivante prend environ une minute à réveiller
  le site (page de chargement de Render), puis tout redevient normal.
- **Disque éphémère** : les fichiers écrits sur le disque disparaissent à
  chaque redéploiement — c’est pourquoi les photos vivent dans la base Turso.
- **Limites** : 750 heures d’instance gratuite par mois et par espace de travail
  (largement assez pour un seul service). Si le site devient très fréquenté,
  le forfait payant à 7 $/mois supprime la mise en veille.

## Structure du projet

```
hidden-magic/
├── server.js          # API Express + schéma de la base + sécurité
├── public/
│   ├── index.html     # Structure du site (français, mobile d’abord)
│   ├── app.js         # Logique cliente (marché, publication, messages, admin)
│   └── styles.css     # Style sombre et fantastique
├── render.yaml        # Blueprint Render (service web gratuit)
├── .env.example       # Variables d’environnement à renseigner
├── package.json
└── README.md
```
