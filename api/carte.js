/* ============================================================
   API CANCRI — /api/carte  (Vercel serverless)
   Une seule porte d'entrée, 4 actions :
   - creer   : nouvelle carte (tampon de bienvenue = 1)
   - etat    : lire l'état de la carte
   - tap     : +1 tampon (cooldown 15 s, 3/jour max)
   - valider : le staff offre la récompense (code), carte repart à 1

   Variables d'environnement à définir sur Vercel :
   SUPABASE_URL     = https://xxxx.supabase.co
   SUPABASE_SECRET  = sb_secret_...   (jamais dans une page web !)
   ============================================================ */

const { randomUUID } = require("crypto");
let envoyerPush = null;
try { envoyerPush = require("./wallet").envoyerPush; } catch (e) { envoyerPush = null; }

/* on nettoie l'URL : slash final, /rest/v1 en trop, espaces… */
function nettoyerUrl(u) {
  return (u || "")
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/rest\/v1$/, "")
    .replace(/\/+$/, "");
}

const SUPABASE_URL = nettoyerUrl(process.env.SUPABASE_URL);
const SECRET = (process.env.SUPABASE_SECRET || "").trim();

const COOLDOWN_S = 15;
const TAPS_MAX_JOUR = 3;
const TAMPON_DEPART = 1;

