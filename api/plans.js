/* ============================================================
   CANCRI — Définition des forfaits
   SOURCE DE VÉRITÉ UNIQUE.
   Pour changer une offre : on modifie ce fichier, rien d'autre.
   Aucun endpoint ne doit contenir de "if plan === ...".
   ============================================================ */

const PLANS = {
  essentiel: {
    code: "essentiel",
    nom: "Essentiel",
    prix: 20,
    resume: "Digitaliser la carte de fidélité.",
    capacites: {
      clients: true,          // liste clients + fiche
      tampons: true,          // ajuster les tampons
      recompenses: true,      // valider une récompense
      stats_base: true,       // les 4 chiffres du dashboard
      programme: true,        // objectif + récompense modifiables
      messages: false,        // notifications marketing
      messages_par_jour: 0,
      segments: false,        // ciblage par catégorie de clients
      relances: false,        // relances automatiques des inactifs
      stats_avancees: false,
    },
  },

  pro: {
    code: "pro",
    nom: "Pro",
    prix: 35,
    resume: "Entretenir la relation avec ses clients.",
    capacites: {
      clients: true,
      tampons: true,
      recompenses: true,
      stats_base: true,
      programme: true,
      messages: true,
      messages_par_jour: 20,
      segments: true,
      relances: true,
      stats_avancees: true,
    },
  },
};

const PLAN_DEFAUT = "pro"; // pendant l'essai, tout le monde goûte au Pro

/* Renvoie les capacités effectives d'un commerce :
   celles de son plan, écrasées par ses éventuelles exceptions.
   commerce.plan_extras est un JSON, ex : {"relances": true}     */
function capacites(commerce) {
  const c = commerce || {};
  const plan = PLANS[c.plan] || PLANS[PLAN_DEFAUT];
  const base = Object.assign({}, plan.capacites);

  let extras = c.plan_extras;
  if (typeof extras === "string") {
    try { extras = JSON.parse(extras); } catch (e) { extras = null; }
  }
  if (extras && typeof extras === "object") Object.assign(base, extras);

  return { plan: plan.code, nom: plan.nom, prix: plan.prix, ...base };
}

/* Où en est l'abonnement : essai en cours, actif, terminé…   */
function abonnement(commerce) {
  const c = commerce || {};
  const statut = c.abonnement_statut || "essai";
  let jours_restants = null;
  if (c.essai_fin) {
    const diff = new Date(c.essai_fin).getTime() - Date.now();
    jours_restants = Math.ceil(diff / (24 * 3600 * 1000));
  }
  return {
    statut: statut,
    essai_debut: c.essai_debut || null,
    essai_fin: c.essai_fin || null,
    jours_restants: jours_restants,
    // note : on ne coupe JAMAIS l'accès automatiquement.
    // La fin d'essai déclenche une alerte dans le cockpit, la décision reste humaine.
    en_essai: statut === "essai",
  };
}

module.exports = { PLANS, PLAN_DEFAUT, capacites, abonnement };
