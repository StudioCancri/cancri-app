/* ============================================================
   API LUNAT — /api/caisse
   La petite fenêtre caisse posée au comptoir.
   Elle n'a JAMAIS accès au dashboard : elle est reconnue par un
   jeton d'appareil (obtenu une fois avec un code d'appairage
   généré par le patron dans pro.html), révocable à tout moment.

   Actions :
     - appairer : code à 6 caractères → jeton de la caisse
     - session  : infos du commerce (mode, récompenses…)
     - saisir   : l'employé saisit un montant / des tampons /
                  une récompense → en attente du tap client
     - statut   : la caisse demande si le client a tapé
     - annuler  : l'employé annule la saisie en cours
   Le tap du client (api/carte.js) consomme la saisie en attente.
   ============================================================ */

const crypto = require("crypto");
const { capacites } = require("./plans");

function nettoyerUrl(u) {
  return (u || "").trim().replace(/\/+$/, "").replace(/\/rest\/v1$/, "").replace(/\/+$/, "");
}
const SUPABASE_URL = nettoyerUrl(process.env.SUPABASE_URL);
const SECRET = (process.env.SUPABASE_SECRET || "").trim();

/* une saisie attend le client 2 minutes (le temps d'une inscription) */
const ATTENTE_S = 120;
/* garde-fous anti-triche employé */
const MONTANT_MAX_CENTS = 30000; // 300 € par saisie
const TAMPONS_MAX = 5;           // 5 tampons par saisie

