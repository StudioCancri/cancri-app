/* ============================================================
   API CANCRI — /api/prospection
   Outil de démarchage (CRM terrain) — réservé aux admins Studio.
   Chaque requête est authentifiée par le token de session
   Supabase et on vérifie que l'utilisateur est dans la table
   admins avant toute opération.

   Actions :
     - liste            : tous les prospects (triés : rappels dus en premier)
     - creer            : ajoute un prospect
     - modifier         : met à jour un prospect (statut, notes, rappel...)
     - supprimer        : retire un prospect
   Table Supabase : prospects
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

/* statuts autorisés */
const STATUTS = ["a_demarcher", "demarche", "interesse", "client", "pas_interesse"];

function nettoie(v) {
  return (typeof v === "string") ? v.trim() : v;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    if (req.method !== "POST") return res.status(405).json({ ok: false, erreur: "methode" });

    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const userId = await userDepuisToken(token);
    if (!userId) return res.status(401).json({ ok: false, erreur: "non_connecte" });
    if (!(await estAdmin(userId))) return res.status(403).json({ ok: false, erreur: "non_admin" });

    const body = req.body || {};
    const action = body.action;

    /* ---------- LISTE ---------- */
    if (action === "liste") {
      const rows = await sb("prospects?select=*&order=created_at.desc");
      return res.status(200).json({ ok: true, prospects: rows || [] });
    }

    /* ---------- CRÉER ---------- */
    if (action === "creer") {
      const nom = nettoie(body.nom);
      if (!nom) return res.status(400).json({ ok: false, erreur: "nom_requis" });
      const p = {
        nom: nom,
        adresse: nettoie(body.adresse) || null,
        contact: nettoie(body.contact) || null,
        telephone: nettoie(body.telephone) || null,
        statut: STATUTS.includes(body.statut) ? body.statut : "a_demarcher",
        notes: nettoie(body.notes) || null,
        rappel_le: body.rappel_le || null,
        cree_par: userId,
      };
      const rows = await sb("prospects", { method: "POST", body: p });
      return res.status(200).json({ ok: true, prospect: rows && rows[0] });
    }

    /* ---------- MODIFIER ---------- */
    if (action === "modifier") {
      const id = body.id;
      if (!id) return res.status(400).json({ ok: false, erreur: "id_requis" });
      const patch = {};
      if (body.nom !== undefined) patch.nom = nettoie(body.nom);
      if (body.adresse !== undefined) patch.adresse = nettoie(body.adresse) || null;
      if (body.contact !== undefined) patch.contact = nettoie(body.contact) || null;
      if (body.telephone !== undefined) patch.telephone = nettoie(body.telephone) || null;
      if (body.statut !== undefined && STATUTS.includes(body.statut)) patch.statut = body.statut;
      if (body.notes !== undefined) patch.notes = nettoie(body.notes) || null;
      if (body.rappel_le !== undefined) patch.rappel_le = body.rappel_le || null;
      const rows = await sb("prospects?id=eq." + encodeURIComponent(id), { method: "PATCH", body: patch });
      return res.status(200).json({ ok: true, prospect: rows && rows[0] });
    }

    /* ---------- SUPPRIMER ---------- */
    if (action === "supprimer") {
      const id = body.id;
      if (!id) return res.status(400).json({ ok: false, erreur: "id_requis" });
      await sb("prospects?id=eq." + encodeURIComponent(id), { method: "DELETE" });
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ ok: false, erreur: "action_inconnue" });
  } catch (e) {
    return res.status(500).json({ ok: false, erreur: String(e && e.message || e) });
  }
};
