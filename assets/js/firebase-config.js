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
  apiKey: "VOTRE_API_KEY",
  authDomain: "VOTRE_PROJET.firebaseapp.com",
  projectId: "VOTRE_PROJET",
  storageBucket: "VOTRE_PROJET.appspot.com",
  messagingSenderId: "VOTRE_SENDER_ID",
  appId: "VOTRE_APP_ID"
};

// Détecte si la config a été renseignée (sinon on reste en mode démo local)
const FIREBASE_IS_CONFIGURED = FIREBASE_CONFIG.apiKey !== "VOTRE_API_KEY" && FIREBASE_CONFIG.apiKey.length > 0;
