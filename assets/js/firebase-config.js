/**
 * ============================================================
 *  CONFIGURATION FIREBASE — À REMPLIR AVANT UTILISATION
 * ============================================================
 * 1. Créez un projet sur https://console.firebase.google.com
 * 2. Activez : Authentication (Anonymous), Firestore Database, Functions (plan Blaze requis)
 * 3. Copiez vos identifiants ci-dessous (Paramètres du projet > Vos applications > Config SDK)
 * 4. Déployez la Cloud Function fournie dans /functions (voir DOCUMENTATION.html)
 *
 * Tant que ces valeurs ne sont pas renseignées, l'application fonctionne
 * en mode démo local (génération IA simulée, pas de vrais crédits).
 * ============================================================
 */
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBvJYA9UZ9Ruzu1vwgIM3WmHXGuvws16Go",
  authDomain: "studio-couverture-ai.firebaseapp.com",
  projectId: "studio-couverture-ai",
  storageBucket: "studio-couverture-ai.firebasestorage.app",
  messagingSenderId: "445979103280",
  appId: "1:445979103280:web:5146c3476b42b408f35df5"
};

// Détecte si la config a été renseignée (sinon on reste en mode démo local)
const FIREBASE_IS_CONFIGURED = FIREBASE_CONFIG.apiKey !== "VOTRE_API_KEY" && FIREBASE_CONFIG.apiKey.length > 0;
