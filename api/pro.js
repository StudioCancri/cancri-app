/* ============================================================
   API CANCRI — /api/pro
   Actions commerçant sécurisées (app pro.html).
   Chaque requête est authentifiée par le token de session
   Supabase de l'utilisateur, et on vérifie qu'il est bien
   membre du commerce concerné avant toute écriture.

   Actions : etat_carte, ajuster_tampons, valider_recompense
   Après écriture → push Wallet automatique.
   ============================================================ */

const http2 = require("http2");
const { capacites, abonnement } = require("./plans");

/* ============================================================
   SEGMENTS DE CLIENTS
   Un segment = une règle simple appliquée aux cartes d'un commerce.
   Ajouter un segment ici suffit : l'API et l'app le reprennent.
   ============================================================ */
const JOURS_ABSENCE = 21;
const JOURS_NOUVEAU = 30;

const SEGMENTS = {
  tous: {
    nom: "Tous mes clients",
    test: () => true,
  },
  proches: {
    nom: "Proches de la récompense",
    test: (c, obj) => c.tampons < obj && (obj - c.tampons) <= 2,
  },
  pleines: {
    nom: "Carte pleine à offrir",
    test: (c, obj) => c.tampons >= obj,
  },
  absents: {
    nom: "Pas revenus depuis " + JOURS_ABSENCE + " jours",
    test: (c) => c.dernier_tap && (Date.now() - new Date(c.dernier_tap).getTime()) > JOURS_ABSENCE * 24 * 3600 * 1000,
  },
  nouveaux: {
    nom: "Nouveaux ce mois-ci",
    test: (c) => c.cree_le && (Date.now() - new Date(c.cree_le).getTime()) < JOURS_NOUVEAU * 24 * 3600 * 1000,
  },
};

function filtrerSegment(cartes, code, objectif) {
  const seg = SEGMENTS[code] || SEGMENTS.tous;
  return (cartes || []).filter((c) => seg.test(c, objectif));
}


function nettoyerUrl(u) {
  return (u || "").trim().replace(/\/+$/, "").replace(/\/rest\/v1$/, "").replace(/\/+$/, "");
}
const SUPABASE_URL = nettoyerUrl(process.env.SUPABASE_URL);
const SECRET = (process.env.SUPABASE_SECRET || "").trim();

/* client Supabase avec la clé service (pour écrire), mais on
   valide TOUJOURS les droits de l'utilisateur avant. */
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

/* Vérifie le token de session et renvoie l'user_id, ou null */
async function userDepuisToken(token) {
  if (!token) return null;
  const r = await fetch(SUPABASE_URL + "/auth/v1/user", {
    headers: { apikey: SECRET, Authorization: "Bearer " + token },
  });
  if (!r.ok) return null;
  const u = await r.json();
  return u && u.id ? u.id : null;
}

/* Vérifie que l'user est membre du commerce de cette carte.
   Renvoie { carte, commerce } si OK, sinon null. */
async function verifierAcces(userId, carteId) {
  if (!carteId || carteId === "undefined") { console.log("[pro] acces refuse : carte_id absent"); return null; }
  const cartes = await sb("cartes?id=eq." + encodeURIComponent(carteId) + "&select=*");
  if (!cartes || !cartes[0]) { console.log("[pro] acces refuse : carte introuvable", carteId); return null; }
  const carte = cartes[0];
  const membre = await sb("membres?user_id=eq." + encodeURIComponent(userId) +
    "&commerce_id=eq." + carte.commerce_id + "&select=role");
  if (!membre || !membre.length) {
    console.log("[pro] acces refuse : user", userId, "n'est PAS membre du commerce", carte.commerce_id, "→ verifier la table membres");
    return null;
  }
  const commerces = await sb("commerces?id=eq." + carte.commerce_id + "&select=*");
  return { carte: carte, commerce: commerces[0], role: membre[0].role };
}

function certDepuisEnv(nom) {
  const b64 = (process.env[nom] || "").trim();
  if (!b64) return null;
  return Buffer.from(b64, "base64");
}

