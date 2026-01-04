# Visio 1 (MVP)

Petit MVP de visioconférence WebRTC (mesh) :
- Pas de login
- Salon via l’URL `?room=xxxx`
- Bouton **+** : active caméra/micro et rejoint la visio
- Signaling via **Socket.IO**
- UI responsive

## Prérequis
- Node.js >= 18
- npm

## Installation
Dans le dossier du projet :
```bash
npm install
```

## Lancer en local
Pour lancer l'application (client React + serveur Node) :
```bash
npm start
```
- Client : [http://localhost:3000](http://localhost:3000)
- Santé du serveur : [http://localhost:5000/health](http://localhost:5000/health)

## Mode d'emploi
1. Accédez à une URL de type `http://localhost:3000?room=ma-piece`.
2. Cliquez sur le bouton **+** pour activer votre caméra/micro et rejoindre la session.
3. Partagez l'URL avec un collaborateur pour tester le flux WebRTC.

## Notes
- **HTTPS** : Pour tester sur mobile ou entre plusieurs machines, l'application doit être servie en HTTPS ou via un tunnel (ex: ngrok) car les navigateurs bloquent l'accès à la caméra en HTTP (sauf localhost).
- **Signalisation** : L'URL du serveur de signalisation peut être configurée via la variable `REACT_APP_SIGNALING_URL`. Par défaut, elle pointe sur `http://localhost:5000`.
- **TURN/STUN** : Pour l'instant, seuls des serveurs STUN publics sont utilisés. Pour une utilisation réelle en entreprise, un serveur TURN sera nécessaire.

## Structure du projet
- `server.js` : Serveur Node.js (Express + Socket.IO) pour la signalisation.
- `src/` : Code source React pour l'interface utilisateur et la logique WebRTC.
