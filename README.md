# Jarvis — Phase 1 : Système de chat

Chatbot façon Claude/ChatGPT — streaming, gestion des conversations, markdown, coloration syntaxique.
Aucune mémoire cross-chat pour l'instant (c'est la Phase 2).

## Installation (sur F:\Jarvis)

1. Copie tout ce dossier dans `F:\Jarvis\`

2. Ouvre un terminal (PowerShell ou CMD) dans `F:\Jarvis\` :
   ```
   cd F:\Jarvis
   ```

3. Crée un environnement virtuel Python (recommandé) :
   ```
   python -m venv venv
   venv\Scripts\activate
   ```

4. Installe les dépendances :
   ```
   pip install -r requirements.txt
   ```

5. Récupère ta clé API Groq (gratuite) :
   - Va sur [console.groq.com](https://console.groq.com)
   - Crée un compte / connecte-toi
   - Va dans **API Keys** → **Create API Key**
   - Copie la clé générée

6. Configure ta clé :
   - Renomme `.env.example` en `.env`
   - Ouvre `.env` et remplace `colle_ta_cle_ici` par ta vraie clé Groq

7. Lance le serveur :
   ```
   python app.py
   ```

8. Ouvre ton navigateur sur : **http://127.0.0.1:5000**

C'est tout. La base de données SQLite (`data\jarvis.db`) est créée automatiquement au premier lancement.

## Structure du projet

```
F:\Jarvis\
├── app.py                  → Backend Flask (routes API, streaming SSE)
├── database.py              → Toute la logique SQLite (conversations, messages)
├── requirements.txt
├── .env                      → Ta clé Groq (à créer, jamais commit)
├── .env.example
├── data/
│   └── jarvis.db             → Base de données (créée automatiquement)
├── templates/
│   └── index.html            → Structure de la page
└── static/
    ├── css/style.css         → Tout le style (façon Claude, light/dark)
    └── js/app.js              → Toute la logique frontend
```

## Fonctionnalités incluses

- ✅ Streaming mot par mot des réponses
- ✅ Historique complet des conversations (sidebar)
- ✅ Nouvelle conversation / suppression / renommage
- ✅ Titre auto-généré à partir du premier message
- ✅ Rendu markdown (gras, italique, listes, tableaux)
- ✅ Coloration syntaxique du code + bouton copier
- ✅ Édition d'un message + régénération à partir de ce point
- ✅ Régénération de la dernière réponse
- ✅ Mode clair / sombre (persisté dans le navigateur)
- ✅ Timestamps sur chaque message

## Limitations connues (normales pour la V1)

- Le bouton "Stop" arrête l'affichage côté navigateur mais Groq continue de générer en arrière-plan côté serveur (l'arrêt réseau propre viendra si besoin — actuellement non prioritaire vu la vitesse de Groq).
- Un seul modèle fixe : `llama-3.3-70b-versatile`. Le sélecteur de modèle est prévu pour plus tard.
- Pas de pièces jointes (images/fichiers) — Phase ultérieure.
- Pas de mémoire entre conversations — c'est précisément l'objet de la Phase 2.

## Prochaine étape

Une fois que ce chat fonctionne bien et que tu l'as testé en conditions réelles, on attaque la **Phase 2 — Mémoire** :
extraction de faits depuis l'historique des conversations, scoring/dédoublonnage, stockage à plusieurs niveaux.