async function sb(chemin, options) {
  options = options || {};
  const headers = { apikey: SECRET, Authorization: "Bearer " + SECRET, "Content-Type": "application/json" };
  if (options.method === "POST" || options.method === "PATCH") headers["Prefer"] = "return=representation";
  const r = await fetch(SUPABASE_URL + "/rest/v1/" + chemin, {
    method: options.method || "GET",
    headers: headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!r.ok) throw new Error("Supabase " + r.status + " : " + (await r.text()));
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

function hacher(v) {
  return crypto.createHash("sha256").update(String(v)).digest("hex");
}

function listeRecompenses(commerce) {
  let r = commerce.recompenses_points;
  if (typeof r === "string") { try { r = JSON.parse(r); } catch (e) { r = []; } }
  return Array.isArray(r) ? r : [];
}

/* le mode réellement actif : les points exigent le forfait qui va avec */
function modeEffectif(commerce) {
  return commerce.mode === "points" && capacites(commerce).points ? "points" : "tampons";
}

function infosCommerce(commerce, appareil) {
  return {
    caisse: appareil ? (appareil.nom || "Caisse") : null,
    nom: commerce.nom,
    slug: commerce.slug,
    mode: modeEffectif(commerce),
    points_par_euro: Number(commerce.points_par_euro) || 1,
    recompenses: listeRecompenses(commerce),
    objectif: commerce.objectif,
    recompense: commerce.recompense,
    unite: commerce.unite,
    couleur_fond: commerce.couleur_fond || null,
    couleur_texte: commerce.couleur_texte || null,
  };
}

async function appareilParJeton(jeton) {
  if (!jeton || typeof jeton !== "string" || jeton.length < 20) return null;
  const rows = await sb("appareils_caisse?jeton_hash=eq." + hacher(jeton) + "&actif=eq.true&select=*");
  return rows && rows[0] ? rows[0] : null;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(200).json({ ok: true, info: "API caisse" });

  try {
    let body = req.body;
    if (typeof body === "string") body = JSON.parse(body || "{}");
    body = body || {};
    const action = body.action;

    /* ---------- APPAIRER : code du patron → jeton de la caisse ---------- */
    if (action === "appairer") {
      const code = (body.code || "").toString().toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (code.length !== 6) return res.status(200).json({ ok: false, raison: "code_invalide" });
      const rows = await sb(
        "appareils_caisse?code_appairage=eq." + hacher(code) +
        "&code_expire=gt." + encodeURIComponent(new Date().toISOString()) +
        "&actif=eq.true&select=*"
      );
      const app = rows && rows[0];
      if (!app) return res.status(200).json({ ok: false, raison: "code_invalide" });

      const jeton = crypto.randomBytes(24).toString("base64url");
      const maj = await sb("appareils_caisse?id=eq." + app.id, {
        method: "PATCH",
        body: {
          jeton_hash: hacher(jeton),
          code_appairage: null,
          code_expire: null,
          dernier_usage: new Date().toISOString(),
        },
      });
      const com = await sb("commerces?id=eq." + app.commerce_id + "&select=*");
      return res.status(200).json({ ok: true, jeton: jeton, commerce: infosCommerce(com[0], maj[0]) });
    }

    /* ---------- toutes les autres actions : caisse reconnue ---------- */
    const appareil = await appareilParJeton(body.jeton);
    if (!appareil) return res.status(200).json({ ok: false, raison: "caisse_inconnue" });
    const coms = await sb("commerces?id=eq." + appareil.commerce_id + "&select=*");
    const commerce = coms && coms[0];
    if (!commerce) return res.status(200).json({ ok: false, raison: "caisse_inconnue" });

    /* ---------- SESSION ---------- */
    if (action === "session") {
      await sb("appareils_caisse?id=eq." + appareil.id, {
        method: "PATCH",
        body: { dernier_usage: new Date().toISOString() },
      });
      return res.status(200).json({ ok: true, commerce: infosCommerce(commerce, appareil) });
    }

    /* ---------- SAISIR ---------- */
    if (action === "saisir") {
      const mode = modeEffectif(commerce);
      const type = (body.type || "").toString();
      const ligne = {
        commerce_id: commerce.id,
        appareil_id: appareil.id,
        type: type,
        statut: "en_attente",
        expire_le: new Date(Date.now() + ATTENTE_S * 1000).toISOString(),
      };

      if (type === "points") {
        if (mode !== "points") return res.status(200).json({ ok: false, raison: "mode_incorrect" });
        const cents = Math.round(Number(body.montant_cents));
        if (!isFinite(cents) || cents < 1) return res.status(200).json({ ok: false, raison: "montant_invalide" });
        if (cents > MONTANT_MAX_CENTS) return res.status(200).json({ ok: false, raison: "montant_trop_eleve", max: MONTANT_MAX_CENTS / 100 });
        ligne.valeur = cents;
      } else if (type === "tampons") {
        if (mode !== "tampons") return res.status(200).json({ ok: false, raison: "mode_incorrect" });
        const n = parseInt(body.nombre, 10);
        if (!(n >= 1 && n <= TAMPONS_MAX)) return res.status(200).json({ ok: false, raison: "nombre_invalide" });
        ligne.valeur = n;
      } else if (type === "recompense") {
        if (mode === "points") {
          const rec = listeRecompenses(commerce).find(function (x) { return x.id === body.recompense_id; });
          if (!rec) return res.status(200).json({ ok: false, raison: "recompense_inconnue" });
          ligne.recompense_id = rec.id;
          ligne.valeur = rec.cout;
        }
      } else {
        return res.status(200).json({ ok: false, raison: "type_inconnu" });
      }

      /* une seule saisie en cours par caisse : on annule la précédente */
      await sb("caisse_attente?appareil_id=eq." + appareil.id + "&statut=eq.en_attente", {
        method: "PATCH",
        body: { statut: "annule" },
      });
      const ins = await sb("caisse_attente", { method: "POST", body: ligne });
      return res.status(200).json({ ok: true, id: ins[0].id, expire_le: ins[0].expire_le, attente_s: ATTENTE_S });
    }

    /* ---------- STATUT ---------- */
    if (action === "statut") {
      const rows = await sb("caisse_attente?id=eq." + encodeURIComponent(body.id || "") +
        "&appareil_id=eq." + appareil.id + "&select=id,statut,resultat,expire_le");
      const s = rows && rows[0];
      if (!s) return res.status(200).json({ ok: false, raison: "introuvable" });
      if (s.statut === "en_attente" && new Date(s.expire_le).getTime() < Date.now()) {
        await sb("caisse_attente?id=eq." + s.id + "&statut=eq.en_attente", { method: "PATCH", body: { statut: "expire" } });
        s.statut = "expire";
      }
      return res.status(200).json({ ok: true, statut: s.statut, resultat: s.resultat || null });
    }

    /* ---------- ANNULER ---------- */
    if (action === "annuler") {
      await sb("caisse_attente?id=eq." + encodeURIComponent(body.id || "") +
        "&appareil_id=eq." + appareil.id + "&statut=eq.en_attente", {
        method: "PATCH",
        body: { statut: "annule" },
      });
      return res.status(200).json({ ok: true });
    }

    return res.status(200).json({ ok: false, raison: "action_inconnue" });
  } catch (e) {
    console.error("caisse error:", e.message || e);
    return res.status(200).json({ ok: false, raison: "erreur_serveur" });
  }
};
