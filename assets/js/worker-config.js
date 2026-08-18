/**
 * URL de votre Cloudflare Worker (backend sans carte bancaire requise).
 * Voir cf-worker/worker.js + DOCUMENTATION.html pour le déploiement.
 * Exemple : "https://studio-couverture-worker.VOTRE-SOUS-DOMAINE.workers.dev"
 */
const WORKER_URL = "https://dry-hall-3c93.leblancroben.workers.dev";
const WORKER_IS_CONFIGURED = WORKER_URL.length > 0;