/* ---------- petit client Supabase (API REST, zéro dépendance) ---------- */
async function sb(chemin, options) {
  options = options || {};
  const headers = {
    apikey: SECRET,
    Authorization: "Bearer " + SECRET,
    "Content-Type": "application/json",
  };
  if (options.method === "POST" || options.method === "PATCH") {
    headers["Prefer"] = "return=representation";
  }
  const r = await fetch(SUPABASE_URL + "/rest/v1/" + chemin, {
    method: options.method || "GET",
    headers: headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!r.ok) {
    throw new Error("Supabase " + r.status + " : " + (await r.text()));
  }
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

/* ---------- helpers ---------- */
function aujourdhui() {
  return new Date().toISOString().slice(0, 10);
}

function tapsDuJour(carte) {
  return carte.jour_reference === aujourdhui() ? carte.taps_aujourdhui : 0;
}

function etat(carte, commerce, extra) {
  const dernier = carte.dernier_tap ? new Date(carte.dernier_tap).getTime() : 0;
  const cooldown = Math.max(
    0,
    COOLDOWN_S - Math.floor((Date.now() - dernier) / 1000)
  );
  const base = {
    ok: true,
    prenom: carte.prenom || null,
    tampons: carte.tampons,
    objectif: commerce.objectif,
    unite: commerce.unite,
    recompense: commerce.recompense,
    commerce: commerce.nom,
    pleine: carte.tampons >= commerce.objectif,
    cooldown: cooldown,
    taps_aujourdhui: tapsDuJour(carte),
    taps_max: TAPS_MAX_JOUR,
  };
  return Object.assign(base, extra || {});
}

async function commerceParSlug(slug) {
  const rows = await sb(
    "commerces?slug=eq." + encodeURIComponent(slug) + "&select=*"
  );
  return rows && rows[0] ? rows[0] : null;
}

async function carteParJeton(jeton) {
  const rows = await sb(
    "cartes?jeton=eq." + encodeURIComponent(jeton) + "&select=*"
  );
  return rows && rows[0] ? rows[0] : null;
}

/* ---------- handler ---------- */
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(200).json({ ok: true, info: "API Cancri en ligne ✦" });
  }

  try {
    let body = req.body;
    if (typeof body === "string") body = JSON.parse(body || "{}");
    body = body || {};
    const action = body.action;

    /* ----- CREER : nouvelle carte, tampon de bienvenue ----- */
    if (action === "creer") {
      const commerce = await commerceParSlug(body.commerce || "");
      if (!commerce) {
        return res.status(200).json({ ok: false, raison: "commerce_inconnu" });
      }
      const prenom = (body.prenom || "").toString().trim().slice(0, 20) || null;
      const brut = (body.email || "").toString().trim().slice(0, 80);
      const email = brut && brut.indexOf("@") > 0 ? brut : null;
      const consentement = body.consentement === true && !!email;
      const jeton = randomUUID();
      const inseres = await sb("cartes", {
        method: "POST",
        body: {
          commerce_id: commerce.id,
          prenom: prenom,
          email: email,
          consentement: consentement,
          tampons: TAMPON_DEPART,
          jeton: jeton,
          dernier_tap: new Date().toISOString(),
          taps_aujourdhui: 0,
          jour_reference: aujourdhui(),
        },
      });
      const carte = inseres[0];
      await sb("taps", {
        method: "POST",
        body: { carte_id: carte.id, valeur: TAMPON_DEPART },
      });
      return res
        .status(200)
        .json(etat(carte, commerce, { jeton: jeton, bienvenue: true }));
    }

    /* ----- toutes les autres actions demandent un jeton ----- */
    const carte = await carteParJeton(body.jeton || "");
    if (!carte) {
      return res.status(200).json({ ok: false, raison: "carte_inconnue" });
    }
    const rows = await sb("commerces?id=eq." + carte.commerce_id + "&select=*");
    const commerce = rows[0];

    /* ----- ETAT ----- */
    if (action === "etat") {
      return res.status(200).json(etat(carte, commerce));
    }

    /* ----- TAP : +1 tampon ----- */
    if (action === "tap") {
      if (carte.tampons >= commerce.objectif) {
        return res
          .status(200)
          .json(etat(carte, commerce, { ok: false, raison: "pleine" }));
      }
      const dernier = carte.dernier_tap
        ? new Date(carte.dernier_tap).getTime()
        : 0;
      const ecart = Math.floor((Date.now() - dernier) / 1000);
      if (dernier && ecart < COOLDOWN_S) {
        return res.status(200).json(
          etat(carte, commerce, {
            ok: false,
            raison: "cooldown",
            secondes: COOLDOWN_S - ecart,
          })
        );
      }
      if (tapsDuJour(carte) >= TAPS_MAX_JOUR) {
        return res
          .status(200)
          .json(etat(carte, commerce, { ok: false, raison: "limite" }));
      }

      const maj = await sb("cartes?id=eq." + carte.id, {
        method: "PATCH",
        body: {
          tampons: Math.min(carte.tampons + 1, commerce.objectif),
          dernier_tap: new Date().toISOString(),
          taps_aujourdhui: tapsDuJour(carte) + 1,
          jour_reference: aujourdhui(),
        },
      });
      await sb("taps", {
        method: "POST",
        body: { carte_id: carte.id, valeur: 1 },
      });
      /* mise à jour du pass Wallet (silencieux, on n'attend pas) */
      if (envoyerPush) { try { await envoyerPush(carte.jeton); } catch (e) { console.error("push:", e.message); } }
      return res
        .status(200)
        .json(etat(maj[0], commerce, { gagne: 1 }));
    }

    /* ----- VALIDER : le staff offre la récompense ----- */
    if (action === "valider") {
      if ((body.code || "") !== commerce.code_staff) {
        return res
          .status(200)
          .json(etat(carte, commerce, { ok: false, raison: "code" }));
      }
      if (carte.tampons < commerce.objectif) {
        return res
          .status(200)
          .json(etat(carte, commerce, { ok: false, raison: "pas_pleine" }));
      }
      const maj = await sb("cartes?id=eq." + carte.id, {
        method: "PATCH",
        body: {
          tampons: TAMPON_DEPART,
          dernier_tap: new Date().toISOString(),
        },
      });
      if (envoyerPush) { try { await envoyerPush(carte.jeton); } catch (e) { console.error("push:", e.message); } }
      return res
        .status(200)
        .json(etat(maj[0], commerce, { offert: true }));
    }

    return res.status(200).json({ ok: false, raison: "action_inconnue" });
  } catch (e) {
    console.error(e);
    return res.status(200).json({ ok: false, raison: "erreur_serveur" });
  }
};