/* Envoi push Wallet (identique à carte.js) */
async function envoyerPush(jetonCarte) {
  try {
    const appareils = await sb("appareils?jeton=eq." + encodeURIComponent(jetonCarte) + "&select=push_token");
    if (!appareils || !appareils.length) {
      console.log("[push] aucun appareil enregistre pour ce jeton → la carte n'est pas (ou plus) dans un Wallet");
      return;
    }
    console.log("[push]", appareils.length, "appareil(s) pour ce jeton");
    const cert = certDepuisEnv("PASS_CERT");
    const key = certDepuisEnv("PASS_KEY");
    if (!cert || !key) return;
    const passphrase = process.env.PASS_KEY_PASSPHRASE || undefined;
    const topic = process.env.PASS_TYPE_ID;
    for (const a of appareils) {
      await new Promise((resolve) => {
        let client;
        try { client = http2.connect("https://api.push.apple.com:443", { cert, key, passphrase }); }
        catch (e) { return resolve(); }
        client.on("error", () => { try { client.close(); } catch (x) {} resolve(); });
        const req = client.request({
          ":method": "POST", ":path": "/3/device/" + a.push_token,
          "apns-topic": topic, "apns-push-type": "background", "apns-priority": "5",
        });
        req.on("response", (hd) => { console.log("[push] reponse Apple :", hd[":status"]); });
        req.on("end", () => { try { client.close(); } catch (x) {} resolve(); });
        req.on("error", () => { try { client.close(); } catch (x) {} resolve(); });
        req.write(JSON.stringify({})); req.end();
      });
    }
  } catch (e) { console.log("pro push:", e.message); }
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(200).json({ ok: true, info: "API pro" });

  try {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const userId = await userDepuisToken(token);
    if (!userId) return res.status(401).json({ ok: false, raison: "non_connecte" });

    let body = req.body;
    if (typeof body === "string") body = JSON.parse(body || "{}");
    body = body || {};
    const { action, carte_id } = body;
    console.log("[pro]", action, "| user:", userId, "| carte:", carte_id || "-");

    /* ---- ENVOYER UNE CAMPAGNE (notif à tous les clients) ---- */
    if (action === "envoyer_campagne") {
      // vérifier le membre + récupérer le commerce depuis le membre (pas via une carte)
      const membre2 = await sb("membres?user_id=eq." + encodeURIComponent(userId) + "&select=commerce_id,role");
      if (!membre2 || !membre2.length) return res.status(403).json({ ok: false, raison: "acces_refuse" });
      const commerceId = membre2[0].commerce_id;

      const message = (body.message || "").toString().trim().slice(0, 120);
      if (!message) return res.status(200).json({ ok: false, raison: "message_vide" });

      /* le forfait autorise-t-il les messages ? */
      const comC = await sb("commerces?id=eq." + commerceId + "&select=*");
      const capC = capacites(comC[0]);
      if (!capC.messages) return res.status(200).json({ ok: false, raison: "hors_forfait" });

      /* quota du jour, défini par le forfait */
      const maxJour = capC.messages_par_jour || 0;
      const ilya24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const recentes = await sb("campagnes?commerce_id=eq." + commerceId + "&cree_le=gte." + ilya24h + "&select=id");
      if (recentes && recentes.length >= maxJour) {
        return res.status(200).json({ ok: false, raison: "quota", restants: 0 });
      }

      /* quel segment vise-t-on ? */
      let segment = (body.segment || "tous").toString();
      if (!SEGMENTS[segment]) segment = "tous";
      if (segment !== "tous" && !capC.segments) {
        return res.status(200).json({ ok: false, raison: "ciblage_hors_forfait" });
      }

      /* 1. trace du dernier message envoyé (pour le cockpit) */
      await sb("commerces?id=eq." + commerceId, {
        method: "PATCH",
        body: { message_actuel: message, message_maj: new Date().toISOString() },
      });

      /* 2. les cartes concernées par le segment */
      const toutesCartes = await sb("cartes?commerce_id=eq." + commerceId +
        "&select=id,jeton,tampons,dernier_tap,cree_le");
      const ciblees = filtrerSegment(toutesCartes, segment, comC[0].objectif);
      const jetons = ciblees.map((c) => c.jeton);

      /* 3. le message est écrit SUR CHAQUE CARTE visée — c'est ce qui rend le ciblage possible */
      for (const c of ciblees) {
        await sb("cartes?id=eq." + c.id, { method: "PATCH", body: { message_perso: message } });
      }

      /* 4. on prévient les iPhones concernés */
      let envoyes = 0;
      for (const jt of jetons) {
        try { await envoyerPush(jt); envoyes++; } catch (e) {}
      }

      // 4. journaliser la campagne
      await sb("campagnes", {
        method: "POST",
        body: { commerce_id: commerceId, message: message, nb_clients: jetons.length, segment: segment },
      });

      const restants = Math.max(0, maxJour - ((recentes ? recentes.length : 0) + 1));
      return res.status(200).json({ ok: true, nb_clients: jetons.length, envoyes: envoyes, restants: restants });
    }

    /* ---- QUOTA RESTANT (pour afficher dans l'app) ---- */
    if (action === "quota_campagne") {
      const membre3 = await sb("membres?user_id=eq." + encodeURIComponent(userId) + "&select=commerce_id");
      if (!membre3 || !membre3.length) return res.status(403).json({ ok: false });
      const commerceId = membre3[0].commerce_id;
      const comQ = await sb("commerces?id=eq." + commerceId + "&select=*");
      const capQ = capacites(comQ[0]);
      const maxQ = capQ.messages_par_jour || 0;
      const ilya24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const recentes = await sb("campagnes?commerce_id=eq." + commerceId + "&cree_le=gte." + ilya24h + "&select=id");
      const utilisees = recentes ? recentes.length : 0;
      return res.status(200).json({ ok: true, actif: capQ.messages === true, restants: Math.max(0, maxQ - utilisees), total: maxQ });
    }



    /* ---- SEGMENTS : combien de clients dans chaque catégorie ---- */
    if (action === "segments") {
      const m = await sb("membres?user_id=eq." + encodeURIComponent(userId) + "&select=commerce_id");
      if (!m || !m.length) return res.status(403).json({ ok: false });
      const com = await sb("commerces?id=eq." + m[0].commerce_id + "&select=*");
      const cap = capacites(com[0]);
      const cartes = await sb("cartes?commerce_id=eq." + m[0].commerce_id + "&select=id,tampons,dernier_tap,cree_le");
      const obj = com[0].objectif;
      const liste = Object.keys(SEGMENTS).map((code) => ({
        code: code,
        nom: SEGMENTS[code].nom,
        nombre: filtrerSegment(cartes, code, obj).length,
      }));
      return res.status(200).json({ ok: true, cible_possible: cap.segments === true, segments: liste });
    }

    /* ---- MON FORFAIT : ce que le commerce a le droit de faire ---- */
    if (action === "mon_forfait") {
      const m = await sb("membres?user_id=eq." + encodeURIComponent(userId) + "&select=commerce_id,role");
      if (!m || !m.length) return res.status(403).json({ ok: false });
      const c = await sb("commerces?id=eq." + m[0].commerce_id + "&select=*");
      const cap = capacites(c[0]);
      return res.status(200).json({ ok: true, capacites: cap, abonnement: abonnement(c[0]), role: m[0].role });
    }

    /* ---- RÉGLAGES DE RELANCE ---- */
    if (action === "get_relances") {
      const m = await sb("membres?user_id=eq." + encodeURIComponent(userId) + "&select=commerce_id");
      if (!m || !m.length) return res.status(403).json({ ok: false });
      const c = await sb("commerces?id=eq." + m[0].commerce_id + "&select=message_relance,relances_actives");
      return res.status(200).json({ ok: true, message: c[0].message_relance || "", actives: c[0].relances_actives !== false });
    }
    if (action === "set_relances") {
      const m = await sb("membres?user_id=eq." + encodeURIComponent(userId) + "&select=commerce_id,role");
      if (!m || !m.length) return res.status(403).json({ ok: false });
      const comR = await sb("commerces?id=eq." + m[0].commerce_id + "&select=*");
      if (!capacites(comR[0]).relances) return res.status(200).json({ ok: false, raison: "hors_forfait" });
      const msg = (body.message || "").toString().trim().slice(0, 120);
      await sb("commerces?id=eq." + m[0].commerce_id, {
        method: "PATCH",
        body: { message_relance: msg, relances_actives: body.actives !== false },
      });
      return res.status(200).json({ ok: true });
    }

    /* ---- PROGRAMME DE FIDÉLITÉ (objectif + récompense) ---- */
    if (action === "get_programme") {
      const m = await sb("membres?user_id=eq." + encodeURIComponent(userId) + "&select=commerce_id,role");
      if (!m || !m.length) return res.status(403).json({ ok: false });
      const c = await sb("commerces?id=eq." + m[0].commerce_id + "&select=objectif,recompense,unite");
      return res.status(200).json({ ok: true, objectif: c[0].objectif, recompense: c[0].recompense, unite: c[0].unite, role: m[0].role });
    }

    if (action === "set_programme") {
      const m = await sb("membres?user_id=eq." + encodeURIComponent(userId) + "&select=commerce_id,role");
      if (!m || !m.length) return res.status(403).json({ ok: false });
      if (m[0].role !== "proprio") return res.status(200).json({ ok: false, raison: "reserve_proprio" });
      const commerceId = m[0].commerce_id;

      const objectif = Math.max(4, Math.min(12, parseInt(body.objectif, 10) || 10));
      const recompense = (body.recompense || "").toString().trim().slice(0, 60);
      if (!recompense) return res.status(200).json({ ok: false, raison: "recompense_vide" });

      await sb("commerces?id=eq." + commerceId, {
        method: "PATCH",
        body: { objectif: objectif, recompense: recompense },
      });

      /* les cartes déjà au-delà du nouvel objectif sont ramenées à l'objectif */
      const trop = await sb("cartes?commerce_id=eq." + commerceId + "&tampons=gt." + objectif + "&select=id");
      if (trop && trop.length) {
        for (const t of trop) {
          await sb("cartes?id=eq." + t.id, { method: "PATCH", body: { tampons: objectif } });
        }
      }

      /* on rafraîchit les pass Wallet, sans bloquer la réponse plus de 5 s */
      try {
        const cartesC = await sb("cartes?commerce_id=eq." + commerceId + "&select=jeton");
        const pushes = (cartesC || []).map((c) => envoyerPush(c.jeton).catch(() => {}));
        await Promise.race([
          Promise.allSettled(pushes),
          new Promise((r) => setTimeout(r, 5000)),
        ]);
      } catch (e) {
        console.log("set_programme push:", e.message);
      }

      return res.status(200).json({ ok: true, objectif: objectif, recompense: recompense, cartes_ajustees: trop ? trop.length : 0 });
    }


    const acces = await verifierAcces(userId, carte_id);
    if (!acces) return res.status(403).json({ ok: false, raison: "acces_refuse" });
    const { carte, commerce } = acces;

    /* ---- AJUSTER TAMPONS (valeur absolue, bornée) ---- */
    if (action === "ajuster_tampons") {
      let val = parseInt(body.tampons, 10);
      if (isNaN(val)) return res.status(200).json({ ok: false, raison: "valeur_invalide" });
      val = Math.max(0, Math.min(commerce.objectif, val));
      const maj = await sb("cartes?id=eq." + carte.id, {
        method: "PATCH",
        body: { tampons: val, dernier_tap: new Date().toISOString() },
      });
      await envoyerPush(carte.jeton);
      return res.status(200).json({ ok: true, tampons: maj[0].tampons });
    }

    /* ---- VALIDER RÉCOMPENSE (carte pleine → remise à 0) ---- */
    if (action === "valider_recompense") {
      if (carte.tampons < commerce.objectif) {
        return res.status(200).json({ ok: false, raison: "pas_pleine" });
      }
      const maj = await sb("cartes?id=eq." + carte.id, {
        method: "PATCH",
        body: { tampons: 0, dernier_tap: new Date().toISOString() },
      });
      await sb("taps", { method: "POST", body: { carte_id: carte.id, valeur: 0 } });
      await envoyerPush(carte.jeton);
      return res.status(200).json({ ok: true, tampons: 0, offert: true });
    }

    /* ---- HISTORIQUE / ÉTAT d'une carte ---- */
    if (action === "historique") {
      const taps = await sb("taps?carte_id=eq." + carte.id + "&select=valeur,cree_le&order=cree_le.desc&limit=20");
      return res.status(200).json({ ok: true, carte: carte, taps: taps || [] });
    }

    return res.status(200).json({ ok: false, raison: "action_inconnue" });
  } catch (e) {
    console.error("pro error:", e.message || e);
    return res.status(500).json({ ok: false, raison: "erreur_serveur" });
  }
};
