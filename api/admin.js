/* ============================================================
   API CANCRI — /api/admin
   Espace Studio (admin only). Chaque requête est authentifiée
   par le token de session, ET on vérifie que l'utilisateur
   est bien dans la table admins avant toute opération.

   Actions : vue_ensemble, detail_commerce, creer_commerce,
   maj_commerce, maj_statut, contrats (get/save),
   demandes (list/add/maj)
   ============================================================ */

function nettoyerUrl(u) {
  return (u || "").trim().replace(/\/+$/, "").replace(/\/rest\/v1$/, "").replace(/\/+$/, "");
}
const SUPABASE_URL = nettoyerUrl(process.env.SUPABASE_URL);
const SECRET = (process.env.SUPABASE_SECRET || "").trim();

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

async function userDepuisToken(token) {
  if (!token) return null;
  const r = await fetch(SUPABASE_URL + "/auth/v1/user", {
    headers: { apikey: SECRET, Authorization: "Bearer " + token },
  });
  if (!r.ok) return null;
  const u = await r.json();
  return u && u.id ? u.id : null;
}

async function estAdmin(userId) {
  const rows = await sb("admins?user_id=eq." + encodeURIComponent(userId) + "&select=user_id");
  return rows && rows.length > 0;
}

function slugify(txt) {
  return (txt || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "commerce";
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(200).json({ ok: true, info: "API admin" });

  try {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const userId = await userDepuisToken(token);
    if (!userId) return res.status(401).json({ ok: false, raison: "non_connecte" });
    if (!(await estAdmin(userId))) return res.status(403).json({ ok: false, raison: "pas_admin" });

    let body = req.body;
    if (typeof body === "string") body = JSON.parse(body || "{}");
    body = body || {};
    const action = body.action;

    /* ---- VUE D'ENSEMBLE : tous les commerces + activité ---- */
    if (action === "vue_ensemble") {
      const commerces = await sb("commerces?select=*&order=cree_le.desc");
      const maintenant = Date.now();
      const semaine = 7 * 24 * 3600 * 1000;
      const enriched = [];
      for (const c of (commerces || [])) {
        const cartes = await sb("cartes?commerce_id=eq." + c.id + "&select=id,dernier_tap,tampons");
        const liste = cartes || [];
        const actifs7j = liste.filter(x => x.dernier_tap && (maintenant - new Date(x.dernier_tap).getTime()) < semaine).length;
        const contrats = await sb("contrats?commerce_id=eq." + c.id + "&select=date_fin,statut&order=date_fin.desc&limit=1");
        const demandesOuvertes = await sb("demandes?commerce_id=eq." + c.id + "&statut=neq.fait&select=id");
        enriched.push({
          id: c.id, slug: c.slug, nom: c.nom, statut: c.statut,
          nb_cartes: liste.length, actifs_semaine: actifs7j,
          objectif: c.objectif, unite: c.unite, recompense: c.recompense,
          contrat: contrats && contrats[0] ? contrats[0] : null,
          demandes_ouvertes: demandesOuvertes ? demandesOuvertes.length : 0,
        });
      }
      // stats globales
      const totalCartes = enriched.reduce((s, c) => s + c.nb_cartes, 0);
      const totalActifs = enriched.filter(c => c.statut === 'actif').length;
      const mrr = enriched.filter(c => c.statut === 'actif').length * 39;
      return res.status(200).json({
        ok: true, commerces: enriched,
        stats: { total: enriched.length, actifs: totalActifs, cartes: totalCartes, mrr: mrr }
      });
    }

    /* ---- DÉTAIL D'UN COMMERCE ---- */
    if (action === "detail_commerce") {
      const c = await sb("commerces?id=eq." + encodeURIComponent(body.commerce_id) + "&select=*");
      if (!c || !c[0]) return res.status(200).json({ ok: false, raison: "introuvable" });
      const contrats = await sb("contrats?commerce_id=eq." + body.commerce_id + "&select=*&order=cree_le.desc");
      const demandes = await sb("demandes?commerce_id=eq." + body.commerce_id + "&select=*&order=cree_le.desc");
      const cartes = await sb("cartes?commerce_id=eq." + body.commerce_id + "&select=id,prenom,tampons,dernier_tap&order=dernier_tap.desc&limit=50");
      const membres = await sb("membres?commerce_id=eq." + body.commerce_id + "&select=user_id,role");
      return res.status(200).json({ ok: true, commerce: c[0], contrats: contrats || [], demandes: demandes || [], cartes: cartes || [], membres: membres || [] });
    }

    /* ---- CRÉER UN COMMERCE (prospect) ---- */
    if (action === "creer_commerce") {
      const nom = (body.nom || "").toString().trim();
      if (!nom) return res.status(200).json({ ok: false, raison: "nom_requis" });
      let slug = slugify(body.slug || nom);
      // unicité du slug
      const existe = await sb("commerces?slug=eq." + encodeURIComponent(slug) + "&select=id");
      if (existe && existe.length) slug = slug + "-" + Date.now().toString().slice(-4);
      const ins = await sb("commerces", {
        method: "POST",
        body: {
          slug: slug, nom: nom,
          statut: body.statut || 'prospect',
          unite: body.unite || 'TAMPONS',
          objectif: body.objectif || 10,
          recompense: body.recompense || 'Récompense offerte',
          code_staff: body.code_staff || '1234',
          contact_nom: body.contact_nom || '',
          contact_email: body.contact_email || '',
          contact_tel: body.contact_tel || '',
          adresse: body.adresse || '',
          notes_admin: body.notes_admin || '',
        },
      });
      return res.status(200).json({ ok: true, commerce: ins[0] });
    }

    /* ---- MAJ INFOS COMMERCE ---- */
    if (action === "maj_commerce") {
      const champs = {};
      const permis = ["nom","unite","objectif","recompense","code_staff","couleur_fond","couleur_texte","couleur_label",
                      "statut","notes_admin","contact_nom","contact_email","contact_tel","adresse",
                      "latitude","longitude","texte_geoloc","message_relance","relances_actives"];
      for (const k of permis) if (body[k] !== undefined) champs[k] = body[k];
      if (!Object.keys(champs).length) return res.status(200).json({ ok: false, raison: "rien_a_maj" });
      const maj = await sb("commerces?id=eq." + encodeURIComponent(body.commerce_id), { method: "PATCH", body: champs });
      return res.status(200).json({ ok: true, commerce: maj[0] });
    }

    /* ---- CONTRAT : créer / mettre à jour ---- */
    if (action === "save_contrat") {
      const data = {
        commerce_id: body.commerce_id,
        date_signature: body.date_signature || null,
        date_debut: body.date_debut || null,
        date_fin: body.date_fin || null,
        montant_mensuel: body.montant_mensuel != null ? body.montant_mensuel : 39,
        statut: body.statut || 'actif',
        renouvellement_auto: body.renouvellement_auto !== false,
        conditions: body.conditions || '',
      };
      if (body.contrat_id) {
        const maj = await sb("contrats?id=eq." + encodeURIComponent(body.contrat_id), { method: "PATCH", body: data });
        return res.status(200).json({ ok: true, contrat: maj[0] });
      }
      const ins = await sb("contrats", { method: "POST", body: data });
      return res.status(200).json({ ok: true, contrat: ins[0] });
    }

    /* ---- DEMANDES : ajouter / changer statut ---- */
    if (action === "add_demande") {
      const texte = (body.texte || "").toString().trim();
      if (!texte) return res.status(200).json({ ok: false, raison: "texte_requis" });
      const ins = await sb("demandes", { method: "POST", body: { commerce_id: body.commerce_id, texte: texte, statut: 'a_faire' } });
      return res.status(200).json({ ok: true, demande: ins[0] });
    }
    if (action === "maj_demande") {
      const maj = await sb("demandes?id=eq." + encodeURIComponent(body.demande_id), { method: "PATCH", body: { statut: body.statut } });
      return res.status(200).json({ ok: true, demande: maj[0] });
    }

    return res.status(200).json({ ok: false, raison: "action_inconnue" });
  } catch (e) {
    console.error("admin error:", e.message || e);
    return res.status(500).json({ ok: false, raison: "erreur_serveur", message: e.message });
  }
};
